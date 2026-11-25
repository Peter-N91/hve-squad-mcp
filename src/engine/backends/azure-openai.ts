/**
 * Azure OpenAI `ModelBackend` (the single Phase 1 backend).
 *
 * Calls either the Azure OpenAI Responses API (recommended for current reasoning
 * models) or the legacy Chat Completions REST API with `fetch` and a bearer token
 * from an INJECTED token provider — so the backend has no Azure SDK dependency
 * and is unit-testable with a stub `fetch`. Security posture:
 *
 *   * SEC-3 — the endpoint and deployment come from operator config (validated
 *     against an allow-list in `operator-config.ts`); they are NEVER taken from a
 *     caller input, so a caller cannot redirect inference elsewhere.
 *   * SEC-10 — the access token (and an API key, if that token provider is used)
 *     is registered with the logger for redaction and never logged. Error paths
 *     do not include the response body, which could echo a prompt or secret.
 *
 * The managed-identity token provider lives in a separate module so `@azure/identity`
 * loads only in the live process (`managed-identity-credential.ts`).
 */
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { fetchModel } from "./model-transport.js";
import { providerErrorEnvelopes, safeProviderValidation } from "./provider-validation.js";
import {
  aggregateBackendUsage,
  assertBackendPreflight,
  ModelBackendError,
  type BackendCompletionEvent,
  type BackendCompletionObserver,
  type BackendMessage,
  type BackendRequest,
  type BackendResult,
  type BackendToolCall,
  type BackendUsage,
  type ModelBackendFailureKind,
  type ModelBackend,
} from "../model-backend.js";
import type { RedactingLogger } from "../../observability/logger.js";
import { contentPolicyDetails } from "../responsible-ai.js";

/** Per-million-token pricing used for the best-effort cost estimate (COST-2). */
export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Optional cached-input meter. Required for a complete estimate when cache reads occur. */
  cachedInputPerMTokUsd?: number;
  /** Optional provider cache-write meter. Required when cache-write tokens are reported. */
  cacheWritePerMTokUsd?: number;
}

function configuredRate(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(`${name} must be a non-negative USD-per-million-token rate.`);
  }
  return rate;
}

/** Parse one deployment's operator-supplied USD meter rates without defaults. */
export function modelPricingFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): ModelPricing | undefined {
  const inputPerMTokUsd = configuredRate(
    "SQUAD_MCP_PRICE_INPUT_PER_MTOK",
    env.SQUAD_MCP_PRICE_INPUT_PER_MTOK,
  );
  const outputPerMTokUsd = configuredRate(
    "SQUAD_MCP_PRICE_OUTPUT_PER_MTOK",
    env.SQUAD_MCP_PRICE_OUTPUT_PER_MTOK,
  );
  if (inputPerMTokUsd === undefined && outputPerMTokUsd === undefined) {
    return undefined;
  }
  if (inputPerMTokUsd === undefined || outputPerMTokUsd === undefined) {
    throw new Error("Both SQUAD_MCP_PRICE_INPUT_PER_MTOK and SQUAD_MCP_PRICE_OUTPUT_PER_MTOK are required when pricing is configured.");
  }
  const cachedInputPerMTokUsd = configuredRate(
    "SQUAD_MCP_PRICE_CACHED_INPUT_PER_MTOK",
    env.SQUAD_MCP_PRICE_CACHED_INPUT_PER_MTOK,
  );
  const cacheWritePerMTokUsd = configuredRate(
    "SQUAD_MCP_PRICE_CACHE_WRITE_PER_MTOK",
    env.SQUAD_MCP_PRICE_CACHE_WRITE_PER_MTOK,
  );
  return {
    inputPerMTokUsd,
    outputPerMTokUsd,
    ...(cachedInputPerMTokUsd !== undefined ? { cachedInputPerMTokUsd } : {}),
    ...(cacheWritePerMTokUsd !== undefined ? { cacheWritePerMTokUsd } : {}),
  };
}

