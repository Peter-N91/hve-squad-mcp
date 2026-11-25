#!/usr/bin/env node
// SEC-property preservation diff (S9 / A9 / FR-039).
//
// Compiles nothing and calls no Azure API. Given two compiled templates (the
// pre-refactor baseline main.json and the refactored main.json) and one
// parameters file (from `az bicep build-params`), it evaluates BOTH with the
// same values (lib/arm-eval.mjs), then:
//
//   1. Diffs the full resource inventories (every resource, keyed by resolved
//      resource id = scope + type + name, with fully evaluated properties). Any
//      added / removed / changed resource that is not an INTENDED, flag-gated
//      addition for this fixture is reported as UNEXPECTED (exit code 1).
//   2. Prints the normalized before/after value of every council-named security
//      property (authConfig, ingress, Key Vault, storage, env vars, secretRefs,
//      role assignments) with its status.
//
// Usage:
//   node sec-diff.mjs --before <baseline main.json> --after <main.json> \
//        --params <fixture.parameters.json> [--name <fixture>] [--json <out.json>]

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateTemplate, parameterValues, defaultScope, canonical, redact, guidInputs } from "./lib/arm-eval.mjs";

const ROLE = {
  acrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  openAiUser: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
};

const SEC_ENV = new Set([
  "SQUAD_MCP_AUDIENCE",
  "SQUAD_MCP_ALLOWED_ORIGINS",
  "SQUAD_MCP_ALLOWED_ISSUERS",
  "SQUAD_MCP_ALLOWED_TENANTS",
  "SQUAD_MCP_JWKS_URI",
  "SQUAD_MCP_MODEL_ENDPOINT",
  "SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS",
  "SQUAD_MCP_MODEL_DEPLOYMENT",
  "SQUAD_MCP_TENANT_CONCURRENCY",
  "SQUAD_MCP_TENANT_COST_CEILING_USD",
  "SQUAD_MCP_RUN_ENCRYPTION_KEY_B64",
  "AZURE_CLIENT_ID",
]);

const MODEL_ENV = new Set(["SQUAD_MCP_MODEL_ENDPOINT", "SQUAD_MCP_MODEL_DEPLOYMENT"]);

function get(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur === undefined || cur === null) return "(absent)";
    cur = /^\d+$/.test(seg) ? cur[Number(seg)] : cur[seg];
  }
  return cur === undefined ? "(absent)" : cur;
}

