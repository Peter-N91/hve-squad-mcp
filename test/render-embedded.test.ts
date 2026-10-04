import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbeddedResult } from "../src/engine/embedded.js";
import { renderEmbeddedResult } from "../src/engine/render-embedded.js";
import { responsibleAiBlocker } from "../src/engine/responsible-ai.js";

function denied(overrides: Partial<EmbeddedResult> = {}): EmbeddedResult {
  return {
    kind: "embedded",
    outcome: "denied",
    matchedRouting: {
      routingIntent: "research", role: "Squad Coordinator", tier: "confirm",
      council: [], parallelEligible: false, catchAll: true, gates: true,
    },
    ...overrides,
  };
}

test("policy-blocked status includes a terminal structured receipt and visible legitimate next actions", () => {
  const responsibleAi = responsibleAiBlocker({ status: 400, providerCode: "ContentFiltered" }, "BRD author", "run-1");
  const rendered = renderEmbeddedResult(denied({
    reason: "model_backend_content_policy", runId: "run-1", responsibleAi,
    artifact: "Completed research remains available; draft is unreviewed.",
  }));
  assert.equal(rendered.isError, true);
  assert.deepEqual(rendered.structuredContent?.responsibleAi, responsibleAi);
  assert.equal(rendered.structuredContent?.reason, "model_backend_content_policy");
  assert.match(rendered.content[0].text, /Responsible-AI block/);
  assert.match(rendered.content[0].text, /Direction: unknown/);
  assert.match(rendered.content[0].text, /cannot be resumed by acknowledgment/);
  assert.match(rendered.content[0].text, /Completed research remains available/);
  assert.doesNotMatch(rendered.content[0].text, /squad_respond/);
});

for (const reason of [
  "checkpoint_persistence_failed", "stage_artifact_gate", "stage_deadline",
  "stage_review_gate", "run_cost_ceiling", "worker_review_failed", "future_failure",
]) {
  test(`post-dispatch ${reason} without an artifact never claims zero model calls`, () => {
    const rendered = renderEmbeddedResult(denied({ reason, runId: "run-1" }));
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /did not complete successfully/);
    assert.ok(rendered.content[0].text.includes(reason));
    assert.doesNotMatch(rendered.content[0].text, /No model call was made/);
  });
}

for (const reason of [
  "concurrency_cap", "cost_ceiling", "held_run_cap",
  "role_not_embedded_in_thin_slice", "role_not_resolvable",
]) {
  test(`known pre-dispatch ${reason} retains the guaranteed zero-call explanation`, () => {
    const rendered = renderEmbeddedResult(denied({ reason }));
    assert.equal(rendered.isError, true);
    assert.match(rendered.content[0].text, /No model call was made/);
  });

  test(`${reason} for an existing run does not erase prior execution`, () => {
    const rendered = renderEmbeddedResult(denied({ reason, runId: "run-1" }));
    assert.equal(rendered.isError, true);
    assert.doesNotMatch(rendered.content[0].text, /No model call was made/);
  });
}

for (const reason of [undefined, "future_failure", "run_not_found_or_cross_tenant"]) {
  test(`unclassified denial (${reason}) does not invent model execution history`, () => {
    const rendered = renderEmbeddedResult(denied({ reason }));
    assert.equal(rendered.isError, true);
    assert.doesNotMatch(rendered.content[0].text, /No model call was made/);
  });
}

test("an empty artifact still prevents a zero-call claim", () => {
  const rendered = renderEmbeddedResult(denied({ reason: "cost_ceiling", artifact: "" }));
  assert.doesNotMatch(rendered.content[0].text, /No model call was made/);
});

test("failed-run and partial-artifact wording remains intact", () => {
  const failed = renderEmbeddedResult(denied({ reason: "run_failed", runId: "run-1" }));
  assert.match(failed.content[0].text, /stopped \(run_failed\).*did not complete successfully/);
  const partial = renderEmbeddedResult(denied({
    reason: "worker_review_failed", runId: "run-1", artifact: "Partial research evidence",
  }));
  assert.equal(partial.isError, true);
  assert.match(partial.content[0].text, /stopped \(worker_review_failed\).*did not complete successfully/);
  assert.ok(partial.content[0].text.includes("Partial research evidence"));
  assert.doesNotMatch(partial.content[0].text, /No model call was made/);
});

for (const policy of [false, true]) {
  test(`${policy ? "policy" : "historical"} failure puts the receipt before large artifacts for text-only hosts`, () => {
    const artifact = "PRESERVED-DRAFT-" + "x".repeat(180_000);
    const rendered = renderEmbeddedResult(denied({
      reason: policy ? "model_backend_content_policy" : "run_failed",
      runId: "run-with-large-draft",
      artifact,
      responsibleAi: policy ? responsibleAiBlocker({ status: 400 }, "unknown", "run-with-large-draft") : undefined,
    }));
    assert.equal(rendered.structuredContent?.outcome, "denied");
    assert.equal(rendered.structuredContent?.runId, "run-with-large-draft");
    const firstWindow = rendered.content[0].text.slice(0, 4096);
    assert.match(firstWindow, /## machine-readable/);
    assert.match(firstWindow, /"runId": "run-with-large-draft"/);
    assert.ok(rendered.content[0].text.indexOf("## machine-readable") <
      rendered.content[0].text.indexOf("PRESERVED-DRAFT-"));
    assert.ok(rendered.content[0].text.endsWith(artifact));
    if (!policy) assert.equal(rendered.structuredContent?.responsibleAi, undefined);
  });
}
