/**
 * Operator config — render feature fail-fast rules. A misconfigured render
 * deployment must throw at boot (not at first call): enabling render requires a
 * storage account (the blob artifact store) and the in-image Python interpreter +
 * scripts directory (the build step).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";

const BASE = {
  SQUAD_MCP_AUDIENCE: "api://squad",
  SQUAD_MCP_ALLOWED_ORIGINS: "https://copilotstudio.microsoft.com",
};

test("render disabled by default; keys carry safe defaults", () => {
  const config = loadOperatorConfig({ ...BASE } as NodeJS.ProcessEnv);
  assert.equal(config.enableRenderPptx, false);
  assert.equal(config.renderBlobContainer, "renders");
  assert.equal(config.renderSasTtlMinutes, 60);
});

test("enabling render without a storage account fails fast", () => {
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_ENABLE_RENDER_PPTX: "true",
        SQUAD_MCP_RENDER_PYTHON_PATH: "/opt/render-venv/bin/python3",
        SQUAD_MCP_RENDER_SCRIPTS_DIR: "/app/render/scripts",
      } as NodeJS.ProcessEnv),
    /SQUAD_MCP_STORAGE_ACCOUNT is required/,
  );
});

test("enabling render without python path/scripts dir fails fast", () => {
  assert.throws(
    () =>
      loadOperatorConfig({
        ...BASE,
        SQUAD_MCP_ENABLE_RENDER_PPTX: "true",
        SQUAD_MCP_STORAGE_ACCOUNT: "acct",
      } as NodeJS.ProcessEnv),
    /SQUAD_MCP_RENDER_PYTHON_PATH and SQUAD_MCP_RENDER_SCRIPTS_DIR are required/,
  );
});

test("a fully configured render deployment loads", () => {
  const config = loadOperatorConfig({
    ...BASE,
    SQUAD_MCP_ENABLE_RENDER_PPTX: "true",
    SQUAD_MCP_STORAGE_ACCOUNT: "acct",
    SQUAD_MCP_RENDER_PYTHON_PATH: "/opt/render-venv/bin/python3",
    SQUAD_MCP_RENDER_SCRIPTS_DIR: "/app/render/scripts",
    SQUAD_MCP_RENDER_SAS_TTL_MINUTES: "30",
  } as NodeJS.ProcessEnv);
  assert.equal(config.enableRenderPptx, true);
  assert.equal(config.storageAccount, "acct");
  assert.equal(config.renderSasTtlMinutes, 30);
});