function diffPaths(a, b, prefix = "", out = []) {
  const ca = canonical(a);
  const cb = canonical(b);
  if (JSON.stringify(ca) === JSON.stringify(cb)) return out;
  if (ca && cb && typeof ca === "object" && typeof cb === "object" && Array.isArray(ca) === Array.isArray(cb)) {
    const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
    for (const k of keys) diffPaths(ca[k], cb[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out.push({ path: prefix || "(root)", before: ca === undefined ? "(absent)" : ca, after: cb === undefined ? "(absent)" : cb });
  return out;
}

const comparable = (r) => ({
  type: r.type,
  apiVersion: r.apiVersion,
  name: r.name,
  location: r.location,
  kind: r.kind,
  sku: r.sku,
  identity: r.identity,
  tags: r.tags,
  properties: r.properties,
});

function envOf(rec) {
  const c = rec?.properties?.template?.containers?.[0];
  return Array.isArray(c?.env) ? c.env : null;
}

function roleGuid(rec) {
  const id = String(rec?.properties?.roleDefinitionId || "");
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}

/** Classify additions/changes as intended (flag-gated) or unexpected for one fixture. */
function intendedAddition(rec, p) {
  if (rec.type === "Microsoft.Authorization/roleAssignments") {
    if (roleGuid(rec) === ROLE.acrPull && p.manageAcrPullAssignment === true) return "AcrPull (manageAcrPullAssignment=true, U4)";
    if (roleGuid(rec) === ROLE.openAiUser && p.manageOpenAiRoleAssignment === true) return "Cognitive Services OpenAI User (manageOpenAiRoleAssignment=true, U4)";
  }
  if (/^Microsoft\.CognitiveServices\/accounts(\/deployments)?$/.test(rec.type) && p.openAiMode === "create") return "Azure OpenAI create mode (openAiMode=create, D8)";
  return null;
}

function intendedChange(before, after, paths, p) {
  if (after.type === "Microsoft.Consumption/budgets" && p.budgetStartDate === undefined && paths.every((d) => d.path === "properties.timePeriod.startDate")) {
    return "budgetStartDate not supplied: the default is now the first day of the current UTC month (was a fixed '2026-07-01' that fails budget CREATE after July 2026)";
  }
  if (p.openAiMode !== "create") return null;
  if (!["Microsoft.App/containerApps", "Microsoft.App/jobs"].includes(after.type)) return null;
  const eb = envOf(before) || [];
  const ea = envOf(after) || [];
  const strip = (env) => env.filter((e) => !MODEL_ENV.has(e.name));
  const onlyModel = paths.every((d) => d.path.startsWith("properties.template.containers.0.env"));
  if (onlyModel && JSON.stringify(canonical(strip(eb))) === JSON.stringify(canonical(strip(ea)))) {
    return "create mode replaces SQUAD_MCP_MODEL_ENDPOINT / _DEPLOYMENT with the deterministic create-mode values (A6)";
  }
  return null;
}

export function secDiff(beforeTemplate, afterTemplate, paramsJson, opts = {}) {
  const p = parameterValues(paramsJson);
  const scope = defaultScope(opts.scope || {});
  const before = evaluateTemplate(beforeTemplate, p, scope, { stubs: opts.stubs });
  const after = evaluateTemplate(afterTemplate, p, scope, { stubs: opts.stubs });
  const secure = new Set([...before.secureValues, ...after.secureValues]);
  const key = (r) => r.id.toLowerCase();
  const bRes = new Map(before.inventory.filter((r) => !r.module).map((r) => [key(r), r]));
  const aRes = new Map(after.inventory.filter((r) => !r.module).map((r) => [key(r), r]));
  const modules = after.inventory.filter((r) => r.module).map((r) => ({ name: r.name, symbol: r.symbol, targetScope: r.targetScope }));

  const result = { unchanged: [], added: [], removed: [], changed: [], unexpected: [], modules };
  for (const [k, b] of bRes) {
    const a = aRes.get(k);
    if (!a) {
      result.removed.push({ id: b.id, type: b.type });
      result.unexpected.push({ kind: "removed", id: b.id, type: b.type });
      continue;
    }
    const paths = diffPaths(comparable(b), comparable(a));
    if (paths.length === 0) {
      result.unchanged.push({ id: b.id, type: b.type });
    } else {
      const why = intendedChange(b, a, paths, p);
      const entry = { id: b.id, type: b.type, intended: why, diffs: redact(paths, secure) };
      result.changed.push(entry);
      if (!why) result.unexpected.push({ kind: "changed", ...entry });
    }
  }
  for (const [k, a] of aRes) {
    if (bRes.has(k)) continue;
    const why = intendedAddition(a, p);
    const entry = { id: a.id, type: a.type, intended: why, properties: redact(a.properties ?? null, secure) };
    result.added.push(entry);
    if (!why) result.unexpected.push({ kind: "added", ...entry });
  }

  // Council-named SEC properties, before vs after.
  const rows = [];
  const row = (label, b, a) => {
    const vb = redact(b, secure);
    const va = redact(a, secure);
    const same = JSON.stringify(canonical(vb)) === JSON.stringify(canonical(va));
    const status = same ? "unchanged" : vb === "(absent)" ? "ADDED" : va === "(absent)" ? "REMOVED" : "CHANGED";
    rows.push({ label, status, before: vb, after: va });
  };
  const byType = (inv, type) => inv.filter((r) => r.type === type && !r.module);
  const pairs = (type) => {
    const ids = new Set([...byType(before.inventory, type), ...byType(after.inventory, type)].map(key));
    return [...ids].sort().map((k) => [bRes.get(k), aRes.get(k)]);
  };
  const nameOf = (b, a) => (a || b).name;
  for (const [b, a] of pairs("Microsoft.App/containerApps/authConfigs")) {
    for (const path of [
      "properties.platform.enabled",
      "properties.globalValidation.unauthenticatedClientAction",
      "properties.identityProviders.azureActiveDirectory.enabled",
      "properties.identityProviders.azureActiveDirectory.registration.openIdIssuer",
      "properties.identityProviders.azureActiveDirectory.registration.clientId",
      "properties.identityProviders.azureActiveDirectory.validation.allowedAudiences",
    ]) row(`authConfig ${nameOf(b, a)} ${path}`, get(b, path), get(a, path));
  }
  for (const type of ["Microsoft.App/containerApps", "Microsoft.App/jobs"]) {
    for (const [b, a] of pairs(type)) {
      const paths = type === "Microsoft.App/containerApps"
        ? ["properties.configuration.ingress", "properties.configuration.secrets", "properties.configuration.registries", "identity", "properties.template.scale"]
        : ["properties.configuration.secrets", "properties.configuration.registries", "identity", "properties.configuration.scheduleTriggerConfig"];
      for (const path of paths) row(`${type.split("/").pop()} ${nameOf(b, a)} ${path}`, get(b, path), get(a, path));
      const eb = envOf(b) || [];
      const ea = envOf(a) || [];
      for (const n of [...new Set([...eb, ...ea].map((e) => e.name))]) {
        const vb = eb.find((e) => e.name === n) ?? "(absent)";
        const va = ea.find((e) => e.name === n) ?? "(absent)";
        if (SEC_ENV.has(n) || vb?.secretRef || va?.secretRef) row(`env ${nameOf(b, a)} ${n}`, vb, va);
      }
      row(`env ${nameOf(b, a)} (full list, order-sensitive)`, eb.map((e) => e.name), ea.map((e) => e.name));
    }
  }
  for (const [b, a] of pairs("Microsoft.KeyVault/vaults")) {
    for (const path of ["properties.enableRbacAuthorization", "properties.enableSoftDelete", "properties.softDeleteRetentionInDays", "properties.enablePurgeProtection", "properties.publicNetworkAccess", "properties.tenantId"]) {
      row(`keyVault ${nameOf(b, a)} ${path}`, get(b, path), get(a, path));
    }
  }
  for (const [b, a] of pairs("Microsoft.Storage/storageAccounts")) {
    for (const path of ["properties.minimumTlsVersion", "properties.allowBlobPublicAccess", "properties.supportsHttpsTrafficOnly", "properties.allowSharedKeyAccess", "sku.name", "kind"]) {
      row(`storage ${nameOf(b, a)} ${path}`, get(b, path), get(a, path));
    }
  }
  for (const [b, a] of pairs("Microsoft.Storage/storageAccounts/blobServices/containers")) row(`blobContainer ${nameOf(b, a)} properties.publicAccess`, get(b, "properties.publicAccess"), get(a, "properties.publicAccess"));
  for (const [b, a] of pairs("Microsoft.App/managedEnvironments")) row(`managedEnvironment ${nameOf(b, a)} properties.appLogsConfiguration`, get(b, "properties.appLogsConfiguration"), get(a, "properties.appLogsConfiguration"));
  for (const [b, a] of pairs("Microsoft.Authorization/roleAssignments")) {
    const rec = a || b;
    const inputs = guidInputs.get(rec.name) || [];
    row(`roleAssignment ${rec.name} = guid(${inputs.join(", ")}) at ${rec.id.split("/providers/Microsoft.Authorization/")[0]}`, b ? b.properties : "(absent)", a ? a.properties : "(absent)");
  }
  result.secRows = rows;
  result.outputsBefore = redact(before.outputs, secure);
  result.outputsAfter = redact(after.outputs, secure);
  result.outputsEqual = JSON.stringify(canonical(result.outputsBefore)) === JSON.stringify(canonical(result.outputsAfter));
  if (!result.outputsEqual) result.unexpected.push({ kind: "outputs", before: result.outputsBefore, after: result.outputsAfter });
  return result;
}

export function formatSecDiff(name, r) {
  const lines = [];
  const short = (v) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 157)}...` : s;
  };
  lines.push(`### sec-diff: ${name}`);
  lines.push(`resources unchanged=${r.unchanged.length} changed=${r.changed.length} added=${r.added.length} removed=${r.removed.length} unexpected=${r.unexpected.length} outputsEqual=${r.outputsEqual}`);
  for (const c of r.changed) lines.push(`  CHANGED ${c.type} ${c.id}${c.intended ? `  [intended: ${c.intended}]` : "  [UNEXPECTED]"}\n${c.diffs.map((d) => `      ${d.path}: ${short(d.before)} -> ${short(d.after)}`).join("\n")}`);
  for (const a of r.added) lines.push(`  ADDED   ${a.type} ${a.id}${a.intended ? `  [intended: ${a.intended}]` : "  [UNEXPECTED]"}`);
  for (const x of r.removed) lines.push(`  REMOVED ${x.type} ${x.id}  [UNEXPECTED]`);
  const changedRows = r.secRows.filter((x) => x.status !== "unchanged");
  lines.push(`SEC properties checked=${r.secRows.length} unchanged=${r.secRows.length - changedRows.length} changed/added/removed=${changedRows.length}`);
  for (const x of r.secRows) lines.push(`  [${x.status}] ${x.label}${x.status === "unchanged" ? ` = ${short(x.after)}` : `: ${short(x.before)} -> ${short(x.after)}`}`);
  return lines.join("\n");
}

function main(argv) {
  const args = {};
  for (let n = 0; n < argv.length; n += 2) args[argv[n].replace(/^--/, "")] = argv[n + 1];
  if (!args.before || !args.after || !args.params) {
    console.error("usage: node sec-diff.mjs --before <baseline.json> --after <main.json> --params <parameters.json> [--name n] [--json out]");
    process.exit(2);
  }
  const r = secDiff(
    JSON.parse(readFileSync(args.before, "utf8")),
    JSON.parse(readFileSync(args.after, "utf8")),
    JSON.parse(readFileSync(args.params, "utf8")),
  );
  console.log(formatSecDiff(args.name || args.params, r));
  if (args.json) writeFileSync(args.json, JSON.stringify(r, null, 2));
  process.exit(r.unexpected.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main(process.argv.slice(2));
