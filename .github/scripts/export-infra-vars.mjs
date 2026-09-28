#!/usr/bin/env node
// Export SQUAD_INFRA_* GitHub variables to $GITHUB_ENV (cicd bicep-cicd-pipeline
// P01 tooling; deployer DC1/DC3, this revision's N1 refinement).
//
// Why this script exists rather than one `env:` line per variable in the
// workflow YAML: GitHub's `vars` context always resolves an UNSET variable
// reference (`${{ vars.SQUAD_INFRA_X }}`) to an empty string, never to
// "absent". host/infra/environments/README.md's own "Conventions" section is
// explicit that setting a variable to an empty value is NOT the same as
// leaving it unset for a parameter with a non-empty default
// (`main.bicep`/`prod.bicepparam` treats `''` as "use MY OWN default" only for
// the handful of parameters explicitly documented that way — every other
// parameter would silently receive an empty string instead of its real
// default). A literal `env: SQUAD_INFRA_MIN_REPLICAS: ${{ vars.SQUAD_INFRA_MIN_REPLICAS }}`
// for every one of the 61 non-computed, non-secret contract names would
// therefore override every UNSET optional variable's default with `''` and
// break `int()`/`bool()` parsing outright (`BCP338 Failed to evaluate
// parameter`). This script instead reads the WHOLE `vars` context as one JSON
// blob (`toJSON(vars)`, passed in via the `VARS_JSON` environment variable),
// and forwards to `$GITHUB_ENV` only the `SQUAD_INFRA_*` keys that are
// actually present AND non-empty — so an unset optional variable stays
// genuinely absent from the job's environment, and `readEnvironmentVariable('SQUAD_INFRA_X', '<default>')`
// resolves its own default exactly as `host/infra/environments/README.md` documents.
//
// node:* built-ins only (supply-chain R7). Never prints a value — only
// variable NAMES are logged, matching host/infra/tests/check-no-placeholders.mjs's
// "print the path/name, never the value" convention.
//
// Usage (inside a workflow step):
//   env:
//     VARS_JSON: ${{ toJSON(vars) }}
//   run: node ci/.github/scripts/export-infra-vars.mjs
//
// Exit codes: 0 = exported (and, when asked, every required name was
// non-empty); 1 = a required `SQUAD_INFRA_*` name resolved empty (assertion
// failure — a real, actionable gap, not a usage problem); 2 = usage/parse
// error (`VARS_JSON` missing or not valid JSON).

import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** The five names host/infra/environments/README.md marks "required: yes" — no mode qualifier. */
export const REQUIRED_ALWAYS = [
  "SQUAD_INFRA_CONTAINER_IMAGE",
  "SQUAD_INFRA_CONTAINER_REGISTRY_SERVER",
  "SQUAD_INFRA_ENTRA_CLIENT_ID",
  "SQUAD_INFRA_ENTRA_TENANT_ID",
  "SQUAD_INFRA_BUDGET_ALERT_EMAILS",
];

/** Required only when SQUAD_INFRA_OPENAI_MODE resolves to "existing" (the default). */
export const REQUIRED_EXISTING_MODE = ["SQUAD_INFRA_MODEL_ENDPOINT", "SQUAD_INFRA_MODEL_DEPLOYMENT"];

export class UsageError extends Error {}

/** Parse the VARS_JSON blob. Throws UsageError on missing/invalid input. */
export function parseVarsJson(raw) {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    throw new UsageError("VARS_JSON is unset or empty — pass env: { VARS_JSON: ${{ toJSON(vars) }} }");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`VARS_JSON is not valid JSON (${e.message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("VARS_JSON did not parse to a JSON object");
  }
  return parsed;
}

/**
 * Return `{ name, value }` pairs for every `SQUAD_INFRA_*` key in `vars`
 * whose value is a non-empty string. Every other key (a different prefix, or
 * an empty `SQUAD_INFRA_*` value) is skipped — an unset/empty value must stay
 * absent from the job's environment so `readEnvironmentVariable`'s own
 * default takes over.
 */
export function filterExportable(vars) {
  const out = [];
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith("SQUAD_INFRA_")) continue;
    if (typeof value !== "string" || value === "") continue;
    out.push({ name, value });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Resolve one variable's effective value for the required-name assertion:
 * prefer `vars` (the JSON blob just parsed), falling back to `process.env`
 * (covers a name this script does not itself export, such as
 * `SQUAD_INFRA_CONTAINER_IMAGE` — always computed by the calling job's own
 * `env:` block, never sourced from a GitHub variable).
 */
function resolve(name, vars, env) {
  const fromVars = vars[name];
  if (typeof fromVars === "string" && fromVars !== "") return fromVars;
  const fromEnv = env[name];
  return typeof fromEnv === "string" ? fromEnv : "";
}

/**
 * Assert every required `SQUAD_INFRA_*` name (the always-required five, plus
 * the two model names when the effective OpenAI mode is "existing", the
 * default) resolves non-empty. Returns the list of MISSING names (empty when
 * all required names are present) — never a value.
 */
export function assertRequired(vars, env = process.env) {
  const mode = (resolve("SQUAD_INFRA_OPENAI_MODE", vars, env) || "existing").toLowerCase();
  const required = mode === "existing" ? [...REQUIRED_ALWAYS, ...REQUIRED_EXISTING_MODE] : REQUIRED_ALWAYS;
  return required.filter((name) => resolve(name, vars, env) === "");
}

/** Render the $GITHUB_ENV multi-line-delimiter block for one export batch. */
export function renderGithubEnv(exportable, delimiter) {
  return exportable.map(({ name, value }) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`).join("");
}

/** A fresh, unpredictable delimiter per invocation — never reused across runs. */
export function randomDelimiter() {
  return `ghadelim_${randomBytes(16).toString("hex")}`;
}

export function run({ varsJsonRaw, githubEnvPath, env = process.env, log = console.log, logError = console.error } = {}) {
  let vars;
  try {
    vars = parseVarsJson(varsJsonRaw);
  } catch (e) {
    if (e instanceof UsageError) {
      logError(`FAIL usage: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const exportable = filterExportable(vars);
  if (githubEnvPath) {
    const delimiter = randomDelimiter();
    appendFileSync(githubEnvPath, renderGithubEnv(exportable, delimiter), "utf8");
  }
  log(`OK   exported ${exportable.length} non-empty SQUAD_INFRA_* variable(s): ${exportable.map((e) => e.name).join(", ") || "(none)"}`);

  const missing = assertRequired(vars, env);
  if (missing.length > 0) {
    for (const name of missing) logError(`FAIL required: ${name} is empty`);
    return 1;
  }
  log("OK   every required SQUAD_INFRA_* name is non-empty");
  return 0;
}

function main() {
  return run({ varsJsonRaw: process.env.VARS_JSON, githubEnvPath: process.env.GITHUB_ENV, env: process.env });
}

// CLI guard (mirrors host/infra/tests/check-no-placeholders.mjs's own convention).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main());
}
