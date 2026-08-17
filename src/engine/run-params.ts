/**
 * Durable round-trip for the coordinator inputs an async run must not lose.
 *
 * `RunState` has always persisted `request` + `context` so a status poll can drive
 * an approved run to completion. Everything else the caller supplied — `profile`,
 * `tier`, `owner`, `mode`, and the federation `squad` / `init` / `promote` inputs —
 * was dropped at the durable boundary, so a resumed run executed as if the caller
 * had passed only free text. That is invisible for `squad_run` (which has no
 * behavioral inputs beyond the request) but wrong for `squad_federate`, whose whole
 * job is decided by `squad` / `init` / `promote`.
 *
 * These helpers serialize exactly those fields to a compact JSON blob stored in
 * {@link import("./run-state.js").RunState.params} (encrypted at rest by the durable
 * stores, like `request`/`context`) and rebuild a full
 * {@link CoordinatorRequest} from a persisted run.
 *
 * Parsing is DEFENSIVE: a malformed / hostile blob never throws and never yields a
 * value of the wrong type — an unparseable blob degrades to "no extra inputs",
 * which is exactly the pre-existing behavior.
 *
 * `discovery` is deliberately absent: only the attended delegated path runs the
 * discovery gate, and every run persisted here is unattended, so storing the input
 * would imply a resumed run might honor it.
 */
import type { CoordinatorRequest } from "./coordinator-engine.js";

/** The subset of {@link CoordinatorRequest} persisted alongside request/context. */
export interface PersistedRunParams {
  profile?: string;
  tier?: string;
  owner?: string;
  mode?: string;
  squad?: string;
  init?: boolean;
  promote?: boolean;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Serialize the non-request coordinator inputs, or `undefined` when there is
 * nothing to persist (so a plain `squad_run` record is byte-identical to before).
 */
export function encodeRunParams(request: CoordinatorRequest): string | undefined {
  const params: PersistedRunParams = {};
  if (request.profile) params.profile = request.profile;
  if (request.tier) params.tier = request.tier;
  if (request.owner) params.owner = request.owner;
  if (request.mode) params.mode = request.mode;
  if (request.squad) params.squad = request.squad;
  if (request.init === true) params.init = true;
  if (request.promote === true) params.promote = true;
  return Object.keys(params).length === 0 ? undefined : JSON.stringify(params);
}

/** Parse a persisted params blob. Never throws; unknown/invalid input yields `{}`. */
export function decodeRunParams(blob: string | undefined): PersistedRunParams {
  if (!blob) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  return {
    profile: optionalString(record.profile),
    tier: optionalString(record.tier),
    owner: optionalString(record.owner),
    mode: optionalString(record.mode),
    squad: optionalString(record.squad),
    init: record.init === true,
    promote: record.promote === true,
  };
}

/**
 * Rebuild the full {@link CoordinatorRequest} for a persisted run: the stored
 * request/context plus every input recovered from {@link decodeRunParams}.
 */
export function coordinatorRequestFromRun(run: {
  toolId: string;
  request?: string;
  context?: string;
  params?: string;
}): CoordinatorRequest {
  const params = decodeRunParams(run.params);
  return {
    toolId: run.toolId,
    request: run.request ?? "",
    context: run.context,
    profile: params.profile,
    tier: params.tier,
    owner: params.owner,
    mode: params.mode,
    squad: params.squad,
    init: params.init,
    promote: params.promote,
  };
}
