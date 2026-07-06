/**
 * Pre-implementation council stage with most-restrictive-wins synthesis.
 *
 * This module dispatches each council member's persona charter over the plan
 * artifact and synthesizes ONE durable `## Council Verdict` from the members'
 * findings, following the advisory subset of
 * `squad-src/.github/instructions/squad/squad-council.instructions.md`:
 *
 *   * Each member is dispatched against the SAME scoped input (the plan
 *     artifact), never threaded member-to-member — the council is a parallel
 *     go/no-go over one proposal, not a pipeline.
 *   * The verdict is synthesized MOST-RESTRICTIVE-WINS: any `Stop` (or a member
 *     `Block` / `Risk: High`) drives the verdict to `Stop`; else any
 *     `Go-With-Conditions` (a member `Conditional` or one that raised explicit
 *     conditions) drives it to `Go-With-Conditions` with the conditions
 *     aggregated and role-attributed; else `Go`.
 *   * A `Stop` verdict halts the advisory pipeline — there is no implement stage
 *     to gate in the advisory (v1) scope, so the compiled artifact simply ends
 *     with the verdict.
 *
 * SEC-5 is preserved by construction: every member's `system` is that member's
 * persona charter ONLY (AUTHORITY); the caller request/context and the plan
 * artifact are carried as delimited DATA via `composeEmbeddedPrompt`.
 */
import { composeEmbeddedPrompt } from "./embedded-prompt.js";
import { resolvePersonaForRole } from "./embedded-roles.js";
import type { PersonaRecord } from "./persona-loader.js";
import type { BackendUsage, ModelBackend } from "./model-backend.js";
import type { CoordinatorRequest } from "./coordinator-engine.js";
import type { RoutePlan } from "./routing.js";

/** The three canonical Council Verdict classes (advisory subset). */
export type CouncilVerdictClass = "Go" | "Go-With-Conditions" | "Stop";

/** One council member's parsed finding over the plan artifact. */
export interface CouncilMemberOpinion {
  /** The member agent `name:` (equals the resolved persona role). */
  agentName: string;
  /** The member's verdict class, parsed from its finding text. */
  verdict: CouncilVerdictClass;
  /** The conditions the member raised (empty unless Go-With-Conditions). */
  conditions: string[];
  /** The member's raw finding text. */
  text: string;
  /** The backend that produced the finding. */
  backendId: string;
  /** Per-member usage (for cost accounting). */
  usage?: BackendUsage;
}

/** The synthesized council verdict plus the rendered `## Council Verdict` block. */
export interface CouncilVerdict {
  /** The most-restrictive-wins verdict class. */
  verdict: CouncilVerdictClass;
  /** The aggregated, role-attributed conditions (empty for a `Go`). */
  conditions: string[];
  /** Per-member opinions in dispatch order. */
  members: CouncilMemberOpinion[];
  /** Per-member usage (for cost accounting). */
  usage: BackendUsage[];
  /** The rendered `## Council Verdict` markdown section. */
  markdown: string;
}

export interface CouncilDeps {
  backend: ModelBackend;
}

// ---------------------------------------------------------------------------
// Member-finding parsing.
// ---------------------------------------------------------------------------

/**
 * Extract the conditions a member raised. Supports both an inline
 * `Conditions: <text>` label and a `Conditions:` section header followed by a
 * bullet list. A literal `none` is treated as no condition.
 */
function extractConditions(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const conditions: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^#{0,6}\s*conditions?\b\s*:?\s*(.*)$/i.exec(line);
    if (header) {
      inSection = true;
      const inline = header[1].trim().replace(/^[-*]\s*/, "");
      if (inline.length > 0 && !/^none\b/i.test(inline)) {
        conditions.push(inline);
      }
      continue;
    }
    if (inSection) {
      const bullet = /^[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        const value = bullet[1].trim();
        if (value.length > 0 && !/^none\b/i.test(value)) {
          conditions.push(value);
        }
        continue;
      }
      // A blank line or a new header/label ends the conditions section.
      if (line.length === 0 || /^#{1,6}\s/.test(line) || /\w:\s*$/.test(line)) {
        inSection = false;
      }
    }
  }
  return conditions;
}

/**
 * Parse a single member's finding text into a verdict class + conditions. The
 * member level itself applies most-restrictive-wins: a `Block` / `Risk: High` /
 * `Stop` marker yields `Stop`; a `Conditional` / `Go-With-Conditions` marker or
 * any raised condition yields `Go-With-Conditions`; otherwise `Go`.
 *
 * Accepts BOTH the council-member label vocabulary (`Approve` / `Conditional` /
 * `Concern` / `Block` with `Risk: Low|Medium|High`) and the direct verdict-class
 * vocabulary (`Go` / `Go-With-Conditions` / `Stop`), so a persona finding in
 * either form is classified consistently.
 */
export function parseMemberVerdict(text: string): {
  verdict: CouncilVerdictClass;
  conditions: string[];
} {
  const conditions = extractConditions(text);
  // Stop-drivers win first (Risk: High blocks even under a softer own-label).
  if (/\brisk:\s*high\b/i.test(text) || /\bblock\b/i.test(text) || /(^|[^a-z])stop\b/i.test(text)) {
    return { verdict: "Stop", conditions };
  }
  if (
    /go[-\s]with[-\s]conditions/i.test(text) ||
    /\bconditional\b/i.test(text) ||
    conditions.length > 0
  ) {
    return { verdict: "Go-With-Conditions", conditions };
  }
  return { verdict: "Go", conditions: [] };
}

