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

export type BackendRole = "system" | "user" | "assistant";

export interface BackendMessage {
  role: BackendRole;
  content: string;
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
}

export interface BackendUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Hidden reasoning tokens included in `outputTokens` by reasoning models. */
  reasoningTokens?: number;
  /** Best-effort realized cost; fed into the per-tenant cost ceiling (COST-2). */
  estimatedCostUsd?: number;
}

export interface BackendResult {
  /** The generated text (the squad-guided artifact body). */
  text: string;
  /** Why generation stopped (`stop`, `length`, ...). */
  finishReason: string;
  usage?: BackendUsage;
  /** The backend that produced this result. */
  backendId: string;
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
}

/**
 * A provider failure reduced to non-sensitive metadata. Provider response
 * messages are deliberately excluded because they can echo caller input.
 */
export class ModelBackendError extends Error {
  readonly kind: ModelBackendFailureKind;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(
    kind: ModelBackendFailureKind,
    options: ModelBackendErrorOptions = {},
  ) {
    const status = options.status === undefined ? "" : `, status ${options.status}`;
    const code = options.providerCode ? `, code ${options.providerCode}` : "";
    super(`Model backend request failed (${kind}${status}${code}).`);
    this.name = "ModelBackendError";
    this.kind = kind;
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

/** A pluggable model backend. */
export interface ModelBackend {
  readonly id: string;
  complete(request: BackendRequest): Promise<BackendResult>;
}
