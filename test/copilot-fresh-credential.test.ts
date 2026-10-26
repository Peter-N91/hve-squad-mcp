import assert from "node:assert/strict";
import { test } from "node:test";
import { handleQuotaVerificationFailure } from "../src/engine/copilot/copilot-sdk-client.js";
import { CopilotRuntimeUnavailableError } from "../src/engine/copilot/copilot-credentials.js";

test("a revoked credential is authoritative even if the SDK still returns cached models", () => {
  const revoked = new Error('Request account.getQuota failed: 401 Unauthorized: {"message":"Bad credentials"}');
  for (const strict of [true, false]) {
    assert.throws(() => handleQuotaVerificationFailure(revoked, strict), error => error === revoked);
  }
});

test("user mode refuses unavailable fresh proof instead of returning a cached success", () => {
  for (const failure of [new Error("429 rate limited"), new Error("socket closed"), new Error("quota endpoint unavailable")]) {
    assert.throws(() => handleQuotaVerificationFailure(failure, true),
      error => error instanceof CopilotRuntimeUnavailableError && !error.message.includes(failure.message));
    assert.doesNotThrow(() => handleQuotaVerificationFailure(failure, false),
      "legacy explicitly selected service mode retains informational quota behavior");
  }
});