// ---------------------------------------------------------------------------
// Synthesis + rendering.
// ---------------------------------------------------------------------------

/** Aggregate + de-duplicate member conditions with inline role attribution. */
function aggregateConditions(opinions: CouncilMemberOpinion[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const opinion of opinions) {
    for (const condition of opinion.conditions) {
      const attributed = `(${opinion.agentName}) ${condition}`;
      const key = attributed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(attributed);
      }
    }
  }
  return out;
}

/**
 * Synthesize the single council verdict from member opinions by
 * most-restrictive-wins. Conditions are aggregated for a `Go-With-Conditions`
 * (and carried on a `Stop` for the audit trail); a `Go` carries none.
 */
export function synthesizeVerdict(opinions: CouncilMemberOpinion[]): {
  verdict: CouncilVerdictClass;
  conditions: string[];
} {
  const conditions = aggregateConditions(opinions);
  if (opinions.some((opinion) => opinion.verdict === "Stop")) {
    return { verdict: "Stop", conditions };
  }
  if (opinions.some((opinion) => opinion.verdict === "Go-With-Conditions")) {
    return { verdict: "Go-With-Conditions", conditions };
  }
  return { verdict: "Go", conditions: [] };
}

/** Render the `## Council Verdict` markdown section (advisory subset of the schema). */
function renderVerdict(
  verdict: CouncilVerdictClass,
  conditions: string[],
  opinions: CouncilMemberOpinion[],
): string {
  const lines: string[] = ["## Council Verdict", ""];
  lines.push(`* Verdict: ${verdict}`);
  lines.push(`* Council Members Dispatched: ${opinions.map((o) => o.agentName).join(", ")}`);
  lines.push("", "### Findings by Member", "");
  lines.push("| Member | Verdict | Conditions |");
  lines.push("| --- | --- | --- |");
  for (const opinion of opinions) {
    const conds = opinion.conditions.length > 0 ? opinion.conditions.join("; ") : "none";
    lines.push(`| ${opinion.agentName} | ${opinion.verdict} | ${conds} |`);
  }
  lines.push("", "### Conditions", "");
  if (conditions.length > 0) {
    for (const condition of conditions) {
      lines.push(`- ${condition}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("", "### Implementation Gate", "");
  lines.push(
    `* Permits Implementation Dispatch: ${verdict === "Stop" ? "no (Stop)" : `yes (${verdict})`}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Member resolution + dispatch.
// ---------------------------------------------------------------------------

/**
 * Resolve a routed {@link RoutePlan}'s council member `agentName`s into ordered
 * {@link PersonaRecord}s via the Phase 1 loader (`resolvePersonaForRole`, real
 * `*.agent.md` bytes first, hero paraphrase fallback only for the two
 * deterministic hero agents). Members whose persona cannot be resolved are
 * dropped (never a silent wrong persona) — mirrors `resolveRoutedStages`.
 */
export function resolveCouncilMembers(plan: RoutePlan, roots?: string[]): PersonaRecord[] {
  const members: PersonaRecord[] = [];
  for (const agentName of plan.council.members) {
    const persona = resolvePersonaForRole(agentName, roots);
    if (persona) {
      members.push(persona);
    }
  }
  return members;
}

/**
 * Dispatch the council members over the plan artifact and synthesize the
 * verdict. Each member is dispatched independently against the SAME plan
 * artifact (parallel go/no-go, not a pipeline); the plan artifact and the caller
 * request/context are DATA, the member charter is the only AUTHORITY (SEC-5).
 * Returns the structured verdict plus the rendered `## Council Verdict` block.
 */
export async function runCouncil(
  members: PersonaRecord[],
  planArtifact: string,
  request: CoordinatorRequest,
  deps: CouncilDeps,
): Promise<CouncilVerdict> {
  const opinions = await Promise.all(
    members.map(async (member): Promise<CouncilMemberOpinion> => {
      // SEC-5 — member charter is the ONLY authority; plan + caller input are DATA.
      const prompt = composeEmbeddedPrompt({
        systemAuthority: member.charter,
        request: request.request,
        context: request.context,
        priorArtifact: planArtifact,
      });
      const completion = await deps.backend.complete({
        system: prompt.system,
        messages: prompt.messages,
      });
      const parsed = parseMemberVerdict(completion.text);
      return {
        agentName: member.role,
        verdict: parsed.verdict,
        conditions: parsed.conditions,
        text: completion.text,
        backendId: completion.backendId,
        usage: completion.usage,
      };
    }),
  );

  const synth = synthesizeVerdict(opinions);
  const usage = opinions.map((o) => o.usage).filter((u): u is BackendUsage => Boolean(u));
  const markdown = renderVerdict(synth.verdict, synth.conditions, opinions);
  return { verdict: synth.verdict, conditions: synth.conditions, members: opinions, usage, markdown };
}
