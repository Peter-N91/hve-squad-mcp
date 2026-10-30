// Fixture + integration tests for .github/scripts/export-infra-vars.mjs (cicd
// bicep-cicd-pipeline P01 tooling; deployer DC1/DC3, N1 refinement).
//
// Run with: node --test .github/scripts/tests/export-infra-vars.test.mjs
//
// The integration test proves the actual claim this script exists to make:
// an unset optional int/bool/enum variable, and an unset SQUAD_INFRA_AUDIENCE,
// fall back to host/infra/main.bicep's own defaults when this script's export
// (required-only) is fed into `az bicep build-params` against
// host/infra/environments/prod.bicepparam — i.e. this script never forces an
// empty-string override onto an unset optional parameter. It is skipped
// (not failed) when the `az` CLI or its Bicep extension is unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseVarsJson,
  filterExportable,
  assertRequired,
  renderGithubEnv,
  randomDelimiter,
  run,
  UsageError,
  REQUIRED_ALWAYS,
  REQUIRED_EXISTING_MODE,
} from "../export-infra-vars.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const PROD_BICEPPARAM = join(REPO_ROOT, "host", "infra", "environments", "prod.bicepparam");

test("parseVarsJson: rejects unset/empty input as a usage error, not a gate failure", () => {
  assert.throws(() => parseVarsJson(undefined), UsageError);
  assert.throws(() => parseVarsJson(""), UsageError);
  assert.throws(() => parseVarsJson("   "), UsageError);
});

test("parseVarsJson: rejects invalid JSON and non-object JSON", () => {
  assert.throws(() => parseVarsJson("{not json"), UsageError);
  assert.throws(() => parseVarsJson("[1,2,3]"), UsageError);
  assert.throws(() => parseVarsJson("42"), UsageError);
});

test("parseVarsJson: accepts a well-formed vars object", () => {
  const vars = parseVarsJson('{"SQUAD_INFRA_ENTRA_CLIENT_ID":"abc"}');
  assert.deepEqual(vars, { SQUAD_INFRA_ENTRA_CLIENT_ID: "abc" });
});

test("filterExportable: keeps only non-empty SQUAD_INFRA_* keys, sorted", () => {
  const exportable = filterExportable({
    SQUAD_INFRA_B: "2",
    SQUAD_INFRA_A: "1",
    SQUAD_INFRA_EMPTY: "",
    OTHER_PREFIX: "value",
    SQUAD_INFRA_NON_STRING: 5,
  });
  assert.deepEqual(exportable, [
    { name: "SQUAD_INFRA_A", value: "1" },
    { name: "SQUAD_INFRA_B", value: "2" },
  ]);
});

test("assertRequired: reports every missing always-required name", () => {
  const missing = assertRequired({}, {});
  for (const name of REQUIRED_ALWAYS) assert.ok(missing.includes(name), `${name} should be reported missing`);
});

test("assertRequired: MODEL_ENDPOINT/MODEL_DEPLOYMENT are required only in existing mode (the default)", () => {
  const base = Object.fromEntries(REQUIRED_ALWAYS.map((n) => [n, "x"]));
  const missingDefaultMode = assertRequired(base, {});
  for (const name of REQUIRED_EXISTING_MODE) assert.ok(missingDefaultMode.includes(name), `${name} required by default (existing mode)`);

  const createMode = { ...base, SQUAD_INFRA_OPENAI_MODE: "create" };
  const missingCreateMode = assertRequired(createMode, {});
  assert.deepEqual(missingCreateMode, [], "create mode drops the MODEL_ENDPOINT/MODEL_DEPLOYMENT requirement");
});

test("assertRequired: falls back to process.env for a name this script never exports (e.g. CONTAINER_IMAGE)", () => {
  const base = Object.fromEntries(REQUIRED_ALWAYS.filter((n) => n !== "SQUAD_INFRA_CONTAINER_IMAGE").map((n) => [n, "x"]));
  const stillMissing = assertRequired(base, { SQUAD_INFRA_MODEL_ENDPOINT: "x", SQUAD_INFRA_MODEL_DEPLOYMENT: "x" });
  assert.ok(stillMissing.includes("SQUAD_INFRA_CONTAINER_IMAGE"));

  const withEnvFallback = assertRequired(base, {
    SQUAD_INFRA_CONTAINER_IMAGE: "registry/example@sha256:aaa",
    SQUAD_INFRA_MODEL_ENDPOINT: "x",
    SQUAD_INFRA_MODEL_DEPLOYMENT: "x",
  });
  assert.ok(!withEnvFallback.includes("SQUAD_INFRA_CONTAINER_IMAGE"));
});

