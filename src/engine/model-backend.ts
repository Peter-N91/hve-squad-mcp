/**
 * The `ModelBackend` seam.
 *
 * The embedded engine binds to this abstraction, never to a concrete model
 * client, so:
 *   * the thin slice ships exactly ONE backend (Azure OpenAI), and
 *   * the GitHub Models / OpenAI-compatible backends (Phase 1b) and the optional
 *     Foundry backend (Phase 3) drop in without touching the engine — Foundry
 *     stays optional, never mandatory.
 *
 * The shape deliberately separates **authority** (the `system` prompt, composed
 * from the persona only) from **data** (the `messages`, which carry the
 * delimited, untrusted caller `request`/`context`). That separation is the
 * SEC-5 charter-injection containment contract; see `embedded-prompt.ts`.
 */

import { randomUUID } from "node:crypto";

import { contentPolicyDetails, type ContentPolicyDetails } from "./responsible-ai.js";
import {
  inspectBackendRequest, inspectInputSection, inspectTaskContext, readPreflightDiagnostics,
  type PreflightDiagnostics,
} from "./model-preflight.js";

export type BackendRole = "system" | "user" | "assistant" | "tool";

/** Native function declarations supplied by the server, not executable tools. */
export interface BackendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface BackendToolCall {
  id: string;
  name: string;
  /** JSON object encoded by the provider; argument/schema validation remains local. */
  arguments: string;
}

export interface BackendMessage {
  role: BackendRole;
  content: string;
  toolCallId?: string;
  toolCalls?: BackendToolCall[];
  /** Opaque provider output, including encrypted reasoning, for Responses replay. */
  responseItems?: Record<string, unknown>[];
}

export interface BackendRequest {
  /** The system prompt — AUTHORITY. Composed from persona/role charter ONLY. */
  system: string;
  /** Conversation turns — DATA. Carries the delimited untrusted caller input. */
  messages: BackendMessage[];
  /** Optional output token cap. */
  maxOutputTokens?: number;
  /** Optional sampling temperature. */
  temperature?: number;
  tools?: BackendTool[];
  /** Require native tool dispatch when plain text cannot complete the caller's workflow. */
  toolChoice?: "auto" | "required";
  /** Caller-owned cancellation/deadline, including provider requests and retries. */
  signal?: AbortSignal;
}

export interface BackendUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Hidden reasoning tokens included in `outputTokens` by reasoning models. */
  reasoningTokens?: number;
  /** Cached input tokens included in `inputTokens`; never add them again. */
  cacheReadTokens?: number;
  /** Provider-reported cache-write tokens; billing semantics are provider-specific. */
  cacheWriteTokens?: number;
  /** Number of model completions represented by this usage object. */
  completionCount?: number;
  /** Number of provider requests represented, including rejected/ambiguous attempts. */
  attemptCount?: number;
  /** Completions whose input-token total was not reported by the provider. */
  unreportedInputCompletions?: number;
  /** Completions whose output-token total was not reported by the provider. */
  unreportedOutputCompletions?: number;
  /** Completions covered by `estimatedCostUsd`. */
  pricedCompletionCount?: number;
  /** Completions with a known subtotal but at least one unpriced component. */
  incompletelyPricedCompletionCount?: number;
  /** Completions without enough configured pricing/usage to estimate their cost. */
  unpricedCompletionCount?: number;
  /** Whether the configured USD estimate covers every represented completion. */
  costStatus?: "complete" | "incomplete" | "unavailable";
  /** Currency for `estimatedCostUsd`. Omitted when no priced amount is available. */
  costCurrency?: "USD";
  /** Cost is configuration-derived, never posted billing. */
  costBasis?: "configured_estimate";
  /** Known configured estimate; may be incomplete when `costStatus` is `incomplete`. */
  estimatedCostUsd?: number;
}

type UsageNumberField =
  | "inputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "estimatedCostUsd";

