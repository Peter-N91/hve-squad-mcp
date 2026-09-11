import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";

const KEY = randomBytes(32).toString("base64");
const BASE = {
  SQUAD_MCP_AUDIENCE: "api://squad",
  SQUAD_MCP_ALLOWED_ORIGINS: "https://copilotstudio.microsoft.com",
};

function enabled(overrides: NodeJS.ProcessEnv = {}) {
  return loadOperatorConfig({
    ...BASE,
    SQUAD_MCP_STORAGE_ACCOUNT: "squadstorage",
    SQUAD_MCP_SIMPLE_OAUTH_ENABLED: "true",
    SQUAD_MCP_SIMPLE_OAUTH_EXTERNAL_URL: "https://squad.example",
    SQUAD_MCP_SIMPLE_OAUTH_SIGNING_KEYS_B64: KEY,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

test("simple OAuth is opt-in and leaves existing audiences unchanged by default", () => {
  const config = loadOperatorConfig(BASE as NodeJS.ProcessEnv);
  assert.equal(config.simpleOAuth.enabled, false);
  assert.deepEqual(config.audiences, ["api://squad"]);
});

test("enabled simple OAuth adds its local issuer/audience and validates its key", () => {
  const config = enabled({
    SQUAD_MCP_ALLOWED_ISSUERS: "https://login.microsoftonline.com/tenant/v2.0",
    SQUAD_MCP_ALLOWED_TENANTS: "11111111-1111-4111-8111-111111111111",
    SQUAD_MCP_SIMPLE_OAUTH_ALLOWED_SCOPES: "Squad.Run,Squad.Memory",
  });

  assert.equal(config.simpleOAuth.enabled, true);
  assert.deepEqual(config.simpleOAuth.allowedScopes, ["Squad.Run", "Squad.Memory"]);
  assert.ok(config.audiences.includes("https://squad.example/mcp"));
  assert.ok(config.allowedIssuers.includes("https://squad.example"));
});

test("simple OAuth preserves an empty Entra issuer allow-list instead of making it local-only", () => {
  const config = enabled();
  assert.deepEqual(config.allowedIssuers, []);
  assert.ok(config.audiences.includes("https://squad.example/mcp"));
});

test("enabled simple OAuth fails fast without storage, origin, or a 32-byte key", () => {
  assert.throws(
    () =>
      enabled({
        SQUAD_MCP_STORAGE_ACCOUNT: "",
      }),
    /SQUAD_MCP_STORAGE_ACCOUNT/,
  );
  assert.throws(
    () =>
      enabled({
        SQUAD_MCP_SIMPLE_OAUTH_EXTERNAL_URL: "http://squad.example/path",
      }),
    /absolute HTTPS origin/,
  );
  assert.throws(
    () =>
      enabled({
        SQUAD_MCP_SIMPLE_OAUTH_SIGNING_KEYS_B64: Buffer.from("short").toString("base64"),
      }),
    /decode to 32 bytes/,
  );
});

test("simple OAuth refuses unknown scopes and the operator approval role", () => {
  assert.throws(
    () =>
      enabled({
        SQUAD_MCP_SIMPLE_OAUTH_ALLOWED_SCOPES: "Squad.Run,Squad.Operate",
      }),
    /unknown or forbidden scopes: Squad\.Operate/,
  );
  assert.throws(
    () =>
      enabled({
        SQUAD_MCP_SIMPLE_OAUTH_ALLOWED_SCOPES: "Squad.Run,Squad.NotReal",
      }),
    /unknown or forbidden scopes: Squad\.NotReal/,
  );
});
