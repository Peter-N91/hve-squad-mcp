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

/** A pluggable model backend. */
export interface ModelBackend {
  readonly id: string;
  complete(request: BackendRequest): Promise<BackendResult>;
}
