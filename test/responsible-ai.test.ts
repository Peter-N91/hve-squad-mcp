import assert from "node:assert/strict";
import { test } from "node:test";
import { contentPolicyDetails, responsibleAiBlocker, responsibleAiMessage } from "../src/engine/responsible-ai.js";
import type { ContentPolicyDetails } from "../src/engine/responsible-ai.js";
import { ModelBackendError } from "../src/engine/model-backend.js";

test("policy metadata allows only known categories, booleans, severity enums and correlation identifiers", () => {
  const details = contentPolicyDetails({
    violence: { filtered: true, severity: "medium", message: "private prompt" },
    hate: { filtered: false, severity: "safe", detected: false },
    sexual: { severity: "private prompt", filtered: "true" },
    private_category: { filtered: true, severity: "high" },
    jailbreak: { detected: true, source: "private prompt" },
  }, "prompt", "request_12345678");
  assert.deepEqual(details, {
    direction: "prompt",
    categories: [
      { name: "hate", filtered: false, detected: false, severity: "safe" },
      { name: "violence", filtered: true, severity: "medium" },
      { name: "jailbreak", detected: true },
    ],
    providerRequestId: "request_12345678",
  });
  assert.doesNotMatch(JSON.stringify(details), /private/);
  assert.deepEqual(contentPolicyDetails(undefined, "unknown", "Bearer private token"), {
    direction: "unknown", categories: [],
  });
});

test("terminal policy blocker is not a human acknowledgment gate and never invents absent metadata", () => {
  const blocker = responsibleAiBlocker(
    new ModelBackendError("content_policy", { status: 400, providerCode: "ContentFiltered" }),
    "BRD author", "run-123",
  );
  assert.equal(blocker.cause, "provider_content_policy");
  assert.equal(blocker.direction, "unknown");
  assert.deepEqual(blocker.categories, []);
  assert.equal(blocker.providerRequestId, undefined);
  assert.equal(blocker.providerStatus, 400);
  assert.equal(blocker.providerCode, "ContentFiltered");
  assert.equal(blocker.runId, "run-123");
  assert.equal(blocker.stage, "BRD author");
  assert.equal(blocker.terminal, true);
  assert.equal(blocker.sameRunResumable, false);
  assert.equal(blocker.acknowledgmentCanOverride, false);
  assert.match(responsibleAiMessage(blocker), /Categories\/severity: not provided/);
  assert.match(responsibleAiMessage(blocker), /cannot be resumed by acknowledgment/);
  assert.match(responsibleAiMessage(blocker), /exact triggering text is not identified/);
  assert.match(responsibleAiMessage(blocker), /explicitly requesting new work, stop, or escalate/);
});

test("unallowlisted error identifiers and provider message properties do not enter the public policy receipt", () => {
  const error = new ModelBackendError("content_policy", { status: 999, providerCode: "private-provider-detail" });
  const blocker = responsibleAiBlocker(error);
  assert.equal(blocker.providerStatus, undefined);
  assert.equal(blocker.providerCode, undefined);
  assert.doesNotMatch(JSON.stringify(blocker), /private-provider-detail/);
});

test("malformed optional policy metadata is ignored rather than replacing the original blocker with an exception", () => {
  for (const categories of [null, "private text", {}, [null, "private text", { name: "unknown", filtered: true }]]) {
    const contentPolicy = {
      categories, direction: "private text", providerRequestId: { secret: "private text" },
    } as unknown as ContentPolicyDetails;
    const blocker = responsibleAiBlocker({ status: 400, providerCode: "ContentFiltered", contentPolicy });
    assert.equal(blocker.direction, "unknown");
    assert.deepEqual(blocker.categories, []);
    assert.equal(blocker.providerRequestId, undefined);
    assert.doesNotMatch(JSON.stringify(blocker), /private text/);
  }
});
