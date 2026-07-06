/**
 * Deterministic mock `ModelBackend` for the conformance suite.
 *
 * Stands in for the live Azure OpenAI backend so EVERY conformance corpus runs
 * with no live Azure, no network, and no `@azure/identity`. It is:
 *
 *   * deterministic — identical input produces an identical, role-structured
 *     artifact, so the embedded-vs-delegated parity metric (COST-4) is stable; and
 *   * inspectable — every {@link BackendRequest} it receives is captured in
 *     `calls`, so a corpus can assert exactly what AUTHORITY (the `system` prompt)
 *     versus DATA (the `messages`) the engine passed (SEC-5), and that NO backend
 *     call happens for a held or denied run (SEC-6 / SEC-9).
 *
 * It never parses the caller DATA as instructions and never echoes caller content
 * into the artifact, mirroring the contained behavior the real model is told to
 * follow. A server secret therefore can never reach the artifact through it
 * (SEC-10 concerns server secrets, not caller-owned content).
 */
import type { BackendRequest, BackendResult, ModelBackend } from "../../../src/engine/model-backend.js";

export interface MockBackendOptions {
  /** The backend id reported on results (default `mock-backend`). */
  id?: string;
  /** When set, `complete` rejects with this error (error-path tests). */
  failWith?: Error;
  /** Best-effort realized cost reported per call (feeds the COST-2 ceiling). */
  costUsdPerCall?: number;
  /** Optional hook run on every call (e.g. to exercise the logger redaction path). */
  onComplete?: (request: BackendRequest) => void;
}

/** Produce a deterministic, role-structured artifact from the system authority. */
function roleArtifact(system: string): string {
  if (system.includes("Task Researcher")) {
    return [
      "## Summary",
      "A concise, evidence-grounded research summary produced server-side.",
      "",
      "## Key Findings",
      "- Finding one, with its supporting evidence.",
      "- Finding two, with its supporting evidence.",
      "",
      "## Options and Trade-offs",
      "- Option A versus Option B, with the trade-off stated.",
      "",
      "## Open Questions",
      "- The explicit unknowns that remain.",
    ].join("\n");
  }
  if (system.includes("Task Reviewer")) {
    return [
      "## Verdict",
      "Approve-with-nits (deterministic mock verdict).",
      "",
      "## Findings",
      "- A severity-ordered finding, with its evidence.",
      "",
      "## Follow-ups",
      "- A concrete follow-up action.",
    ].join("\n");
  }
  return ["## Result", "A generic squad-guided artifact produced server-side."].join("\n");
}

/** A capturing, deterministic stand-in for the Azure OpenAI backend. */
export class MockModelBackend implements ModelBackend {
  readonly id: string;
  /** Every request the engine passed to the backend, in call order. */
  readonly calls: BackendRequest[] = [];
  private readonly options: MockBackendOptions;

  constructor(options: MockBackendOptions = {}) {
    this.id = options.id ?? "mock-backend";
    this.options = options;
  }

  /** How many times `complete` was invoked. */
  get callCount(): number {
    return this.calls.length;
  }

  /** The most recent request the engine passed (or `undefined` if none). */
  get lastCall(): BackendRequest | undefined {
    return this.calls[this.calls.length - 1];
  }

  complete(request: BackendRequest): Promise<BackendResult> {
    this.calls.push(request);
    this.options.onComplete?.(request);
    if (this.options.failWith) {
      return Promise.reject(this.options.failWith);
    }
    return Promise.resolve({
      text: roleArtifact(request.system),
      finishReason: "stop",
      usage: {
        inputTokens: 120,
        outputTokens: 240,
        estimatedCostUsd: this.options.costUsdPerCall ?? 0.002,
      },
      backendId: this.id,
    });
  }
}
