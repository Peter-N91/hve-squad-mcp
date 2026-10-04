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
  assert.equal(config.modelChatProfile, "standard");
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
    /SQUAD_MCP_MODEL_CHAT_PROFILE/,
  );
});

test("operator-selected Chat profiles enable compatible reasoning without deployment-name inference", () => {
  for (const profile of ["reasoning", "gpt-5.6"]) {
    const config = loadOperatorConfig({
      ...BASE,
      SQUAD_MCP_MODEL_DEPLOYMENT: "arbitrary-production-alias",
      SQUAD_MCP_MODEL_CHAT_PROFILE: profile,
      SQUAD_MCP_MODEL_REASONING_EFFORT: "medium",
    });
    assert.equal(config.modelChatProfile, profile);
    assert.equal(config.modelReasoningEffort, "medium");
  }
  assert.equal(loadOperatorConfig({
    ...BASE, SQUAD_MCP_MODEL_DEPLOYMENT: "gpt-5.6-sol",
  }).modelChatProfile, "standard");
});

test("incompatible Chat configuration fails before startup without changing Responses configuration", () => {
  for (const settings of [
    { SQUAD_MCP_MODEL_CHAT_PROFILE: "guess-from-alias" },
    { SQUAD_MCP_MODEL_CHAT_PROFILE: "reasoning-no-effort", SQUAD_MCP_MODEL_REASONING_EFFORT: "medium" },
    { SQUAD_MCP_MODEL_CHAT_PROFILE: "gpt-5.6", SQUAD_MCP_MODEL_REASONING_EFFORT: "minimal" },
    { SQUAD_MCP_MODEL_CHAT_PROFILE: "gpt-5.6", SQUAD_MCP_MODEL_REASONING_EFFORT: "max" },
    { SQUAD_MCP_MODEL_VERBOSITY: "medium" },
  ]) {
    assert.throws(() => loadOperatorConfig({ ...BASE, ...settings }), /SQUAD_MCP_MODEL_/);
  }
  const config = loadOperatorConfig({
    ...BASE, SQUAD_MCP_MODEL_API: "responses",
    SQUAD_MCP_MODEL_REASONING_EFFORT: "max", SQUAD_MCP_MODEL_VERBOSITY: "medium",
  });
  assert.equal(config.modelReasoningEffort, "max");
  assert.equal(config.modelChatProfile, "standard");
});