test("randomDelimiter: never repeats across calls", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) seen.add(randomDelimiter());
  assert.equal(seen.size, 50);
});

test("renderGithubEnv: uses the multi-line delimiter syntax, one block per exportable", () => {
  const block = renderGithubEnv(
    [
      { name: "SQUAD_INFRA_A", value: "1" },
      { name: "SQUAD_INFRA_B", value: "multi\nline" },
    ],
    "DELIM"
  );
  assert.equal(block, "SQUAD_INFRA_A<<DELIM\n1\nDELIM\nSQUAD_INFRA_B<<DELIM\nmulti\nline\nDELIM\n");
});

test("run(): usage error on missing VARS_JSON returns exit code 2 and logs nothing but the message", () => {
  const errors = [];
  const code = run({ varsJsonRaw: undefined, logError: (m) => errors.push(m), log: () => {} });
  assert.equal(code, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /VARS_JSON/);
});

test("run(): assertion failure (missing required name) returns exit code 1, names only, never a value", () => {
  const errors = [];
  const code = run({
    varsJsonRaw: JSON.stringify({ SQUAD_INFRA_ENTRA_CLIENT_ID: "abc" }),
    logError: (m) => errors.push(m),
    log: () => {},
    env: {},
  });
  assert.equal(code, 1);
  assert.ok(errors.some((e) => e.includes("SQUAD_INFRA_CONTAINER_IMAGE")));
  assert.ok(!errors.some((e) => e.includes("abc")), "a value must never be printed");
});