export type AzureOpenAIApi = "chat-completions" | "responses";
export type AzureOpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type AzureOpenAIVerbosity = "low" | "medium" | "high";
export type AzureOpenAIChatProfile = "standard" | "reasoning" | "reasoning-no-effort" | "gpt-5.6";

export interface AzureOpenAIBackendOptions {
  /** AOAI resource endpoint, e.g. `https://my-aoai.openai.azure.com` (operator config). */
  endpoint: string;
  /** Deployment name (operator config). */
  deployment: string;
  /** API surface. Defaults to the legacy Chat Completions route. */
  api?: AzureOpenAIApi;
  /** REST API version used by the legacy Chat Completions route. */
  apiVersion: string;
  /** Default output token ceiling when a request does not override it. */
  defaultMaxOutputTokens?: number;
  /** Operator-verified Chat capabilities, independent of the deployment alias. */
  chatProfile?: AzureOpenAIChatProfile;
  /** Reasoning effort for Responses or a compatible Chat profile. Omit for the model's default. */
  reasoningEffort?: AzureOpenAIReasoningEffort;
  /** Responses API visible-output verbosity. Omit for the model's default. */
  verbosity?: AzureOpenAIVerbosity;
  /** Returns a fresh bearer token (managed identity or Key Vault key). */
  getAccessToken: () => Promise<string>;
  /** Injectable fetch (default: inference-scoped transport with caller cancellation). */
  fetchImpl?: typeof fetch;
  /** Logger to register the token as a secret (SEC-10). */
  logger?: RedactingLogger;
  /** Optional pricing for the cost estimate. */
  pricing?: ModelPricing;
  /** Maximum transient retries after the first attempt (default 5). */
  maxRetries?: number;
  /** Base fallback delay when Azure supplies no retry header (default 1000ms). */
  retryBaseMs?: number;
  /** Maximum wait applied to any one retry (default 60000ms). */
  retryMaxDelayMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: unknown };
    finish_reason?: string;
    content_filter_results?: unknown;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
}

