import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { ToolCatalog } from "../src/catalog/catalog.js";
import {
  buildDescriptor,
  loadGeneratorInputs,
  validateCatalog,
} from "../generators/build-manifests.js";
import { packageRoot } from "../src/paths.js";
import { SERVER_VERSION } from "../src/server.js";

function clone(catalog: ToolCatalog): ToolCatalog {
  return JSON.parse(JSON.stringify(catalog)) as ToolCatalog;
}

const inputs = loadGeneratorInputs();

test("the drift check passes on the real catalog and deployed cast", () => {
  const errors = validateCatalog(inputs.catalog, inputs.routingRows, inputs.knownAgents);
  assert.deepEqual(errors, []);
});

// `serverInfo.version` is what a host reports and an operator quotes in a support
// thread, so a stale constant is a real (if quiet) defect: it had drifted from the
// package version for several releases because the bump workflow moved two of the
// three files that carry it. The runtime image ships no package.json, so the
// constant cannot be read from disk — this check is the guarantee instead, and
// `npm run version:set` is the one writer that keeps all three in step.
test("the release version is identical in package.json, the lockfile, and SERVER_VERSION", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
    version: string;
  };
  const lock = JSON.parse(readFileSync(join(packageRoot(), "package-lock.json"), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.equal(
    SERVER_VERSION,
    pkg.version,
    "src/server.ts SERVER_VERSION disagrees with package.json — run `npm run version:set`",
  );
  assert.equal(
    lock.version,
    pkg.version,
    "package-lock.json disagrees with package.json — run `npm run version:set`",
  );
  assert.equal(
    lock.packages[""].version,
    pkg.version,
    "the lockfile root package entry disagrees with package.json — run `npm run version:set`",
  );
});

test("known agents resolve the mapped roles and council members", () => {
  assert.ok(inputs.knownAgents.has("Squad Researcher"));
  assert.ok(inputs.knownAgents.has("Squad Lead"));
  assert.ok(inputs.knownAgents.has("Squad Reviewer"));
  assert.ok(inputs.knownAgents.has("System Architecture Reviewer"));
  assert.ok(inputs.knownAgents.has("Squad Coordinator"));
  assert.ok(inputs.knownAgents.has("Security Planner"));
});

test("the drift check FAILS when a tool maps to a nonexistent agent", () => {
  const mutated = clone(inputs.catalog);
  mutated.tools[0].role = "Nonexistent Agent ZZZ";
  const errors = validateCatalog(mutated, inputs.routingRows, inputs.knownAgents);
  assert.ok(errors.length > 0, "a drift error is reported");
  assert.ok(
    errors.some((message) => /Nonexistent Agent ZZZ/.test(message)),
    "the error names the missing agent",
  );
});

test("the drift check FAILS when a tool maps to a nonexistent routing intent", () => {
  const mutated = clone(inputs.catalog);
  const firstNonCatchAll = mutated.tools.find((tool) => !tool.catchAll);
  assert.ok(firstNonCatchAll, "there is a non-catch-all tool to mutate");
  firstNonCatchAll.routingIntent = "totally bogus intent zzz";
  const errors = validateCatalog(mutated, inputs.routingRows, inputs.knownAgents);
  assert.ok(
    errors.some((message) => /does not match any routing row/.test(message)),
    "the error reports the missing routing intent",
  );
});

test("the drift check FAILS when a council member is not installed", () => {
  const mutated = clone(inputs.catalog);
  const reviewTool = mutated.tools.find((tool) => tool.id === "squad_review");
  assert.ok(reviewTool, "squad_review exists");
  reviewTool.council.push("Ghost Council Member");
  const errors = validateCatalog(mutated, inputs.routingRows, inputs.knownAgents);
  assert.ok(errors.some((message) => /Ghost Council Member/.test(message)));
});

test("buildDescriptor projects exactly the 6 catalog tools", () => {
  const descriptor = buildDescriptor(inputs.catalog);
  assert.equal(descriptor.tools.length, 6);
  assert.deepEqual(
    descriptor.tools.map((tool) => tool.name).sort(),
    ["squad_architect", "squad_federate", "squad_plan", "squad_research", "squad_review", "squad_run"],
  );
  for (const tool of descriptor.tools) {
    assert.equal(typeof tool.routing.role, "string");
    assert.ok(tool.routing.role.length > 0);
  }
});
