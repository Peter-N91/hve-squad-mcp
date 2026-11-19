#!/usr/bin/env node
// Parameter / output / SquadConfig contract diff (A9 / FR-033 / A12).
//
// Compares two compiled templates — the pre-refactor baseline main.json and the
// refactored main.json — and fails (exit 1) on any removed or renamed parameter,
// output, or SquadConfig field, and on any change to an existing parameter's
// type, default value, allowed values, or min/max constraints — except the
// reviewed changes listed in EXPECTED_CHANGED_PARAMS. Additions are
// allowed only from the expected list below, and each must carry a default so
// every existing .bicepparam keeps working unchanged (U4).
//
// Usage: node diff-contract.mjs --before <baseline main.json> --after <main.json>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonical } from "./lib/arm-eval.mjs";

export const EXPECTED_ADDED_PARAMS = {
  containerRegistryResourceId: { defaultValue: "" },
  manageAcrPullAssignment: { defaultValue: false },
  manageOpenAiRoleAssignment: { defaultValue: false },
  openAiMode: { defaultValue: "existing" },
  openAiAccountName: { defaultValue: "" },
  openAiResourceGroupName: {},
  openAiLocation: {},
  openAiSkuName: {},
  openAiPublicNetworkAccess: {},
  openAiDeployments: { defaultValue: [] },
};
export const EXPECTED_ADDED_DEFINITIONS = ["OpenAiDeployment"];
// Intentional, reviewed changes to an EXISTING parameter (cicd escalation, budget
// start date): only the listed attributes may differ, to exactly these values.
export const EXPECTED_CHANGED_PARAMS = {
  budgetStartDate: { defaultValue: "", allowDescriptionChange: true },
};
const CONSTRAINTS = ["type", "defaultValue", "allowedValues", "minValue", "maxValue", "minLength", "maxLength", "nullable", "$ref", "items"];
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function contractDiff(before, after) {
  const problems = [];
  const notes = [];
  const bp = before.parameters || {};
  const ap = after.parameters || {};
  for (const [name, def] of Object.entries(bp)) {
    const nd = ap[name];
    if (!nd) {
      problems.push(`parameter removed/renamed: ${name}`);
      continue;
    }
    const allowed = EXPECTED_CHANGED_PARAMS[name];
    for (const c of CONSTRAINTS) {
      if (same(def[c], nd[c])) continue;
      if (allowed && c === "defaultValue" && same(allowed.defaultValue, nd[c])) {
        notes.push(`intended change: ${name}.defaultValue ${JSON.stringify(def[c])} -> ${JSON.stringify(nd[c])}`);
        continue;
      }
      problems.push(`parameter ${name}.${c} changed: ${JSON.stringify(def[c])} -> ${JSON.stringify(nd[c])}`);
    }
    if (!same(def.metadata?.description, nd.metadata?.description) && !allowed?.allowDescriptionChange) problems.push(`parameter ${name} description changed`);
  }
  const added = Object.keys(ap).filter((n) => !bp[n]);
  for (const name of added) {
    const exp = EXPECTED_ADDED_PARAMS[name];
    if (!exp) {
      problems.push(`unexpected new parameter: ${name}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(ap[name], "defaultValue")) problems.push(`new parameter ${name} has no default (would break existing .bicepparam files)`);
    if (Object.prototype.hasOwnProperty.call(exp, "defaultValue") && !same(exp.defaultValue, ap[name].defaultValue)) {
      problems.push(`new parameter ${name} default ${JSON.stringify(ap[name].defaultValue)} != expected ${JSON.stringify(exp.defaultValue)}`);
    }
  }
  const bo = before.outputs || {};
  const ao = after.outputs || {};
  for (const [name, def] of Object.entries(bo)) {
    if (!ao[name]) problems.push(`output removed/renamed: ${name}`);
    else if (!same(def.type, ao[name].type)) problems.push(`output ${name} type changed`);
  }
  for (const name of Object.keys(ao)) if (!bo[name]) problems.push(`unexpected new output: ${name}`);

  const bdef = before.definitions || {};
  const adef = after.definitions || {};
  for (const [name, def] of Object.entries(bdef)) {
    if (!adef[name]) {
      problems.push(`type removed: ${name}`);
      continue;
    }
    const bprops = def.properties || {};
    const aprops = adef[name].properties || {};
    for (const [f, fd] of Object.entries(bprops)) {
      if (!aprops[f]) problems.push(`${name}.${f} removed/renamed`);
      else if (!same({ ...fd, metadata: undefined }, { ...aprops[f], metadata: undefined })) problems.push(`${name}.${f} type changed`);
    }
    for (const f of Object.keys(aprops)) if (!bprops[f]) problems.push(`${name}.${f} unexpected new field`);
  }
  for (const name of Object.keys(adef)) {
    if (!bdef[name] && !EXPECTED_ADDED_DEFINITIONS.includes(name)) problems.push(`unexpected new type: ${name}`);
  }

  const squadFields = Object.keys(bdef.SquadConfig?.properties || {});
  notes.push(`baseline: ${Object.keys(bp).length} params, ${squadFields.length} SquadConfig fields, ${Object.keys(bo).length} outputs`);
  notes.push(`after:    ${Object.keys(ap).length} params (${added.length} added: ${added.join(", ")}), ${Object.keys(adef.SquadConfig?.properties || {}).length} SquadConfig fields, ${Object.keys(ao).length} outputs`);
  return { problems, notes, counts: { params: Object.keys(bp).length, squadFields: squadFields.length, outputs: Object.keys(bo).length } };
}

function main(argv) {
  const args = {};
  for (let n = 0; n < argv.length; n += 2) args[argv[n].replace(/^--/, "")] = argv[n + 1];
  if (!args.before || !args.after) {
    console.error("usage: node diff-contract.mjs --before <baseline main.json> --after <main.json>");
    process.exit(2);
  }
  const r = contractDiff(JSON.parse(readFileSync(args.before, "utf8")), JSON.parse(readFileSync(args.after, "utf8")));
  for (const n of r.notes) console.log(n);
  if (r.problems.length) {
    for (const p of r.problems) console.log(`CONTRACT PROBLEM: ${p}`);
    process.exit(1);
  }
  console.log("contract: every baseline parameter, output, and SquadConfig field is unchanged; additions are the expected defaulted set.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