interface ResponsesApiResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  error?: unknown;
  content_filter_results?: unknown;
  output?: (Record<string, unknown> & {
    type?: string;
    content?: { type?: string; text?: string }[];
  })[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

function finiteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usageForCompletion(
  inputTokensValue: unknown,
  outputTokensValue: unknown,
  reasoningTokensValue: unknown,
  cacheReadTokensValue: unknown,
  cacheWriteTokensValue: unknown,
  pricing: ModelPricing | undefined,
): BackendUsage {
  const inputTokens = finiteTokenCount(inputTokensValue);
  const outputTokens = finiteTokenCount(outputTokensValue);
  const reasoningTokens = finiteTokenCount(reasoningTokensValue);
  const cacheReadTokens = finiteTokenCount(cacheReadTokensValue);
  const cacheWriteTokens = finiteTokenCount(cacheWriteTokensValue);
  let estimatedCostUsd: number | undefined;
  let costStatus: BackendUsage["costStatus"] = "unavailable";

  if (pricing) {
    let knownCost = 0;
    let missingComponent = false;
    let hasKnownComponent = false;
    if (inputTokens === undefined) {
      missingComponent = true;
    } else {
      const cached = Math.min(inputTokens, cacheReadTokens ?? 0);
      knownCost += ((inputTokens - cached) / 1_000_000) * pricing.inputPerMTokUsd;
      hasKnownComponent = true;
      if (cached > 0) {
        if (pricing.cachedInputPerMTokUsd === undefined) {
          missingComponent = true;
        } else {
          knownCost += (cached / 1_000_000) * pricing.cachedInputPerMTokUsd;
        }
      }
    }
    if (outputTokens === undefined) {
      missingComponent = true;
    } else {
      knownCost += (outputTokens / 1_000_000) * pricing.outputPerMTokUsd;
      hasKnownComponent = true;
    }
    if ((cacheWriteTokens ?? 0) > 0) {
      if (pricing.cacheWritePerMTokUsd === undefined) {
        missingComponent = true;
      } else {
        knownCost += ((cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePerMTokUsd;
        hasKnownComponent = true;
      }
    }
    if (hasKnownComponent) {
      estimatedCostUsd = knownCost;
      costStatus = missingComponent ? "incomplete" : "complete";
    }
  }

  return {
    completionCount: 1,
    attemptCount: 1,
    ...(inputTokens !== undefined ? { inputTokens } : { unreportedInputCompletions: 1 }),
    ...(outputTokens !== undefined ? { outputTokens } : { unreportedOutputCompletions: 1 }),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    pricedCompletionCount: costStatus === "complete" ? 1 : 0,
    incompletelyPricedCompletionCount: costStatus === "incomplete" ? 1 : 0,
    unpricedCompletionCount: costStatus === "unavailable" ? 1 : 0,
    costStatus,
    ...(estimatedCostUsd !== undefined
      ? {
          estimatedCostUsd,
          costCurrency: "USD" as const,
          costBasis: "configured_estimate" as const,
        }
      : {}),
  };
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SAFE_ERROR_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,80}$/;
const TRANSPORT_ERROR_CODES = new Set([
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function withAbort<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return operation();
  }
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function malformedToolCall(): never {
  throw new ModelBackendError("upstream", { providerCode: "malformed_tool_call" });
}

function parseToolCall(
  id: unknown,
  name: unknown,
  args: unknown,
): BackendToolCall {
  if (
    typeof id !== "string" || !id.trim() ||
    typeof name !== "string" || !name.trim() ||
    typeof args !== "string"
  ) {
    return malformedToolCall();
  }
  try {
    if (!asRecord(JSON.parse(args))) {
      return malformedToolCall();
    }
  } catch {
    return malformedToolCall();
  }
  return { id, name, arguments: args };
}

function uniqueToolCalls(calls: BackendToolCall[]): BackendToolCall[] | undefined {
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    return malformedToolCall();
  }
  return calls.length ? calls : undefined;
}

function responsesInput(message: BackendMessage): Record<string, unknown>[] {
  if (message.role === "tool") {
    if (!message.toolCallId?.trim()) {
      throw new ModelBackendError("invalid_request", {
        providerCode: "missing_tool_call_id",
        providerAttempted: false,
      });
    }
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content,
    }];
  }
  if (message.role === "assistant" && message.responseItems?.length) {
    // Reasoning and function-call output items must retain their original order.
    return message.responseItems;
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return [
      ...(message.content ? [{ role: message.role, content: message.content }] : []),
      ...message.toolCalls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    ];
  }
  return [{ role: message.role, content: message.content }];
}

function chatMessage(message: BackendMessage): Record<string, unknown> {
  if (message.role === "tool" && !message.toolCallId?.trim()) {
    throw new ModelBackendError("invalid_request", {
      providerCode: "missing_tool_call_id",
      providerAttempted: false,
    });
  }
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "tool" ? { tool_call_id: message.toolCallId } : {}),
    ...(message.role === "assistant" && message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

function safeErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ERROR_IDENTIFIER.test(value)
    ? value
    : undefined;
}

function failureKind(
  status: number,
  providerCodes: readonly string[],
): ModelBackendFailureKind {
  const codes = providerCodes.map((code) => code.toLowerCase());
  if (
    codes.some(
      (code) =>
        code.includes("context_length") ||
        code.includes("too_many_tokens") ||
        code.includes("token_limit") ||
        code.includes("string_above_max_length"),
    )
  ) {
    return "input_too_large";
  }
  if (
    codes.some(
      (code) =>
        code.includes("content_filter") ||
        code === "contentfiltered" ||
        code.includes("content_policy") ||
        code.includes("responsibleaipolicyviolation"),
    )
  ) {
    return "content_policy";
  }
  return status >= 400 && status < 500 ? "invalid_request" : "upstream";
}

function usageFromPayload(
  payload: unknown,
  api: AzureOpenAIApi,
  pricing: ModelPricing | undefined,
): BackendUsage | undefined {
  const usage = asRecord(asRecord(payload)?.usage);
  if (!usage) {
    return undefined;
  }
  if (api === "responses") {
    const inputDetails = asRecord(usage.input_tokens_details);
    const outputDetails = asRecord(usage.output_tokens_details);
    return usageForCompletion(
      usage.input_tokens,
      usage.output_tokens,
      outputDetails?.reasoning_tokens,
      inputDetails?.cached_tokens,
      inputDetails?.cache_write_tokens,
      pricing,
    );
  }
  const promptDetails = asRecord(usage.prompt_tokens_details);
  return usageForCompletion(
    usage.prompt_tokens,
    usage.completion_tokens,
    undefined,
    promptDetails?.cached_tokens,
    promptDetails?.cache_write_tokens,
    pricing,
  );
}

async function responseError(
  response: Response,
  api: AzureOpenAIApi,
  pricing: ModelPricing | undefined,
  deployment: string,
  captureValidation?: (payload: unknown) => void,
): Promise<ModelBackendError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  captureValidation?.(payload);
  return providerFailure(response, payload, api, pricing, deployment);
}

