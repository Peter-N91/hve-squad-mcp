import { createHash } from "node:crypto";
import type { SquadArtifactStore } from "../artifact-store.js";
import { UpstreamBundle } from "./upstream-bundle.js";
import { parseUpstreamRouting, type UpstreamRoutingSelection } from "./upstream-coordinator.js";

const ROOT = ".copilot-tracking/squad";
const BINDING = `${ROOT}/runtime-binding.json`;
export type ProjectRuntimeBinding = { runtime: "native" } |
  { runtime: "upstream"; commit: string; schemaVersion: "1.4"; routing: UpstreamRoutingSelection };

/** Never changes an existing native project's schema merely because the operator enabled upstream. */
export async function inspectProjectRuntime(store: SquadArtifactStore, tenantId: string, project: string, bundle: UpstreamBundle): Promise<ProjectRuntimeBinding | "uninitialized"> {
  const binding = await store.get(tenantId, project, BINDING);
  if (binding) {
    const value: unknown = JSON.parse(binding.content);
    if (!value || typeof value !== "object" || !("runtime" in value)) throw new Error("Project runtime binding is malformed.");
    if (value.runtime === "native") return { runtime: "native" };
    if (value.runtime !== "upstream" || !("commit" in value) || value.commit !== bundle.identity.sourceCommit || !("schemaVersion" in value) || value.schemaVersion !== "1.4") throw new Error("Existing upstream project requires an explicit verified version migration.");
    const routing = "routing" in value ? parseUpstreamRouting(value.routing) : { mode: "economy" as const };
    return { runtime: "upstream", commit: value.commit, schemaVersion: "1.4", routing };
  }
  if (await store.get(tenantId, project, `${ROOT}/runtime-initialization.json`)) {
    throw new Error("Incomplete upstream initialization requires explicit recovery; it cannot fall back to native execution.");
  }
  const state = await store.get(tenantId, project, `${ROOT}/state.json`);
  if (state && JSON.parse(state.content).schemaVersion === "1.4") {
    throw new Error("Unbound upstream schema 1.4 requires explicit verified migration, not native fallback.");
  }
  if (await store.get(tenantId, project, `${ROOT}/team.md`) || state) return { runtime: "native" };
  return "uninitialized";
}

export function upstreamStateTemplate(bundle: UpstreamBundle, mode: "interactive" | "autopilot" | "autonomous", now: string): string {
  const entry = bundle.read(".github/skills/squad/references/entry-schemas.md", 123, 60).content;
  const match = /```json\n([\s\S]*?)\n```/.exec(entry);
  if (!match) throw new Error("Upstream schema 1.4 seed template is unavailable.");
  const state = JSON.parse(match[1]) as { schemaVersion: string; updated: string; mode: string };
  if (state.schemaVersion !== "1.4") throw new Error("Unrecognized upstream state template.");
  state.updated = now;
  state.mode = mode;
  return JSON.stringify(state, null, 2) + "\n";
}

/** Prepared seed transaction with exact provenance; caller must supply confirmed roster and CAS storage. */
export function upstreamSeedFiles(bundle: UpstreamBundle, roster: string, mode: "interactive" | "autopilot" | "autonomous", now: string,
  routing: UpstreamRoutingSelection = { mode: "economy" }): Map<string, string> {
  parseUpstreamRouting(routing);
  if (!new RegExp(`^Model routing: ${routing.mode}$`, "m").test(roster) || !/\| Role \|/.test(roster)) throw new Error("Upstream seed requires a confirmed routing roster.");
  return new Map([
    [`${ROOT}/team.md`, roster],
    [`${ROOT}/state.json`, upstreamStateTemplate(bundle, mode, now)],
    [`${ROOT}/decisions.md`, "# Decisions\n"],
    [`${ROOT}/notifications.md`, "# Notifications\n"],
    [BINDING, JSON.stringify({ runtime: "upstream", commit: bundle.identity.sourceCommit, schemaVersion: "1.4", routing, rosterSha256: createHash("sha256").update(roster).digest("hex") }, null, 2) + "\n"],
  ]);
}
