/**
 * Readiness: whether this instance can perform the work it advertises right now.
 *
 * Served unauthenticated at `GET /readyz` for platform probes, so the response
 * carries only per-check booleans; reasons stay in the server log. Liveness
 * (`GET /healthz`) only says the process is serving requests.
 */
export interface ReadinessCheck {
  ok: boolean;
  /** Operator-facing explanation; logged, never returned by the probe endpoint. */
  reason: string;
  /** Waiting cannot fix this failure (for example, an invalid credential); startup must abort. */
  fatal?: boolean;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, ReadinessCheck>;
}

export interface ReadinessProbe {
  /** One-time startup verification; the server must not listen when a check is fatal. */
  prepare(): Promise<ReadinessReport>;
  /** Cheap, repeatable check for the readiness endpoint. */
  check(): Promise<ReadinessReport>;
}