function providerFailure(
  response: Response,
  payload: unknown,
  api: AzureOpenAIApi,
  pricing: ModelPricing | undefined,
  deployment: string,
): ModelBackendError {
  const errors = providerErrorEnvelopes(payload).map(envelope => envelope.error);
  const codes = errors.map(error => safeErrorIdentifier(error.code))
    .filter((code): code is string => code !== undefined);
  const providerCode = codes.at(-1);
  const kind = failureKind(response.status, codes);
  const filterError = [...errors].reverse().find(error =>
    asRecord(error.content_filter_result ?? error.content_filter_results));
  const filters = filterError?.content_filter_result ?? filterError?.content_filter_results;
  const record = asRecord(payload);
  return new ModelBackendError(kind, {
    status: response.status,
    providerCode,
    providerRequestId: policyRequestId(response) ?? undefined,
    usage: usageFromPayload(payload, api, pricing),
    model: safeErrorIdentifier(record?.model),
    deployment,
    providerResponseId: safeErrorIdentifier(record?.id),
    ...(kind === "content_policy" ? {
      contentPolicy: contentPolicyDetails(
        filters,
        response.status === 400 && asRecord(filters) ? "prompt" : "unknown",
        policyRequestId(response),
      ),
    } : {}),
  });
}

function policyRequestId(response: Response): string | null {
  return response.headers.get("apim-request-id") ??
    response.headers.get("x-request-id") ?? response.headers.get("x-ms-request-id");
}

function completionEvent(
  attempt: number,
  outcome: BackendCompletionEvent["outcome"],
  deployment: string,
  options: {
    finishReason?: string;
    model?: string;
    providerResponseId?: string;
    toolCallCount?: number;
    usage?: BackendUsage;
  } = {},
): BackendCompletionEvent {
  return {
    eventId: randomUUID(),
    attempt,
    outcome,
    finishReason: options.finishReason,
    backendId: "azure-openai",
    model: options.model,
    deployment,
    providerResponseId: options.providerResponseId,
    toolCallCount: options.toolCallCount,
    usage: options.usage,
  };
}

function errorWithAggregateUsage(
  error: ModelBackendError,
  usages: readonly (BackendUsage | undefined)[],
  attemptCount: number,
): ModelBackendError {
  return new ModelBackendError(error.kind, {
    status: error.status,
    providerCode: error.providerCode,
    providerRequestId: error.providerRequestId,
    contentPolicy: error.contentPolicy,
    usage: aggregateAttemptUsage(usages, attemptCount),
    model: error.model,
    deployment: error.deployment,
    providerResponseId: error.providerResponseId,
    providerAttempted: error.providerAttempted,
  });
}

