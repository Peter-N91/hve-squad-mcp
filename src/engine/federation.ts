/**
 * Federation framing for the EMBEDDED (remote / Copilot Studio) boundary.
 *
 * The delegated path already carries full federation semantics (`persona.ts` +
 * `delegated.ts`): it hands the host the Federation Coordinator persona and lets
 * the host resolve the registry and dispatch sub-squads. The embedded path had
 * none — `squad_federate` was not even reachable over HTTP — so this module
 * supplies the missing piece: the server-side, DETERMINISTIC federation directive
 * that is prepended to the Federation Coordinator's charter for an embedded run.
 *
 * SEC-5 posture. The directive is AUTHORITY (it becomes part of the `system`
 * charter), so it is composed EXCLUSIVELY from values the server has already
 * validated:
 *   * `squad` — matched against {@link SUB_SQUAD_NAME} (lower-kebab-case) and
 *     dropped when it does not match, so no caller string is interpolated raw;
 *   * `init` / `promote` — booleans normalized by the router;
 *   * `mode` — matched against the closed autonomy set.
 * The caller's free-text `request`/`context` are NEVER placed here; they remain
 * delimited DATA composed by `composeEmbeddedPrompt`, exactly as for every other
 * embedded stage.
 *
 * The directive also closes the turn to Watch Mode's unattended bootstrap. The
 * bundled Federation Coordinator charter carries an auto-approved promotion /
 * expansion path that a repository event may take; an MCP call is not that event,
 * so every turn here is pinned CONFIRMATION-GATED (see `NO_WATCH_BOOTSTRAP_NOTE`).
 */
import { FEDERATION_COORDINATOR_CHARTER } from "./embedded-roles.js";
import { NO_WATCH_BOOTSTRAP_NOTE } from "./persona.js";
import type { CoordinatorRequest } from "./coordinator-engine.js";
import type { PersonaRecord } from "./persona-loader.js";

/** The federation role name as it appears in the catalog and the deployed cast. */
export const FEDERATION_ROLE = "Squad Federation Coordinator";

/** Sub-squad naming rule from squad-federation.instructions.md (lower-kebab-case). */
const SUB_SQUAD_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The closed autonomy set the catalog allows. */
const AUTONOMY_MODES = new Set(["autonomous", "autopilot"]);

/** The federation inputs, after server-side validation. */
export interface FederationInputs {
  /** The validated sub-squad target, or `undefined` for meta-routing. */
  readonly squad?: string;
  /** Federation Init / Expansion Mode. */
  readonly init: boolean;
  /** Federation Promotion Mode (adopt an existing single squad). */
  readonly promote: boolean;
  /** The validated autonomy mode, or `undefined`. */
  readonly mode?: string;
}

/**
 * Validate the federation-relevant inputs of a coordinator request. Anything that
 * fails its shape check is DROPPED (never passed through), so a hostile `squad`
 * value can neither reach the charter nor a state path.
 */
export function federationInputs(request: CoordinatorRequest): FederationInputs {
  const squad = request.squad && SUB_SQUAD_NAME.test(request.squad) ? request.squad : undefined;
  const mode = request.mode && AUTONOMY_MODES.has(request.mode) ? request.mode : undefined;
  return { squad, init: request.init === true, promote: request.promote === true, mode };
}

/**
 * Compose the server-side federation directive appended to the Federation
 * Coordinator charter. Deterministic and fully derived from {@link federationInputs}.
 *
 * Precedence mirrors the delegated path and the squad's federation instructions:
 * `promote` (adopt an existing single squad) is resolved BEFORE `init` (create /
 * expand), because promotion is only meaningful on a repo that has a top-level
 * squad and no registry yet; running init first would seed a second, empty
 * federation root and strand the existing state. When both flags arrive together
 * the directive states promotion first and init second, so the model never has to
 * guess the order.
 */
export function federationDirective(inputs: FederationInputs): string {
  const lines: string[] = ["", "**Federation turn (server-resolved).**"];

  if (inputs.promote) {
    lines.push(
      "- This turn runs **Federation Promotion Mode**: the repository has an existing",
      "  single squad (a top-level `team.md`) and no `federation.md`. Adopt that squad",
      "  into a federation as its FIRST sub-squad, relocating its state intact, and say",
      "  explicitly what moves where before anything else in this turn. This is the",
      "  CONFIRMATION-GATED promotion, not the unattended Watch Mode one: propose the",
      "  move and wait for the user, never present it as already done.",
    );
  }
  if (inputs.init) {
    lines.push(
      "- This turn runs **Federation Init / Expansion Mode**: propose the federation (or",
      "  the new sub-squad), state the registry and meta-routing entries it needs, and",
      "  make clear this is a proposal awaiting confirmation \u2014 do not present it as",
      "  already created.",
    );
  }
  if (inputs.squad) {
    lines.push(
      `- The caller pinned an explicit sub-squad target: \`${inputs.squad}\`. Honor it and`,
      "  do NOT re-route via meta-routing. Scope the whole turn to",
      `  \`.copilot-tracking/squad/members/${inputs.squad}/\`.`,
    );
  } else {
    lines.push(
      "- No sub-squad was pinned. Resolve the target(s) from `meta-routing.md` and state",
      "  the routing decision (which sub-squad, on what signal) before the work. If the",
      "  target is ambiguous or unknown, escalate and ask \u2014 never invent a sub-squad.",
    );
  }
  if (inputs.mode === "autopilot" && !inputs.squad) {
    lines.push(
      "- `mode=autopilot` with no pinned target means a FEDERATION-WIDE autopilot: plan",
      "  ordered per-sub-squad runs, attribute every federation-level gate to the",
      "  sub-squad that raised it, aggregate one cost ceiling, and close with a single",
      "  consolidated final-outcome validation.",
    );
  } else if (inputs.mode) {
    lines.push(`- Autonomy mode \`${inputs.mode}\` is forwarded to the selected sub-squad's run.`);
  }

  lines.push(
    "",
    NO_WATCH_BOOTSTRAP_NOTE,
    "",
    "You are advisory here: produce the federation decision and per-sub-squad plan as",
    "text. You do not create files, move state, or dispatch sub-squads yourself.",
  );
  return lines.join("\n");
}

/**
 * Build the single-stage federation persona for an embedded run: the resolved
 * Federation Coordinator charter (real on-disk `*.agent.md` bytes when the cast is
 * present, else the embedded paraphrase) plus the server-composed directive.
 */
export function federationPersona(
  request: CoordinatorRequest,
  resolved?: PersonaRecord,
): PersonaRecord {
  const base = resolved ?? {
    role: FEDERATION_ROLE,
    charter: FEDERATION_COORDINATOR_CHARTER,
    applyTo: [] as string[],
  };
  return {
    ...base,
    role: FEDERATION_ROLE,
    charter: `${base.charter}\n${federationDirective(federationInputs(request))}`,
  };
}
