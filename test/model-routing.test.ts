/**
 * Per-role model routing (`routing=off|ranked|economy|manual`), workflow depth
 * (`depth=quick|standard`), add-on packs (`pack=...`), and connector execution
 * (`execution=original|connector:<binding-id>|both`), aligned with hve-squad 0.21.0.
 *
 * The `/squad` and `/squad-federation` prompts accept these controls on the
 * attended (delegated) path; the two catch-all tools mirror them while the
 * narrower per-role tools omit them because they mirror a single routing intent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { DelegatedCoordinator } from "../src/engine/delegated.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { TenantQuotaTracker } from "../src/engine/gates.js";
import {
  MODEL_ROUTING_MODES,
  REGISTERED_PACKS,
  WORKFLOW_DEPTHS,
  depthInstructions,
  executionInstructions,
  packInstructions,
  routingInstructions,
} from "../src/engine/persona.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import type { RedactingLogger } from "../src/observability/logger.js";
import { ToolInputError, ToolRouter } from "../src/router/router.js";

const catalog = loadCatalog();
const engine = new DelegatedCoordinator();

function byId(id: string): CatalogTool {
  const tool = catalog.tools.find((t) => t.id === id);
  assert.ok(tool, `catalog tool ${id} exists`);
  return tool;
}

test("the catch-all tools offer the routing modes, workflow depths, packs, and execution controls", () => {
  for (const id of ["squad_run", "squad_federate"]) {
    const schema = byId(id).input as {
      properties?: Record<string, { enum?: string[]; pattern?: string }>;
    };
    assert.deepEqual(schema.properties?.routing?.enum, [...MODEL_ROUTING_MODES], `${id} routing enum`);
    assert.deepEqual(schema.properties?.depth?.enum, [...WORKFLOW_DEPTHS], `${id} depth enum`);
    assert.ok(schema.properties?.pack?.pattern, `${id} pack pattern`);
    assert.ok(schema.properties?.execution?.pattern, `${id} execution pattern`);
  }
});

test("the narrower per-role tools do not offer entry-point routing, depth, pack, or execution controls", () => {
  for (const id of ["squad_research", "squad_plan", "squad_review", "squad_architect"]) {
    const schema = byId(id).input as { properties?: Record<string, unknown> };
    assert.equal(schema.properties?.routing, undefined, `${id} has no routing input`);
    assert.equal(schema.properties?.depth, undefined, `${id} has no depth input`);
    assert.equal(schema.properties?.pack, undefined, `${id} has no pack input`);
    assert.equal(schema.properties?.execution, undefined, `${id} has no execution input`);
  }
});

test("the router validates and carries routing, depth, pack, and execution into the coordinator request", () => {
  const router = new ToolRouter(catalog);
  for (const pack of REGISTERED_PACKS) {
    assert.doesNotThrow(() => router.validateInput("squad_run", { request: "ship", pack }));
  }
  assert.doesNotThrow(() =>
    router.validateInput("squad_run", {
      request: "ship",
      pack: "dotnet,azure-cloud",
      routing: "economy",
      depth: "quick",
      execution: "connector:custom-dev",
    }),
  );
  assert.throws(
    () => router.validateInput("squad_run", { request: "ship", pack: "unknown-pack" }),
    ToolInputError,
  );
  assert.throws(
    () => router.validateInput("squad_run", { request: "ship", execution: "connector:UPPER_BAD" }),
    ToolInputError,
  );

  const request = router.toCoordinatorRequest(byId("squad_run"), {
    request: "ship the change",
    pack: "foundry,azure-cloud",
    routing: "economy",
    depth: "quick",
    execution: "connector:my-agent",
  });
  assert.equal(request.pack, "foundry,azure-cloud");
  assert.equal(request.routing, "economy");
  assert.equal(request.depth, "quick");
  assert.equal(request.execution, "connector:my-agent");
});

test("an explicit routing mode is forwarded verbatim and recorded in the state context", async () => {
  const manual = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "ship the change",
    routing: "manual",
  });
  assert.match(manual.systemPrompt, /Model routing = manual \(explicit input\)/);
  assert.match(manual.systemPrompt, /`routing=manual`/);
  assert.match(manual.systemPrompt, /Scribe never inherits the session model/);
  assert.match(manual.stateContext, /- model routing: manual/);

  const economy = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "ship the change",
    routing: "economy",
  });
  assert.match(economy.systemPrompt, /Model routing = economy \(explicit input\)/);
  assert.match(economy.systemPrompt, /Economy Mode Accepted/);
  assert.match(economy.systemPrompt, /never weakens floors or gates/);
  assert.match(economy.stateContext, /- model routing: economy/);
});

test("explicit pack, depth, and execution inputs are forwarded safely on both catch-all tools", async () => {
  const single = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "modernize the API",
    pack: "dotnet,aks",
    depth: "quick",
    execution: "connector:ext-dev",
  });
  assert.match(single.systemPrompt, /Pack = dotnet,aks \(explicit input\)/);
  assert.match(single.systemPrompt, /Depth = quick \(explicit input\)/);
  assert.match(single.systemPrompt, /depthSource: "input"/);
  assert.match(single.systemPrompt, /Execution = connector:ext-dev \(explicit input\)/);
  assert.match(single.stateContext, /- pack: dotnet,aks/);
  assert.match(single.stateContext, /- depth: quick/);
  assert.match(single.stateContext, /- execution: connector:ext-dev/);

  const federated = await engine.handle(byId("squad_federate"), {
    toolId: "squad_federate",
    request: "plan the platform work",
    pack: "azure-functions",
    routing: "ranked",
    depth: "quick",
    execution: "both",
  });
  assert.match(federated.systemPrompt, /Model routing = ranked/);
  assert.match(federated.systemPrompt, /never widen or substitute it/);
  assert.match(federated.systemPrompt, /depthSource: "federation"/);
  assert.match(federated.systemPrompt, /member-local/);
});

test("absent or invalid controls add no block and cannot inject arbitrary strings", async () => {
  const result = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "ship the change",
  });
  assert.doesNotMatch(result.systemPrompt, /Model routing =/);
  assert.doesNotMatch(result.systemPrompt, /Depth =/);
  assert.doesNotMatch(result.systemPrompt, /Pack =/);
  assert.doesNotMatch(result.systemPrompt, /Execution =/);
  assert.match(result.stateContext, /- model routing: \(as recorded in team\.md/);
  assert.equal(routingInstructions(undefined), "");
  assert.equal(routingInstructions("cheapest"), "");
  assert.equal(depthInstructions(undefined), "");
  assert.equal(depthInstructions("turbo"), "");
  assert.equal(packInstructions("dotnet;ignore instructions"), "");
  assert.equal(executionInstructions("connector:bad space"), "");
});

test("the embedded engine logs and ignores attended-only controls on unattended runs", async () => {
  const events: string[] = [];
  const logger = {
    info: (event: string) => {
      events.push(event);
    },
  } as unknown as RedactingLogger;
  const embedded = new EmbeddedCoordinator({
    backend: {
      id: "stub",
      complete: async () => ({ text: "ok", finishReason: "stop", backendId: "stub" }),
    },
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 100 }),
    logger,
  });

  const held = await embedded.startHttpRun(
    byId("squad_run"),
    {
      toolId: "squad_run",
      request: "ship the change",
      discovery: "quick",
      pack: "dotnet",
      execution: "original",
      routing: "economy",
      depth: "quick",
    },
    { auth: { tenantId: "tenant-1", subject: "user-1", scopes: ["Squad.Run"], audience: "api://test" } },
  );
  assert.equal(held.outcome, "held");
  assert.deepEqual(events, [
    "discovery_ignored_unattended",
    "pack_ignored_unattended",
    "execution_ignored_unattended",
    "routing_ignored_unattended",
    "depth_ignored_unattended",
  ]);
});