function sumReported(
  usages: readonly BackendUsage[],
  field: UsageNumberField,
): number | undefined {
  const values = usages
    .map((usage) => usage[field])
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

/**
 * Aggregate completion usage without treating missing provider values as zero.
 * Reasoning/cache values remain subsets or side categories; callers must not add
 * them to the input/output totals.
 */
export function aggregateBackendUsage(
  values: readonly (BackendUsage | undefined)[],
): BackendUsage | undefined {
  const usages = values.filter((usage): usage is BackendUsage => usage !== undefined);
  if (usages.length === 0) {
    return undefined;
  }

  let completionCount = 0;
  let attemptCount = 0;
  let unreportedInputCompletions = 0;
  let unreportedOutputCompletions = 0;
  let pricedCompletionCount = 0;
  let incompletelyPricedCompletionCount = 0;
  let unpricedCompletionCount = 0;
  for (const usage of usages) {
    const represented = usage.completionCount ?? 1;
    completionCount += represented;
    attemptCount += usage.attemptCount ?? represented;
    unreportedInputCompletions += usage.unreportedInputCompletions ??
      (usage.inputTokens === undefined ? represented : 0);
    unreportedOutputCompletions += usage.unreportedOutputCompletions ??
      (usage.outputTokens === undefined ? represented : 0);
    const priced = usage.pricedCompletionCount ??
      (usage.costStatus === "complete" ||
        (usage.costStatus === undefined && usage.estimatedCostUsd !== undefined)
        ? represented
        : 0);
    const incompletelyPriced = usage.incompletelyPricedCompletionCount ??
      (usage.costStatus === "incomplete" ? represented : 0);
    pricedCompletionCount += priced;
    incompletelyPricedCompletionCount += incompletelyPriced;
    unpricedCompletionCount += usage.unpricedCompletionCount ??
      Math.max(0, represented - priced - incompletelyPriced);
  }

  const estimatedCostUsd = sumReported(usages, "estimatedCostUsd");
  const inputTokens = sumReported(usages, "inputTokens");
  const outputTokens = sumReported(usages, "outputTokens");
  const reasoningTokens = sumReported(usages, "reasoningTokens");
  const cacheReadTokens = sumReported(usages, "cacheReadTokens");
  const cacheWriteTokens = sumReported(usages, "cacheWriteTokens");
  const costStatus = completionCount > 0 &&
    pricedCompletionCount === completionCount &&
    incompletelyPricedCompletionCount === 0 &&
    unpricedCompletionCount === 0
    ? "complete"
    : pricedCompletionCount > 0 || incompletelyPricedCompletionCount > 0
      ? "incomplete"
      : "unavailable";

  return {
    completionCount,
    attemptCount,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(unreportedInputCompletions > 0 ? { unreportedInputCompletions } : {}),
    ...(unreportedOutputCompletions > 0 ? { unreportedOutputCompletions } : {}),
    pricedCompletionCount,
    incompletelyPricedCompletionCount,
    unpricedCompletionCount,
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

export type BackendCompletionOutcome =
  | "completed"
  | "incomplete"
  | "failed"
  | "ambiguous";

/** One provider attempt, containing identifiers and accounting only—never prompt text. */
export interface BackendCompletionEvent {
  eventId: string;
  attempt: number;
  outcome: BackendCompletionOutcome;
  finishReason?: string;
  backendId: string;
  model?: string;
  deployment?: string;
  providerResponseId?: string;
  toolCallCount?: number;
  usage?: BackendUsage;
}

export type BackendCompletionObserver = (
  event: BackendCompletionEvent,
) => void | Promise<void>;

export interface CompletionContext {
  stage: string;
  actor: string;
}

export type AttributedCompletionObserver = (
  event: BackendCompletionEvent,
  context: CompletionContext,
) => void | Promise<void>;

/** Durable, prompt-free attribution for one provider attempt. */
export interface CompletionUsageRecord extends BackendCompletionEvent {
  schemaVersion: 1;
  runId: string;
  stage: string;
  actor: string;
  recordedAt: string;
}

export function attributeCompletion(
  event: BackendCompletionEvent,
  attribution: { runId: string; stage: string; actor: string; recordedAt?: string },
): CompletionUsageRecord {
  return {
    schemaVersion: 1,
    ...event,
    runId: attribution.runId,
    stage: attribution.stage,
    actor: attribution.actor,
    recordedAt: attribution.recordedAt ?? new Date().toISOString(),
  };
}

export function usageFromCompletionRecords(
  records: readonly CompletionUsageRecord[] | undefined,
): BackendUsage | undefined {
  if (!records?.length) {
    return undefined;
  }
  return aggregateBackendUsage(records.map(usageForCompletionEvent));
}

/** Preserve attempt counts even when a provider supplied no token payload. */
export function usageForCompletionEvent(
  event: Pick<BackendCompletionEvent, "outcome" | "usage">,
): BackendUsage {
  if (event.usage) {
    return { ...event.usage, attemptCount: event.usage.attemptCount ?? 1 };
  }
  const completed = event.outcome === "completed" || event.outcome === "incomplete";
  return {
    attemptCount: 1,
    completionCount: completed ? 1 : 0,
    ...(completed
      ? {
          unreportedInputCompletions: 1,
          unreportedOutputCompletions: 1,
          unpricedCompletionCount: 1,
        }
      : { unpricedCompletionCount: 0 }),
    pricedCompletionCount: 0,
    incompletelyPricedCompletionCount: 0,
    costStatus: "unavailable",
  };
}

export interface BackendResult {
  /** The generated text (the squad-guided artifact body). */
  text: string;
  /** Why generation stopped (`stop`, `length`, ...). */
  finishReason: string;
  usage?: BackendUsage;
  /** The backend that produced this result. */
  backendId: string;
  /** Provider-resolved model identifier, when returned. */
  model?: string;
  /** Operator-selected deployment identifier, when applicable. */
  deployment?: string;
  /** Provider response identifier, when returned. */
  providerResponseId?: string;
  /** True when the executor already emitted this result's provider-attempt events. */
  usageEventsEmitted?: boolean;
  toolCalls?: BackendToolCall[];
  /** Replay these verbatim on the next assistant message; never expose as text. */
  responseItems?: Record<string, unknown>[];
}

export type ModelBackendFailureKind =
  | "input_too_large"
  | "output_limit"
  | "content_policy"
  | "invalid_request"
  | "upstream";

export interface ModelBackendErrorOptions {
  status?: number;
  providerCode?: string;
  providerRequestId?: string;
  contentPolicy?: ContentPolicyDetails;
  usage?: BackendUsage;
  model?: string;
  deployment?: string;
  providerResponseId?: string;
  /** False only when local validation proved no provider request was sent. */
  providerAttempted?: boolean;
  preflight?: PreflightDiagnostics;
}

const PUBLIC_PROVIDER_CODES = new Set([
  "badrequest", "invalidrequest", "invalid_request_error", "invalid_request",
  "internalservererror", "internal_server_error", "server_error", "serviceunavailable",
  "service_unavailable", "deploymentnotfound", "model_not_found", "resourcenotfound",
  "ratelimitexceeded", "rate_limit_exceeded", "toomanyrequests", "insufficient_quota",
  "429", "timeout", "request_timeout", "requesttimeout",
  "context_length_exceeded", "too_many_tokens", "token_limit_exceeded",
  "string_above_max_length", "max_output_tokens", "malformed_tool_call",
  "missing_tool_call_id", "required_tools_missing",
  "chat_reasoning_tools_requires_responses", "unsupported_chat_reasoning_configuration",
  "local_context_preflight_rejected",
  "content_filter", "contentfiltered", "content_policy", "content_policy_violation",
  "responsibleaipolicyviolation",
  "und_err_headers_timeout", "und_err_body_timeout", "und_err_connect_timeout",
  "und_err_socket", "econnreset", "econnrefused", "etimedout", "eai_again", "enotfound",
]);

function safeMetadata(error: { status?: unknown; providerCode?: unknown; providerRequestId?: unknown }) {
  const providerRequestId = contentPolicyDetails(undefined, "unknown",
    typeof error.providerRequestId === "string" ? error.providerRequestId : undefined).providerRequestId;
  return {
    ...(typeof error.status === "number" && Number.isInteger(error.status) &&
      error.status >= 100 && error.status <= 599 ? { providerStatus: error.status } : {}),
    ...(typeof error.providerCode === "string" && PUBLIC_PROVIDER_CODES.has(error.providerCode.toLowerCase())
      ? { providerCode: error.providerCode } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
  };
}

export interface ModelFailureDiagnostics {
  schemaVersion: 1;
  cause: "model_backend_failure";
  kind: Exclude<ModelBackendFailureKind, "content_policy">;
  terminal: true;
  sameRunResumable: false;
  runId?: string;
  stage: string;
  providerStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
  providerAttempted?: false;
  preflight?: PreflightDiagnostics;
}

/** Revalidate stored/custom-backend diagnostics; never retain arbitrary error text. */
export function modelFailureDiagnostics(
  error: { kind?: unknown; status?: unknown; providerCode?: unknown; providerRequestId?: unknown; providerAttempted?: unknown; preflight?: unknown },
  stage: unknown = "unknown",
  runId?: unknown,
): ModelFailureDiagnostics | undefined {
  if (typeof error.kind !== "string" ||
    !["input_too_large", "output_limit", "invalid_request", "upstream"].includes(error.kind)) return undefined;
  const metadata = safeMetadata(error);
  const preflight = error.providerAttempted === false ? readPreflightDiagnostics(error.preflight) : undefined;
  return {
    schemaVersion: 1, cause: "model_backend_failure",
    kind: error.kind as ModelFailureDiagnostics["kind"],
    terminal: true, sameRunResumable: false,
    stage: typeof stage === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(stage) ? stage : "unknown",
    ...(typeof runId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId) ? { runId } : {}),
    ...metadata,
    ...(metadata.providerCode ? { providerCode: metadata.providerCode.toLowerCase() } : {}),
    ...(error.providerAttempted === false ? { providerAttempted: false as const } : {}),
    ...(preflight ? { preflight } : {}),
  };
}

export function readModelFailure(value: unknown): ModelFailureDiagnostics | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.cause !== "model_backend_failure") return undefined;
  return modelFailureDiagnostics({
    kind: data.kind, status: data.providerStatus,
    providerCode: data.providerCode, providerRequestId: data.providerRequestId,
    providerAttempted: data.providerAttempted, preflight: data.preflight,
  }, data.stage, data.runId);
}

export function modelFailureMessage(details: ModelFailureDiagnostics): string {
  return [
    `Model backend failure (${details.kind}). Stage: ${details.stage}.`,
    ...(details.runId ? [`Run: ${details.runId}.`] : []),
    ...(details.providerAttempted === false
      ? ["Local validation stopped this request BEFORE authentication/provider dispatch. No provider attempt was made.",
        ...(details.preflight?.issues.map(issue => `Preflight rule: ${issue.rule}. Field: ${issue.field}.`) ?? [])]
      : [`Provider HTTP status: ${details.providerStatus ?? "unknown"}. Provider code: ${details.providerCode ?? "unknown"}.`,
        `Provider correlation: ${details.providerRequestId ?? "not provided in validated metadata"}.`]),
    "This run is terminal, not a human approval gate. Persisted work and accepted human responses are retained; drafts may be partial or unreviewed.",
    "No automatic replay is requested. Review the diagnostic with the operator before explicitly authorizing any new attempt. Unknown provider details cannot establish the underlying cause or prove it is fixed.",
  ].join("\n\n");
}

/**
 * A provider failure reduced to non-sensitive metadata. Provider response
 * messages are deliberately excluded because they can echo caller input.
 */
export class ModelBackendError extends Error {
  readonly kind: ModelBackendFailureKind;
  readonly status?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  readonly contentPolicy?: ContentPolicyDetails;
  readonly usage?: BackendUsage;
  readonly model?: string;
  readonly deployment?: string;
  readonly providerResponseId?: string;
  readonly providerAttempted?: boolean;
  readonly preflight?: PreflightDiagnostics;

  constructor(
    kind: ModelBackendFailureKind,
    options: ModelBackendErrorOptions = {},
  ) {
    const metadata = safeMetadata(options);
    const status = metadata.providerStatus === undefined ? "" : `, status ${metadata.providerStatus}`;
    const code = metadata.providerCode ? `, code ${metadata.providerCode}` : "";
    const guidance = metadata.providerCode === "chat_reasoning_tools_requires_responses"
      ? " GPT-5.6 reasoning with tools requires SQUAD_MCP_MODEL_API=responses; no provider request was sent."
      : metadata.providerCode === "unsupported_chat_reasoning_configuration"
        ? " Verify SQUAD_MCP_MODEL_CHAT_PROFILE and supported reasoning effort, or use SQUAD_MCP_MODEL_API=responses; no provider request was sent."
        : metadata.providerCode === "local_context_preflight_rejected"
          ? " Local input preflight rejected the request; no provider attempt was made."
          : "";
    super(`Model backend request failed (${kind}${status}${code}).${guidance}`);
    this.name = "ModelBackendError";
    this.kind = kind;
    this.status = metadata.providerStatus;
    this.providerCode = metadata.providerCode;
    this.providerRequestId = metadata.providerRequestId;
    this.contentPolicy = options.contentPolicy;
    this.usage = options.usage;
    this.model = options.model;
    this.deployment = options.deployment;
    this.providerResponseId = options.providerResponseId;
    this.providerAttempted = options.providerAttempted;
    this.preflight = options.providerAttempted === false ? readPreflightDiagnostics(options.preflight) : undefined;
  }
}

export function assertModelPreflight(preflight: PreflightDiagnostics | undefined): void {
  if (preflight) {
    throw new ModelBackendError("invalid_request", {
      providerCode: "local_context_preflight_rejected", providerAttempted: false, preflight,
    });
  }
}

export function assertBackendPreflight(request: BackendRequest): void {
  assertModelPreflight(inspectBackendRequest(request));
}

export function prepareTaskContext(context: string) {
  const result = inspectTaskContext(context);
  assertModelPreflight(result.preflight);
  return result;
}

export function prepareInputSection(text: string, field: "request" | "priorArtifact"): string {
  assertModelPreflight(inspectInputSection(text, field));
  return text;
}

/** A pluggable model backend. */
export interface ModelBackend {
  readonly id: string;
  readonly supportsTools?: boolean;
  complete(request: BackendRequest): Promise<BackendResult>;
  /**
   * Optional per-provider-attempt accounting seam. Backends that retry internally
   * use this to expose each attempt instead of collapsing retry usage.
   */
  completeObserved?(
    request: BackendRequest,
    observer: BackendCompletionObserver,
  ): Promise<BackendResult>;
}

function resultOutcome(result: BackendResult): BackendCompletionOutcome {
  return result.finishReason === "length" ||
    result.finishReason === "max_output_tokens" ||
    result.finishReason === "incomplete"
    ? "incomplete"
    : "completed";
}

export function completionEventFromResult(
  result: BackendResult,
  attempt = 1,
): BackendCompletionEvent {
  return {
    eventId: randomUUID(),
    attempt,
    outcome: resultOutcome(result),
    finishReason: result.finishReason,
    backendId: result.backendId,
    model: result.model,
    deployment: result.deployment,
    providerResponseId: result.providerResponseId,
    toolCallCount: result.toolCalls?.length ?? 0,
    usage: result.usage,
  };
}

function syntheticEvent(
  backend: ModelBackend,
  resultOrError: BackendResult | unknown,
): BackendCompletionEvent {
  if (resultOrError instanceof ModelBackendError) {
    return {
      eventId: randomUUID(),
      attempt: 1,
      outcome: resultOrError.kind === "output_limit" ? "incomplete" : "failed",
      finishReason: resultOrError.providerCode,
      backendId: backend.id,
      model: resultOrError.model,
      deployment: resultOrError.deployment,
      providerResponseId: resultOrError.providerResponseId,
      usage: resultOrError.usage,
    };
  }
  if (resultOrError && typeof resultOrError === "object" &&
      "backendId" in resultOrError && "finishReason" in resultOrError) {
    return completionEventFromResult(resultOrError as BackendResult);
  }
  return {
    eventId: randomUUID(),
    attempt: 1,
    outcome: "failed",
    backendId: backend.id,
  };
}

/**
 * Observe every provider attempt when supported and synthesize one event for
 * legacy/custom backends. This keeps the backend seam compatible while giving
 * orchestrators one accounting path.
 */
export async function completeWithObserver(
  backend: ModelBackend,
  request: BackendRequest,
  observer: BackendCompletionObserver,
): Promise<BackendResult> {
  request.signal?.throwIfAborted();
  assertBackendPreflight(request);
  let observed = 0;
  const eventIds = new Set<string>();
  const notify: BackendCompletionObserver = async (event) => {
    if (eventIds.has(event.eventId)) {
      return;
    }
    eventIds.add(event.eventId);
    observed += 1;
    await observer(event);
  };
  try {
    const result = backend.completeObserved
      ? await backend.completeObserved(request, notify)
      : await backend.complete(request);
    if (observed === 0) {
      await notify(syntheticEvent(backend, result));
    }
    return result;
  } catch (error) {
    const cancelledBeforeObserved = request.signal?.aborted &&
      error === request.signal.reason;
    if (observed === 0 && !cancelledBeforeObserved &&
        (!(error instanceof ModelBackendError) || error.providerAttempted !== false)) {
      await notify(syntheticEvent(backend, error));
    }
    throw error;
  }
}
