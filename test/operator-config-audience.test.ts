/**
 * Operator config — SQUAD_MCP_AUDIENCE parsing (SEC-1, RFC 8707).
 *
 * The value is comma-separated so one deployment can serve several front doors,
 * each minting tokens for its own resource identifier. Parsing is security
 * relevant in one specific way: a blank entry must never survive, because an
 * empty accepted audience is one a malformed token could appear to satisfy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";

const BASE = {
  SQUAD_MCP_ALLOWED_ORIGINS: "https://copilotstudio.microsoft.com",
};

function audiencesFor(value: string): string[] {
  return loadOperatorConfig({ ...BASE, SQUAD_MCP_AUDIENCE: value } as NodeJS.ProcessEnv).audiences;
}

test("a single audience still parses to exactly one entry (back-compat)", () => {
  assert.deepEqual(audiencesFor("api://squad"), ["api://squad"]);
});

test("several audiences parse in order, trimmed", () => {
  assert.deepEqual(audiencesFor("api://squad,  api://cowork-config  ,api://third"), [
    "api://squad",
    "api://cowork-config",
    "api://third",
  ]);
});

test("blank entries from stray commas are dropped, never kept as an empty audience", () => {
  assert.deepEqual(audiencesFor("api://squad,,  ,api://cowork-config,"), [
    "api://squad",
    "api://cowork-config",
  ]);
});

test("duplicates collapse", () => {
  assert.deepEqual(audiencesFor("api://squad, api://squad"), ["api://squad"]);
});

test("a value that is only commas and whitespace fails fast", () => {
  assert.throws(() => audiencesFor(" , , "), /SQUAD_MCP_AUDIENCE is required/);
});

test("a missing value fails fast", () => {
  assert.throws(
    () => loadOperatorConfig({ ...BASE } as NodeJS.ProcessEnv),
    /SQUAD_MCP_AUDIENCE is required/,
  );
});
