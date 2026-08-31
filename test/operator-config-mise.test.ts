import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";

const BASE = {
  SQUAD_MCP_AUDIENCE: "api://squad",
  SQUAD_MCP_ALLOWED_ORIGINS: "https://copilotstudio.microsoft.com",
};

test("MISE verification is opt-in with a fail-closed loopback default", () => {
  const disabled = loadOperatorConfig(BASE as NodeJS.ProcessEnv);
  assert.deepEqual(disabled.mise, {
    enabled: false,
    endpoint: "http://127.0.0.1:5000/ValidateRequest",
    timeoutMs: 10_000,
  });

  const enabled = loadOperatorConfig({
    ...BASE,
    SQUAD_MCP_MISE_ENABLED: "true",
    SQUAD_MCP_MISE_TIMEOUT_MS: "2500",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(enabled.mise, {
    enabled: true,
    endpoint: "http://127.0.0.1:5000/ValidateRequest",
    timeoutMs: 2_500,
  });
});

test("MISE configuration rejects token-forwarding endpoints outside the pod-local sidecar", () => {
  for (const endpoint of [
    "https://127.0.0.1:5000/ValidateRequest",
    "http://mise.example:5000/ValidateRequest",
    "http://127.0.0.1:5000/not-validation",
  ]) {
    assert.throws(
      () =>
        loadOperatorConfig({
          ...BASE,
          SQUAD_MCP_MISE_ENABLED: "true",
          SQUAD_MCP_MISE_ENDPOINT: endpoint,
        } as NodeJS.ProcessEnv),
      /loopback MISE sidecar/,
    );
  }
});

test("MISE timeout is bounded even while the feature is disabled", () => {
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_MISE_TIMEOUT_MS: "60001",
      } as NodeJS.ProcessEnv),
    /SQUAD_MCP_MISE_TIMEOUT_MS/,
  );
});
