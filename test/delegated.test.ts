import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { DelegatedCoordinator } from "../src/engine/delegated.js";
import type { SquadMemoryEntry, SquadMemoryStore } from "../src/engine/squad-memory-state.js";

const catalog = loadCatalog();
const engine = new DelegatedCoordinator();

function byId(id: string): CatalogTool {
  const tool = catalog.tools.find((t) => t.id === id);
  assert.ok(tool, `catalog defines ${id}`);
  return tool;
}

test("the delegated engine reports delegated mode (runs no model)", () => {
  assert.equal(engine.mode, "delegated");
});

test("squad_research returns the persona + routing + framedRequest contract", async () => {
  const tool = byId("squad_research");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Research caching options for our API",
  });

  assert.equal(result.kind, "delegated");
  // systemPrompt carries the Coordinator persona and Dispatch Discipline.
  assert.match(result.systemPrompt, /Squad Coordinator/);
  assert.match(result.systemPrompt, /Dispatch Discipline/);
  // matchedRouting reflects the catalog row.
  assert.equal(result.matchedRouting.role, "Task Researcher");
  assert.equal(result.matchedRouting.routingIntent, "research, investigate, explore, find out");
  assert.equal(result.matchedRouting.tier, "auto");
  assert.equal(result.matchedRouting.parallelEligible, true);
  // framedRequest names the role and carries the request verbatim.
  assert.match(result.framedRequest, /Task Researcher/);
  assert.match(result.framedRequest, /Research caching options for our API/);
  // stateContext points at the squad state root.
  assert.match(result.stateContext, /\.copilot-tracking\/squad\//);
});

test("squad_run frames the full pipeline and carries gates + mode", async () => {
  const tool = byId("squad_run");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Build feature X end to end",
    mode: "autopilot",
  });

  assert.equal(result.matchedRouting.catchAll, true);
  assert.equal(result.matchedRouting.gates, true);
  assert.match(result.systemPrompt, /Implementation Gate/);
  assert.match(result.systemPrompt, /autopilot/);
  assert.match(result.framedRequest, /classify this request/);
  assert.match(result.framedRequest, /Build feature X end to end/);
});

test("squad_review surfaces the council members and gate context", async () => {
  const tool = byId("squad_review");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Pre-implementation go/no-go for the design",
  });

  assert.ok(result.matchedRouting.council.includes("Security Planner"));
  assert.ok(result.matchedRouting.council.includes("System Architecture Reviewer"));
  assert.match(result.systemPrompt, /Implementation Gate/);
  assert.match(result.framedRequest, /council/i);
});

test("context is appended to the framed request when provided", async () => {
  const tool = byId("squad_research");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Research options",
    context: "Constraint: must stay on the current Node LTS.",
  });
  assert.match(result.framedRequest, /Constraint: must stay on the current Node LTS\./);
});

/**
 * A minimal in-memory {@link SquadMemoryStore} for the Step 4.1 digest tests:
 * it holds a single `local` tenant partition so the delegated coordinator (which
 * reads under the {@link LOCAL_MEMORY_TENANT} default) can surface a digest.
 */
class StubMemoryStore implements SquadMemoryStore {
  constructor(private readonly entries: SquadMemoryEntry[]) {}
  async list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    return this.entries.filter((e) => e.tenantId === tenantId && e.project === project);
  }
  async read(): Promise<SquadMemoryEntry | undefined> {
    return undefined;
  }
  async write(): Promise<never> {
    throw new Error("not used in these tests");
  }
  async listProjects(tenantId: string): Promise<string[]> {
    return [...new Set(this.entries.filter((e) => e.tenantId === tenantId).map((e) => e.project))];
  }
}

function memEntry(project: string, path: string, content: string): SquadMemoryEntry {
  return { tenantId: "local", project, path, content, etag: "e", updatedAt: 0 };
}

test("Step 4.1: with no store the stateContext is byte-identical to the default", async () => {
  const tool = byId("squad_research");
  const request = { toolId: tool.id, request: "Research caching" };
  // An engine constructed with an explicitly-absent store, and one backed by a
  // store that holds NO prior entries, must both match the default engine exactly.
  const explicitNone = new DelegatedCoordinator({ memoryStore: undefined });
  const emptyStore = new DelegatedCoordinator({ memoryStore: new StubMemoryStore([]) });

  const base = (await engine.handle(tool, request)).stateContext;
  assert.equal((await explicitNone.handle(tool, request)).stateContext, base);
  assert.equal((await emptyStore.handle(tool, request)).stateContext, base);
  assert.doesNotMatch(base, /prior context/);
});

test("Step 4.1: an injected store with prior entries adds a bounded prior-context digest", async () => {
  const tool = byId("squad_research");
  const store = new StubMemoryStore([
    memEntry("acme", "decisions", ["d1", "d2", "d3", "d4", "d5", "d6", "latest-decision"].join("\n")),
    memEntry("acme", "history/architect", "old line\nnewest architect line"),
  ]);
  const withStore = new DelegatedCoordinator({ memoryStore: store });

  const result = await withStore.handle(tool, { toolId: tool.id, request: "Research caching" });
  // The base lines are preserved verbatim, then the digest is appended.
  assert.match(result.stateContext, /- squad state root: `\.copilot-tracking\/squad\/`/);
  assert.match(result.stateContext, /- prior context \(bounded digest from shared squad memory\):/);
  assert.match(result.stateContext, /- project `acme`:/);
  // Bounded: only the last PRIOR_DECISIONS_LIMIT (5) decision lines survive.
  assert.match(result.stateContext, /- decision: latest-decision/);
  assert.doesNotMatch(result.stateContext, /- decision: d1\b/);
  // Latest per-agent history line only.
  assert.match(result.stateContext, /- history\/architect: newest architect line/);
  assert.doesNotMatch(result.stateContext, /old line/);
});
