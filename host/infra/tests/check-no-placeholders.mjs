#!/usr/bin/env node
// Placeholder preflight (cicd escalation D1a). Exits non-zero when a built
// parameters file (the output of `az bicep build-params --outfile <file>`) still
// contains an unreplaced <PLACEHOLDER> token such as <ENTRA_CLIENT_ID> or
// <REGISTRY>, anywhere in any parameter value (strings nested in objects and
// arrays included).
//
// It prints only the JSON path of each hit and the placeholder token itself, never
// the surrounding value, so it is safe to run on a file that holds secure values.
// (Still: build the file WITHOUT secret env vars set, and never upload it.)
//
// Usage: node host/infra/tests/check-no-placeholders.mjs <built.parameters.json> [...]
// Exit:  0 = clean, 1 = placeholder(s) found, 2 = usage / unreadable / not a parameters file.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PLACEHOLDER = /<[A-Z][A-Z0-9_]*>/g;

/** Return [{ path, token }] for every placeholder token in a parameters JSON object. */
export function findPlaceholders(parametersJson) {
  const hits = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(PLACEHOLDER)) hits.push({ path, token: m[0] });
    } else if (Array.isArray(value)) {
      value.forEach((v, n) => walk(v, `${path}[${n}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  for (const [name, entry] of Object.entries(parametersJson.parameters || {})) {
    walk(entry && typeof entry === "object" && "value" in entry ? entry.value : entry, name);
  }
  return hits;
}

function main(files) {
  if (!files.length) {
    console.error("usage: node check-no-placeholders.mjs <built.parameters.json> [...]");
    process.exit(2);
  }
  let found = 0;
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`ERROR ${file}: cannot read as JSON (${e.message})`);
      process.exit(2);
    }
    if (!json || typeof json.parameters !== "object") {
      console.error(`ERROR ${file}: not a deploymentParameters file (no "parameters" object)`);
      process.exit(2);
    }
    const hits = findPlaceholders(json);
    found += hits.length;
    if (hits.length === 0) console.log(`OK   ${file}: no <PLACEHOLDER> tokens in ${Object.keys(json.parameters).length} parameters`);
    for (const h of hits) console.log(`FAIL ${file}: ${h.path} still contains ${h.token}`);
  }
  process.exit(found ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