function aggregateAttemptUsage(
  usages: readonly (BackendUsage | undefined)[],
  attemptCount: number,
): BackendUsage {
  return {
    ...(aggregateBackendUsage(usages) ?? {
      completionCount: 0,
      pricedCompletionCount: 0,
      incompletelyPricedCompletionCount: 0,
      unpricedCompletionCount: 0,
      costStatus: "unavailable" as const,
    }),
    attemptCount,
  };
}

function retryDelayMs(
  response: Response,
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const millisecondHeader =
    response.headers.get("x-ms-retry-after-ms") ?? response.headers.get("retry-after-ms");
  if (millisecondHeader) {
    const milliseconds = Number(millisecondHeader);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return Math.min(maxMs, milliseconds);
    }
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxMs, seconds * 1000);
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.min(maxMs, Math.max(0, retryAt - Date.now()));
    }
  }
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

export class AzureOpenAIBackend implements ModelBackend {
  readonly id = "azure-openai";
  readonly supportsTools = true;
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly api: AzureOpenAIApi;
  private readonly apiVersion: string;
  private readonly defaultMaxOutputTokens: number;
  private readonly chatProfile: AzureOpenAIChatProfile;
  private readonly reasoningEffort?: AzureOpenAIReasoningEffort;
  private readonly verbosity?: AzureOpenAIVerbosity;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetchModel;
  private readonly logger?: RedactingLogger;
  private readonly pricing?: ModelPricing;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: AzureOpenAIBackendOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.deployment = options.deployment;
    this.api = options.api ?? "chat-completions";
    this.apiVersion = options.apiVersion;
    this.defaultMaxOutputTokens = Math.max(
      1,
      Math.floor(
        options.defaultMaxOutputTokens ??
          (this.api === "responses" ? 32_768 : 1_500),
      ),
    );
    this.reasoningEffort = options.reasoningEffort;
    this.chatProfile = options.chatProfile ?? "standard";
    this.verbosity = options.verbosity;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetchModel;
    this.logger = options.logger;
    this.pricing = options.pricing;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 5));
    this.retryBaseMs = Math.max(1, Math.floor(options.retryBaseMs ?? 1000));
    this.retryMaxDelayMs = Math.max(
      this.retryBaseMs,
      Math.floor(options.retryMaxDelayMs ?? 60_000),
    );
    this.sleep =
      options.sleep ??
      ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  }

  complete(request: BackendRequest): Promise<BackendResult> {
    return this.runCompletion(request);
  }

  completeObserved(
    request: BackendRequest,
    observer: BackendCompletionObserver,
  ): Promise<BackendResult> {
    return this.runCompletion(request, observer);
  }

  private async runCompletion(
    request: BackendRequest,
    observer?: BackendCompletionObserver,
  ): Promise<BackendResult> {
    request.signal?.throwIfAborted();
    assertBackendPreflight(request);
    if (request.toolChoice === "required" && !request.tools?.length) {
      throw new ModelBackendError("invalid_request", {
        providerCode: "required_tools_missing",
        providerAttempted: false,
      });
    }
    const maxOutputTokens =
      request.maxOutputTokens ?? this.defaultMaxOutputTokens;
    const toolsEnabled = Boolean(
      request.tools?.length ||
      request.messages.some((message) =>
        message.role === "tool" || message.toolCalls?.length || message.responseItems?.length),
    );
    if (this.api === "chat-completions") {
      if (this.reasoningEffort !== undefined &&
        (this.chatProfile === "standard" || this.chatProfile === "reasoning-no-effort" ||
          this.reasoningEffort === "max" ||
          (this.chatProfile === "gpt-5.6" && this.reasoningEffort === "minimal"))) {
        throw new ModelBackendError("invalid_request", {
          providerCode: "unsupported_chat_reasoning_configuration",
          providerAttempted: false,
        });
      }
      if (this.chatProfile === "gpt-5.6" && toolsEnabled && this.reasoningEffort !== "none") {
        throw new ModelBackendError("invalid_request", {
          providerCode: "chat_reasoning_tools_requires_responses",
          providerAttempted: false,
        });
      }
    }
    const token = await withAbort(() => this.getAccessToken(), request.signal);
    this.logger?.registerSecret(token);
    const url =
      this.api === "responses"
        ? `${this.endpoint}/openai/v1/responses`
        : `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}` +
          `/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    const body =
      this.api === "responses"
        ? {
            model: this.deployment,
            instructions: request.system,
            input: request.messages.flatMap(responsesInput),
            ...(toolsEnabled
              ? { store: false, include: ["reasoning.encrypted_content"] }
              : {}),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                    strict: false,
                  })),
                  ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
                }
              : {}),
            max_output_tokens: maxOutputTokens,
            ...(this.reasoningEffort
              ? { reasoning: { effort: this.reasoningEffort } }
              : {}),
            ...(this.verbosity ? { text: { verbosity: this.verbosity } } : {}),
          }
        : {
            messages: [
              { role: "system", content: request.system },
              ...request.messages.map(chatMessage),
            ],
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                      strict: false,
                    },
                  })),
                  ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
                }
              : {}),
            ...(this.chatProfile === "standard"
              ? { temperature: request.temperature ?? 0.2, max_tokens: maxOutputTokens }
              : {
                  max_completion_tokens: maxOutputTokens,
                  ...(this.reasoningEffort !== undefined ? { reasoning_effort: this.reasoningEffort } : {}),
                }),
          };

    let response: Response | undefined;
    let responseAttempt = 1;
    const attemptUsages: (BackendUsage | undefined)[] = [];
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      request.signal?.throwIfAborted();
      responseAttempt = attempt + 1;
      try {
        response = await this.transport(() => this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        }), request.signal);
      } catch (error) {
        if (observer) {
          await observer(completionEvent(responseAttempt, "ambiguous", this.deployment));
        }
        throw error;
      }
      if (response.ok) {
        break;
      }
      let providerValidation = safeProviderValidation(undefined);
      const error = await responseError(response, this.api, this.pricing, this.deployment,
        payload => { providerValidation = safeProviderValidation(payload, request.tools, {
          secrets: [token], requestText: JSON.stringify(body),
        }); });
      attemptUsages.push(error.usage);
      if (observer) {
        await observer(completionEvent(responseAttempt, "failed", this.deployment, {
          finishReason: error.providerCode,
          model: error.model,
          providerResponseId: error.providerResponseId,
          usage: error.usage,
        }));
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxRetries) {
        this.logger?.error("Azure OpenAI request rejected", {
          providerValidation,
          status: error.status,
          kind: error.kind,
          providerCode: error.providerCode,
          ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
          ...(error.contentPolicy ? { contentPolicy: error.contentPolicy } : {}),
          systemChars: request.system.length,
          messageChars: request.messages.reduce(
            (sum, message) => sum + message.content.length,
            0,
          ),
        });
        throw errorWithAggregateUsage(error, attemptUsages, responseAttempt);
      }
      const delayMs = retryDelayMs(
        response,
        attempt,
        this.retryBaseMs,
        this.retryMaxDelayMs,
      );
      this.logger?.warn("Azure OpenAI transient failure; retrying", {
        status: response.status,
        attempt: attempt + 1,
        delayMs,
      });
      await withAbort(() => this.sleep(delayMs, request.signal), request.signal);
    }

    if (!response?.ok) {
      throw new ModelBackendError("upstream", {
        deployment: this.deployment,
        usage: aggregateAttemptUsage(attemptUsages, responseAttempt),
      });
    }
    let text: string;
    let finishReason: string;
    let currentUsage: BackendUsage | undefined;
    let model: string | undefined;
    let providerResponseId: string | undefined;
    let toolCalls: BackendToolCall[] | undefined;
    let responseItems: Record<string, unknown>[] | undefined;
    try {
      if (this.api === "responses") {
        const json = (await this.transport(() => response.json(), request.signal, response)) as ResponsesApiResponse;
        model = safeErrorIdentifier(json.model);
        providerResponseId = safeErrorIdentifier(json.id);
        currentUsage = usageForCompletion(
          json.usage?.input_tokens,
          json.usage?.output_tokens,
          json.usage?.output_tokens_details?.reasoning_tokens,
          json.usage?.input_tokens_details?.cached_tokens,
          json.usage?.input_tokens_details?.cache_write_tokens,
          this.pricing,
        );
        const outputError = asRecord(json.error);
        if (outputError || json.status === "failed") {
          const error = providerFailure(response, json, this.api, this.pricing, this.deployment);
          this.logger?.error("Azure OpenAI request rejected", {
            providerValidation: safeProviderValidation(json, request.tools, {
              secrets: [token], requestText: JSON.stringify(body),
            }),
            status: error.status,
            kind: error.kind,
            providerCode: error.providerCode,
            ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
            ...(error.contentPolicy ? { contentPolicy: error.contentPolicy } : {}),
          });
          throw error;
        }
        if (json.status === "incomplete") {
          const reason = safeErrorIdentifier(json.incomplete_details?.reason);
          const kind = reason && failureKind(response.status, [reason]) === "content_policy"
            ? "content_policy" : reason === "max_output_tokens" ? "output_limit" : "upstream";
          const error = new ModelBackendError(kind, {
            status: response.status,
            providerCode: reason,
            providerRequestId: policyRequestId(response) ?? undefined,
            usage: currentUsage,
            model,
            deployment: this.deployment,
            providerResponseId,
            ...(kind === "content_policy" ? {
              contentPolicy: contentPolicyDetails(json.content_filter_results, "completion", policyRequestId(response)),
            } : {}),
          });
          this.logger?.warn("Azure OpenAI response incomplete", {
            reason: error.providerCode,
            inputTokens: currentUsage.inputTokens,
            outputTokens: currentUsage.outputTokens,
            reasoningTokens: currentUsage.reasoningTokens,
            cacheReadTokens: currentUsage.cacheReadTokens,
            cacheWriteTokens: currentUsage.cacheWriteTokens,
          });
          throw error;
        }
        toolCalls = uniqueToolCalls(
          (json.output ?? [])
            .filter((item) => item.type === "function_call")
            .map((item) => parseToolCall(item.call_id, item.name, item.arguments)),
        );
        if (toolsEnabled || toolCalls) {
          responseItems = json.output ?? [];
        }
        text = (json.output ?? [])
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .filter((content) => content.type === "output_text")
          .map((content) => content.text ?? "")
          .join("");
        finishReason =
          json.incomplete_details?.reason ?? json.status ?? "completed";
        this.logger?.info("Azure OpenAI response completed", {
          api: this.api,
          status: json.status ?? "completed",
          inputTokens: currentUsage.inputTokens,
          outputTokens: currentUsage.outputTokens,
          reasoningTokens: currentUsage.reasoningTokens,
          cacheReadTokens: currentUsage.cacheReadTokens,
          cacheWriteTokens: currentUsage.cacheWriteTokens,
        });
      } else {
        const json = (await this.transport(() => response.json(), request.signal, response)) as ChatCompletionResponse;
        model = safeErrorIdentifier(json.model);
        providerResponseId = safeErrorIdentifier(json.id);
        currentUsage = usageForCompletion(
          json.usage?.prompt_tokens,
          json.usage?.completion_tokens,
          undefined,
          json.usage?.prompt_tokens_details?.cached_tokens,
          json.usage?.prompt_tokens_details?.cache_write_tokens,
          this.pricing,
        );
        const filteredChoice = json.choices?.find((choice) => choice.finish_reason === "content_filter");
        if (filteredChoice) {
          throw new ModelBackendError("content_policy", {
            status: response.status,
            providerCode: "content_filter",
            contentPolicy: contentPolicyDetails(filteredChoice.content_filter_results, "completion", policyRequestId(response)),
            usage: currentUsage,
            model,
            deployment: this.deployment,
            providerResponseId,
          });
        }
        const choice = json.choices?.[0];
        text = choice?.message?.content ?? "";
        finishReason = choice?.finish_reason ?? "stop";
        // A length-limited call can contain truncated arguments. Keep the existing
        // length signal so the engine handles the output cap rather than replaying it.
        if (finishReason !== "length") {
          const calls = choice?.message?.tool_calls;
          if (calls !== undefined) {
            if (!Array.isArray(calls)) {
              return malformedToolCall();
            }
            toolCalls = uniqueToolCalls(calls.map((value: unknown) => {
              const call = asRecord(value);
              const fn = asRecord(call?.function);
              if (call?.type !== "function") {
                return malformedToolCall();
              }
              return parseToolCall(call.id, fn?.name, fn?.arguments);
            }));
          }
          if (finishReason === "tool_calls" && !toolCalls) {
            return malformedToolCall();
          }
        }
      }
    } catch (error) {
      attemptUsages.push(currentUsage);
      const modelError = error instanceof ModelBackendError
        ? new ModelBackendError(error.kind, {
            status: error.status,
            providerCode: error.providerCode,
            providerRequestId: error.providerRequestId,
            contentPolicy: error.contentPolicy,
            usage: currentUsage ?? error.usage,
            model: model ?? error.model,
            deployment: this.deployment,
            providerResponseId: providerResponseId ?? error.providerResponseId,
          })
        : undefined;
      if (observer) {
        await observer(completionEvent(
          responseAttempt,
          modelError?.kind === "output_limit" ? "incomplete" : "failed",
          this.deployment,
          {
            finishReason: modelError?.providerCode,
            model,
            providerResponseId,
            usage: currentUsage,
          },
        ));
      }
      if (modelError) {
        throw errorWithAggregateUsage(modelError, attemptUsages, responseAttempt);
      }
      throw error;
    }

    attemptUsages.push(currentUsage);
    if (observer) {
      await observer(completionEvent(
        responseAttempt,
        finishReason === "length" || finishReason === "max_output_tokens"
          ? "incomplete"
          : "completed",
        this.deployment,
        {
          finishReason,
          model,
          providerResponseId,
          toolCallCount: toolCalls?.length ?? 0,
          usage: currentUsage,
        },
      ));
    }

    return {
      text,
      finishReason,
      usage: aggregateAttemptUsage(attemptUsages, responseAttempt),
      backendId: this.id,
      model,
      deployment: this.deployment,
      providerResponseId,
      ...(toolCalls ? { toolCalls } : {}),
      ...(responseItems ? { responseItems } : {}),
    };
  }

  private async transport<T>(operation: () => Promise<T>, signal?: AbortSignal, response?: Response): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      signal?.throwIfAborted();
      const code = asRecord(asRecord(error)?.cause)?.code ?? asRecord(error)?.code;
      if (typeof code !== "string" || !TRANSPORT_ERROR_CODES.has(code)) {
        throw error;
      }
      this.logger?.error("Azure OpenAI transport failed", { providerCode: code });
      // A transport failure does not prove the provider stopped generating.
      // Do not automatically duplicate a potentially billable inference request.
      throw new ModelBackendError("upstream", {
        providerCode: code,
        ...(response ? { status: response.status, providerRequestId: policyRequestId(response) ?? undefined } : {}),
      });
    }
  }
}
