import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";

const BASE = {
  SQUAD_MCP_AUDIENCE: "api://squad",
  SQUAD_MCP_ALLOWED_ORIGINS: "https://copilotstudio.microsoft.com",
};

test("model API keeps legacy defaults for existing operators", () => {
  const config = loadOperatorConfig(BASE as NodeJS.ProcessEnv);
  assert.equal(config.modelApi, "chat-completions");
  assert.equal(config.modelApiVersion, "2024-10-21");
  assert.equal(config.modelMaxOutputTokens, 1_500);
  assert.equal(config.modelReasoningEffort, undefined);
  assert.equal(config.modelVerbosity, undefined);
});

test("Responses mode gets the reasoning-model output budget", () => {
  const config = loadOperatorConfig({
    ...BASE,
    SQUAD_MCP_MODEL_API: "responses",
    SQUAD_MCP_MODEL_REASONING_EFFORT: "medium",
    SQUAD_MCP_MODEL_VERBOSITY: "medium",
  } as NodeJS.ProcessEnv);
  assert.equal(config.modelApi, "responses");
  assert.equal(config.modelMaxOutputTokens, 32_768);
  assert.equal(config.modelReasoningEffort, "medium");
  assert.equal(config.modelVerbosity, "medium");
});

test("model API and output budget fail fast when invalid", () => {
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_MODEL_API: "assistants",
      } as NodeJS.ProcessEnv),
    /SQUAD_MCP_MODEL_API/,
  );
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_MODEL_API: "responses",
        SQUAD_MCP_MODEL_MAX_OUTPUT_TOKENS: "128001",
      } as NodeJS.ProcessEnv),
    /SQUAD_MCP_MODEL_MAX_OUTPUT_TOKENS/,
  );
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_MODEL_API: "responses",
        SQUAD_MCP_MODEL_REASONING_EFFORT: "extreme",
      } as NodeJS.ProcessEnv),
    /SQUAD_MCP_MODEL_REASONING_EFFORT/,
  );
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_MODEL_REASONING_EFFORT: "medium",
      } as NodeJS.ProcessEnv),
    /require SQUAD_MCP_MODEL_API=responses/,
  );
});