test("run(): a fully-satisfied VARS_JSON returns 0 and writes only the non-empty SQUAD_INFRA_* keys to GITHUB_ENV", () => {
  const dir = mkdtempSync(join(tmpdir(), "export-infra-vars-"));
  const envFile = join(dir, "github_env");
  writeFileSync(envFile, "", "utf8");
  try {
    const vars = {
      SQUAD_INFRA_CONTAINER_IMAGE: "registry/example@sha256:aaa",
      SQUAD_INFRA_CONTAINER_REGISTRY_SERVER: "registry.azurecr.io",
      SQUAD_INFRA_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
      SQUAD_INFRA_ENTRA_TENANT_ID: "22222222-2222-2222-2222-222222222222",
      SQUAD_INFRA_BUDGET_ALERT_EMAILS: "a@example.com",
      SQUAD_INFRA_MODEL_ENDPOINT: "https://example.openai.azure.com",
      SQUAD_INFRA_MODEL_DEPLOYMENT: "gpt-4",
      SQUAD_INFRA_MIN_REPLICAS: "",
      OTHER_VAR: "not-squad-infra",
    };
    const code = run({ varsJsonRaw: JSON.stringify(vars), githubEnvPath: envFile, log: () => {}, logError: () => {}, env: {} });
    assert.equal(code, 0);
    const written = readFileSync(envFile, "utf8");
    assert.match(written, /SQUAD_INFRA_CONTAINER_IMAGE<</);
    assert.doesNotMatch(written, /SQUAD_INFRA_MIN_REPLICAS/, "an empty value must never be exported");
    assert.doesNotMatch(written, /OTHER_VAR/, "a non-SQUAD_INFRA_ key must never be exported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: az bicep build-params against the real prod.bicepparam
// ---------------------------------------------------------------------------

// Node's own command-injection hardening (Node >= 18.20.2/20.12.2/21.7.3)
// disallows spawning a Windows `.cmd`/`.bat` shim without `shell: true`. This
// affects ONLY this local test's own use of the Azure CLI on a Windows dev
// machine — the actual GitHub Actions workflows run on a Linux runner and
// invoke `az` as an ordinary executable inside a real POSIX `run:` shell, so
// this accommodation never applies to the shipped pipeline.
const AZ_EXEC_OPTIONS = { stdio: "pipe", shell: process.platform === "win32" };

function azBicepAvailable() {
  try {
    execFileSync("az", ["bicep", "version"], AZ_EXEC_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

test("integration: required-only export leaves every optional int/bool/enum var and AUDIENCE at main.bicep's own default", (t) => {
  if (!azBicepAvailable()) {
    t.skip("az CLI / Bicep extension not available in this environment");
    return;
  }

  const requiredOnlyVars = {
    SQUAD_INFRA_CONTAINER_IMAGE: "registry.azurecr.io/hve-squad-mcp@sha256:" + "0".repeat(64),
    SQUAD_INFRA_CONTAINER_REGISTRY_SERVER: "registry.azurecr.io",
    SQUAD_INFRA_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
    SQUAD_INFRA_ENTRA_TENANT_ID: "22222222-2222-2222-2222-222222222222",
    SQUAD_INFRA_BUDGET_ALERT_EMAILS: "a@example.com",
    SQUAD_INFRA_MODEL_ENDPOINT: "https://example.openai.azure.com",
    SQUAD_INFRA_MODEL_DEPLOYMENT: "gpt-4",
    // Deliberately absent/empty: every optional int/bool/enum var, and AUDIENCE.
    SQUAD_INFRA_MIN_REPLICAS: "",
    SQUAD_INFRA_MAX_REPLICAS: "",
    SQUAD_INFRA_MANAGE_ACR_PULL_ASSIGNMENT: "",
    SQUAD_INFRA_OPENAI_MODE: "",
    SQUAD_INFRA_AUDIENCE: "",
  };

  const dir = mkdtempSync(join(tmpdir(), "export-infra-vars-int-"));
  const envFile = join(dir, "github_env");
  writeFileSync(envFile, "", "utf8");
  try {
    const missing = assertRequired(requiredOnlyVars, {});
    assert.deepEqual(missing, [], "the fixture above must already satisfy every required name");

    const code = run({ varsJsonRaw: JSON.stringify(requiredOnlyVars), githubEnvPath: envFile, log: () => {}, logError: () => {}, env: {} });
    assert.equal(code, 0);

    // Parse the multi-line-delimiter $GITHUB_ENV format back into a plain env map.
    const exportedEnv = {};
    const raw = readFileSync(envFile, "utf8");
    const re = /^(\S+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2\r?\n/gm;
    let m;
    while ((m = re.exec(raw))) exportedEnv[m[1]] = m[3];
    assert.ok(!("SQUAD_INFRA_MIN_REPLICAS" in exportedEnv), "an empty optional var must not be exported at all");
    assert.ok(!("SQUAD_INFRA_AUDIENCE" in exportedEnv), "an empty AUDIENCE must not be exported at all");
    assert.ok("SQUAD_INFRA_CONTAINER_IMAGE" in exportedEnv);

    const outFile = join(dir, "prod.parameters.json");
    // A hermetic child env: only Node/PATH plumbing plus the exported vars —
    // never this test-runner process's own ambient SQUAD_INFRA_* leftovers.
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("SQUAD_INFRA_")) delete childEnv[key];
    }
    Object.assign(childEnv, exportedEnv);

    execFileSync("az", ["bicep", "build-params", "--file", PROD_BICEPPARAM, "--outfile", outFile], {
      env: childEnv,
      ...AZ_EXEC_OPTIONS,
    });

    const built = JSON.parse(readFileSync(outFile, "utf8"));
    const p = built.parameters;

    // Optional int/bool/enum vars fall back to main.bicep's own defaults.
    assert.equal(p.minReplicas.value, 0, "minReplicas should fall back to main.bicep's default (0)");
    assert.equal(p.maxReplicas.value, 5, "maxReplicas should fall back to main.bicep's default (5)");
    assert.equal(p.manageAcrPullAssignment.value, false, "manageAcrPullAssignment should fall back to false");
    assert.equal(p.openAiMode.value, "existing", "openAiMode should fall back to 'existing'");

    // An unset AUDIENCE falls back to the entra client id (the v2 aud).
    assert.equal(p.squad.value.audience, requiredOnlyVars.SQUAD_INFRA_ENTRA_CLIENT_ID, "audience should default to SQUAD_INFRA_ENTRA_CLIENT_ID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
