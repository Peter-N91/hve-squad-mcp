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
import {
  ModelBackendError,
  type BackendRequest,
  type BackendResult,
  type ModelBackendFailureKind,
  type ModelBackend,
} from "../model-backend.js";
import type { RedactingLogger } from "../../observability/logger.js";

/** Per-million-token pricing used for the best-effort cost estimate (COST-2). */
export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
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
  /** Responses API reasoning effort. Omit for the model's default. */
  reasoningEffort?: AzureOpenAIReasoningEffort;
  /** Responses API visible-output verbosity. Omit for the model's default. */
  verbosity?: AzureOpenAIVerbosity;
  /** Returns a fresh bearer token (managed identity or Key Vault key). */
  getAccessToken: () => Promise<string>;
  /** Injectable fetch (default: global fetch). */
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
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ResponsesApiResponse {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: {
    type?: string;
    content?: { type?: string; text?: string }[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

function estimateCostUsd(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  pricing: ModelPricing | undefined,
): number | undefined {
  if (!pricing) {
    return undefined;
  }

  const input = ((promptTokens ?? 0) / 1_000_000) * pricing.inputPerMTokUsd;
  const output = ((completionTokens ?? 0) / 1_000_000) * pricing.outputPerMTokUsd;
  return input + output;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SAFE_ERROR_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,80}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
        code.includes("content_policy") ||
        code.includes("responsibleaipolicyviolation"),
    )
  ) {
    return "content_policy";
  }
  return status >= 400 && status < 500 ? "invalid_request" : "upstream";
}

async function responseError(response: Response): Promise<ModelBackendError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const error = asRecord(asRecord(payload)?.error);
  const innerError = asRecord(error?.innererror);
  const codes = [
    safeErrorIdentifier(error?.code),
    safeErrorIdentifier(innerError?.code),
  ].filter((code): code is string => code !== undefined);
  const providerCode = codes.at(-1);
  return new ModelBackendError(failureKind(response.status, codes), {
    status: response.status,
    providerCode,
  });
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
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly api: AzureOpenAIApi;
  private readonly apiVersion: string;
  private readonly defaultMaxOutputTokens: number;
  private readonly reasoningEffort?: AzureOpenAIReasoningEffort;
  private readonly verbosity?: AzureOpenAIVerbosity;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly pricing?: ModelPricing;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

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
    this.verbosity = options.verbosity;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async complete(request: BackendRequest): Promise<BackendResult> {
    const token = await this.getAccessToken();
    this.logger?.registerSecret(token);

    const maxOutputTokens =
      request.maxOutputTokens ?? this.defaultMaxOutputTokens;
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
            input: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            max_output_tokens: maxOutputTokens,
            ...(this.reasoningEffort
              ? { reasoning: { effort: this.reasoningEffort } }
              : {}),
            ...(this.verbosity ? { text: { verbosity: this.verbosity } } : {}),
          }
        : {
            messages: [
              { role: "system", content: request.system },
              ...request.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
            ],
            temperature: request.temperature ?? 0.2,
            max_tokens: maxOutputTokens,
          };

    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        break;
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxRetries) {
        const error = await responseError(response);
        this.logger?.error("Azure OpenAI request rejected", {
          status: error.status,
          kind: error.kind,
          providerCode: error.providerCode,
          systemChars: request.system.length,
          messageChars: request.messages.reduce(
            (sum, message) => sum + message.content.length,
            0,
          ),
        });
        throw error;
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
      await this.sleep(delayMs);
    }

    if (!response?.ok) {
      throw new ModelBackendError("upstream");
    }
    let text: string;
    let finishReason: string;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let reasoningTokens: number | undefined;
    if (this.api === "responses") {
      const json = (await response.json()) as ResponsesApiResponse;
      if (json.status === "incomplete") {
        const reason = safeErrorIdentifier(json.incomplete_details?.reason);
        this.logger?.warn("Azure OpenAI response incomplete", {
          reason,
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
          reasoningTokens:
            json.usage?.output_tokens_details?.reasoning_tokens,
        });
        throw new ModelBackendError(
          reason === "max_output_tokens" ? "output_limit" : "upstream",
          { status: response.status, providerCode: reason },
        );
      }
      text = (json.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((content) => content.type === "output_text")
        .map((content) => content.text ?? "")
        .join("");
      finishReason =
        json.incomplete_details?.reason ?? json.status ?? "completed";
      promptTokens = json.usage?.input_tokens;
      completionTokens = json.usage?.output_tokens;
      reasoningTokens =
        json.usage?.output_tokens_details?.reasoning_tokens;
      this.logger?.info("Azure OpenAI response completed", {
        api: this.api,
        status: json.status ?? "completed",
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        reasoningTokens,
      });
    } else {
      const json = (await response.json()) as ChatCompletionResponse;
      const choice = json.choices?.[0];
      text = choice?.message?.content ?? "";
      finishReason = choice?.finish_reason ?? "stop";
      promptTokens = json.usage?.prompt_tokens;
      completionTokens = json.usage?.completion_tokens;
    }

    return {
      text,
      finishReason,
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        reasoningTokens,
        estimatedCostUsd: estimateCostUsd(promptTokens, completionTokens, this.pricing),
      },
      backendId: this.id,
    };
  }
}
