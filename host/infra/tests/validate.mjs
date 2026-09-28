#!/usr/bin/env node
// Local, credential-free validation harness for host/infra (P04 / A9 / S9 /
// AC-A10). Never deploys, never runs what-if, never calls Azure: every `az`
// invocation below is a local `az bicep` compile/lint.
//
//   1. az bicep build      main.bicep, bootstrap/bootstrap.bicep, bootstrap/entra-app.bicep
//   2. az bicep lint       every *.bicep under host/infra (zero errors required)
//   3. az bicep build-params every committed .bicepparam and every fixture
//   4. baseline            `git archive <baseline-ref> host/infra` -> build baseline main.json
//   5. diff-contract       38 params / 11 SquadConfig fields / 6 outputs unchanged
//   6. sec-diff            full resource inventory + SEC properties, per fixture
//   7. fail() guards       every tests/fixtures/failing/* fixture must trip its guard
//   8. bootstrap / entra   structural invariants (U1, AC-A4, S4/C1/C2, S6, S8, AC-A7)
//   9. determinism         no module output / runtime value in any resource or module name (AC-A9)
//  10. C8 key gate         no committed .bicepparam assigns runEncryptionKeyBase64 a literal
//  11. D2 / A8             env concat order, param declarations, SquadConfig and env
//                          blocks byte-identical to the baseline source
//  12. environments/prod   env-var driven prod.bicepparam: full / required-only /
//                          missing-var / malformed / create / legacy-audience builds,
//                          and the check-no-placeholders.mjs preflight
//
// Build outputs go to a temp folder (default: <os tmp>/squad-bicep-validate),
// never into the repository.
//
// Usage: node host/infra/tests/validate.mjs [--out <dir>] [--baseline-ref <git ref>]
//   --baseline-ref defaults to HEAD. In CI use the PR base (e.g. origin/main).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTemplate, parameterValues, defaultScope, GuardFailure, Unknown, canonical } from "./lib/arm-eval.mjs";
import { contractDiff, EXPECTED_CHANGED_PARAMS } from "./diff-contract.mjs";
import { findPlaceholders } from "./check-no-placeholders.mjs";
import { secDiff, formatSecDiff } from "./sec-diff.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const infra = resolve(here, "..");
const repoRoot = resolve(infra, "../..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, n, all) => (n % 2 === 0 ? [...acc, [v.replace(/^--/, ""), all[n + 1]]] : acc), []));
const out = resolve(args.out || join(tmpdir(), "squad-bicep-validate"));
const baselineRef = args["baseline-ref"] || "HEAD";
mkdirSync(out, { recursive: true });

const results = [];
const report = [];
const log = (s = "") => {
  console.log(s);
  report.push(s);
};
const record = (step, ok, detail = "") => {
  results.push({ step, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
};

const DUMMY_KEY = `${"A".repeat(43)}=`; // base64 of 32 zero bytes: well-formed, NOT a secret
const BAD_KEY = "not-a-32-byte-key"; // malformed on purpose (bad-encryption-key fixture)

function az(argv, env = {}) {
  const win = process.platform === "win32";
  const quoted = win ? argv.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : argv;
  // Hermetic: never let the caller's own SQUAD_INFRA_* variables leak into a build.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SQUAD_INFRA_/i.test(k)));
  const r = spawnSync("az", quoted, { encoding: "utf8", shell: win, env: { ...base, ...env } });
  const text = `${r.stdout || ""}${r.stderr || ""}`
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/new Bicep release is available|az bicep upgrade/.test(l))
    .join("\n");
  return { code: r.status, text };
}

function walk(dir, pred, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}
const rel = (p) => relative(repoRoot, p).split("\\").join("/");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ---------------------------------------------------------------------------
log(`# host/infra local validation (${new Date().toISOString()})`);
log(`output folder: ${out}`);
log(`baseline ref:  ${baselineRef}`);
log(az(["bicep", "version"]).text);
log("");

// 1. build
log("## 1. az bicep build");
const built = {};
for (const f of ["main.bicep", "bootstrap/bootstrap.bicep", "bootstrap/entra-app.bicep", "graph-memory-permissions.bicep"]) {
  const src = join(infra, f);
  const dst = join(out, "build", f.replace(/\.bicep$/, ".json"));
  mkdirSync(dirname(dst), { recursive: true });
  const r = az(["bicep", "build", "--file", src, "--outfile", dst]);
  built[f] = dst;
  record(`build ${rel(src)}`, r.code === 0, r.text.split("\n")[0] || "no diagnostics");
}

// 2. lint
log("\n## 2. az bicep lint (bicepconfig.json rules; zero errors required)");
let lintErrors = 0;
let lintWarnings = 0;
for (const f of walk(infra, (p) => p.endsWith(".bicep"))) {
  const r = az(["bicep", "lint", "--file", f]);
  const errs = r.text.split("\n").filter((l) => /\) : Error /.test(l));
  const warns = r.text.split("\n").filter((l) => /\) : Warning /.test(l));
  lintErrors += errs.length;
  lintWarnings += warns.length;
  record(`lint ${rel(f)}`, r.code === 0 && errs.length === 0, `${errs.length} error(s), ${warns.length} warning(s)${errs.length ? `: ${errs.join(" | ")}` : ""}`);
}

// Fake, non-secret values for every REQUIRED environments/prod.bicepparam var
// (documentation-only ids; see host/infra/environments/README.md).
const PROD_REQUIRED_ENV = {
  SQUAD_INFRA_CONTAINER_IMAGE: "squadfixture.azurecr.io/hve-squad-mcp:ci-0000000",
  SQUAD_INFRA_CONTAINER_REGISTRY_SERVER: "squadfixture.azurecr.io",
  SQUAD_INFRA_ENTRA_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  SQUAD_INFRA_ENTRA_TENANT_ID: "22222222-2222-2222-2222-222222222222",
  SQUAD_INFRA_MODEL_ENDPOINT: "https://squadfixture-aoai.openai.azure.com",
  SQUAD_INFRA_MODEL_DEPLOYMENT: "gpt-4o",
  SQUAD_INFRA_BUDGET_ALERT_EMAILS: "alerts@example.com, oncall@example.com",
};
// A "full" fake set: every required var plus a representative set of optional ones.
const PROD_FULL_ENV = {
  ...PROD_REQUIRED_ENV,
  SQUAD_INFRA_NAME_PREFIX: "squadmcp",
  SQUAD_INFRA_BUDGET_AMOUNT_USD: "750",
  SQUAD_INFRA_BUDGET_START_DATE: "2026-07-01",
  SQUAD_INFRA_ALLOWED_MODEL_ENDPOINTS: "https://squadfixture-aoai.openai.azure.com, https://other.openai.azure.com",
  SQUAD_INFRA_TENANT_CONCURRENCY: "8",
  SQUAD_INFRA_ENABLE_REMOTE_PIPELINE: "True",
  SQUAD_INFRA_ENABLE_WORKER: "true",
  SQUAD_INFRA_ENABLE_MEMORY: "true",
  SQUAD_INFRA_CONTAINER_REGISTRY_RESOURCE_ID: "/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-squadmcp-fixture/providers/Microsoft.ContainerRegistry/registries/squadfixture",
  SQUAD_INFRA_MANAGE_ACR_PULL_ASSIGNMENT: "true",
  SQUAD_INFRA_OPENAI_ACCOUNT_NAME: "squadfixture-aoai",
  SQUAD_INFRA_MANAGE_OPENAI_ROLE_ASSIGNMENT: "true",
};

// 3. build-params
log("\n## 3. az bicep build-params");
const paramOut = {};
const envFor = (f) => {
  const b = basename(f);
  if (b === "all-features-on.bicepparam") return { SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64: DUMMY_KEY };
  if (b === "bad-encryption-key.bicepparam") return { SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64: BAD_KEY };
  if (rel(f) === "host/infra/environments/prod.bicepparam") return PROD_FULL_ENV;
  return {};
};
for (const f of walk(infra, (p) => p.endsWith(".bicepparam") && !p.endsWith(".local.bicepparam"))) {
  const dst = join(out, "params", `${rel(f).replace(/[/\\]/g, "__").replace(/\.bicepparam$/, "")}.parameters.json`);
  mkdirSync(dirname(dst), { recursive: true });
  const r = az(["bicep", "build-params", "--file", f, "--outfile", dst], envFor(f));
  paramOut[rel(f)] = dst;
  record(`build-params ${rel(f)}`, r.code === 0, r.text.split("\n")[0] || "no diagnostics");
}
const P = (name) => paramOut[`host/infra/tests/fixtures/${name}.bicepparam`];

// 4. baseline
log(`\n## 4. baseline (${baselineRef})`);
const baseDir = join(out, "baseline");
rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });
const tarPath = join(out, "baseline.tar");
const g = spawnSync("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, baselineRef, "host/infra"], { encoding: "utf8" });
const x = g.status === 0 ? spawnSync("tar", ["-xf", tarPath, "-C", baseDir], { encoding: "utf8" }) : g;
const baseMain = join(baseDir, "host", "infra", "main.bicep");
const baseJson = join(out, "baseline-main.json");
const br = x.status === 0 && existsSync(baseMain) ? az(["bicep", "build", "--file", baseMain, "--outfile", baseJson]) : { code: 1, text: `${g.stderr || ""}${x.stderr || ""}` };
record(`build baseline main.bicep @ ${baselineRef}`, br.code === 0, br.text.split("\n")[0] || "compiled");
const before = readJson(baseJson);
const after = readJson(built["main.bicep"]);

// 5. contract diff
log("\n## 5. param / output / SquadConfig contract diff");
const cd = contractDiff(before, after);
cd.notes.forEach((n) => log(`    ${n}`));
cd.problems.forEach((p) => log(`    PROBLEM: ${p}`));
record("diff-contract", cd.problems.length === 0, `${cd.counts.params} params / ${cd.counts.squadFields} SquadConfig fields / ${cd.counts.outputs} outputs preserved`);
const mainParamsJson = readJson(paramOut["host/infra/main.bicepparam"]);
const mainParamNames = Object.keys(mainParamsJson.parameters);
record("main.bicepparam sets only baseline params plus the new flags", mainParamNames.every((n) => before.parameters[n] || ["manageAcrPullAssignment", "manageOpenAiRoleAssignment", "openAiMode"].includes(n)), `params set: ${mainParamNames.length}`);
{
  const mutated = JSON.parse(JSON.stringify(after));
  mutated.parameters.namePrefixRenamed = mutated.parameters.namePrefix;
  delete mutated.parameters.namePrefix;
  delete mutated.outputs.appClientId;
  const r = contractDiff(before, mutated);
  record("diff-contract self-test: a planted param rename + output removal is reported", r.problems.length === 3, r.problems.join("; "));
}

// 6. sec-diff per fixture (+ main.bicepparam itself)
log("\n## 6. SEC-property / full-inventory diff (baseline vs refactor, same parameter values)");
const secFixtures = [
  ["main.bicepparam", paramOut["host/infra/main.bicepparam"]],
  ["existing", P("existing")],
  ["create", P("create")],
  ["cross-rg", P("cross-rg")],
  ["all-features-on", P("all-features-on")],
];
const secResults = {};
for (const [name, file] of secFixtures) {
  try {
    const r = secDiff(before, after, readJson(file));
    secResults[name] = r;
    log(formatSecDiff(name, r));
    const detail = `unchanged=${r.unchanged.length} intended-additions=${r.added.filter((a) => a.intended).length} unexpected=${r.unexpected.length} SEC rows=${r.secRows.length}`;
    record(`sec-diff ${name}`, r.unexpected.length === 0, detail);
  } catch (e) {
    record(`sec-diff ${name}`, false, e.message);
  }
}
const ex = secResults.existing;
record("existing fixture: zero new/changed resources, zero new role assignments (U4)", !!ex && ex.added.length === 0 && ex.changed.length === 0 && ex.removed.length === 0, ex ? `${ex.unchanged.length} resources byte-identical after evaluation` : "");
{
  const ra = (secResults["all-features-on"]?.secRows || []).filter((x) => x.label.startsWith("roleAssignment") && x.status === "unchanged");
  ra.forEach((x) => log(`    ${x.label}`));
  record("A2: the 3 pre-existing role assignments (baseline main.bicep:341/488/526) keep identical names = identical guid() inputs", ra.length === 3);
}
// Self-test: the diff must catch a planted regression (it is not vacuous).
{
  const mutated = JSON.parse(JSON.stringify(after));
  const appMod = mutated.resources.app.properties.template;
  const appRes = Array.isArray(appMod.resources) ? appMod.resources : Object.values(appMod.resources);
  appRes.find((r) => r.type === "Microsoft.App/containerApps").properties.configuration.ingress.allowInsecure = true;
  const r = secDiff(before, mutated, readJson(P("existing")));
  record("sec-diff self-test: a planted allowInsecure=true regression is reported", r.unexpected.length === 1 && r.secRows.some((x) => x.status === "CHANGED" && /ingress/.test(x.label)));
}

// 7. fail() guards
log("\n## 7. fail() guards (each failing fixture must be rejected)");
const scope = defaultScope();
const registryRef = "ref(/subscriptions/33333333-3333-3333-3333-333333333333/resourcegroups/rg-squadmcp-fixture/providers/microsoft.containerregistry/registries/squadfixture).loginServer";
const guards = [
  ["create-endpoint-not-allowlisted", "must be listed in squad.allowedModelEndpoints"],
  ["create-missing-account-name", 'openAiAccountName is required when openAiMode is "create"'],
  ["create-no-deployments", "requires at least one entry in openAiDeployments"],
  ["acr-missing-resource-id", "containerRegistryResourceId must be /subscriptions/"],
  ["acr-wrong-resource-type", "must be a Microsoft.ContainerRegistry/registries resource id"],
  ["acr-loginserver-mismatch", "does not match the loginServer", { [registryRef]: "someoneelse.azurecr.io" }],
  ["openai-rbac-missing-account-name", "required when manageOpenAiRoleAssignment is true"],
  ["bad-encryption-key", "runEncryptionKeyBase64 must be empty or the base64 encoding"],
  ["bad-budget-start-date", "budgetStartDate must be empty (= first day of the current UTC month"],
];
for (const [name, expected, stubs] of guards) {
  const file = paramOut[`host/infra/tests/fixtures/failing/${name}.bicepparam`];
  try {
    evaluateTemplate(after, parameterValues(readJson(file)), scope, { stubs });
    record(`guard ${name}`, false, "template accepted a fixture it must reject");
  } catch (e) {
    const ok = e instanceof GuardFailure && e.guardMessage.includes(expected);
    record(`guard ${name}`, ok, ok ? `fail(): "${e.guardMessage}" (at ${e.where})` : e.message);
  }
}
// Positive control for the runtime login-server guard: a matching loginServer passes.
try {
  const r = evaluateTemplate(after, parameterValues(readJson(P("all-features-on"))), scope, { stubs: { [registryRef]: "squadfixture.azurecr.io" } });
  const acr = r.inventory.find((i) => i.type === "Microsoft.Authorization/roleAssignments" && String(i.properties?.roleDefinitionId).endsWith("7f951dda-4ed3-4680-a7ca-43fe172d538d"));
  record("guard acr-loginserver-match (positive control)", !!acr && !(acr.properties.principalId instanceof Unknown && /fail/.test(acr.properties.principalId.text)), "matching loginServer grants AcrPull");
} catch (e) {
  record("guard acr-loginserver-match (positive control)", false, e.message);
}
// Every positive fixture must evaluate without tripping a guard — under BOTH
// variable-evaluation models (lazy, and eager worst case).
for (const name of ["existing", "create", "cross-rg", "all-features-on"]) {
  for (const eagerVariables of [false, true]) {
    try {
      evaluateTemplate(after, parameterValues(readJson(P(name))), scope, { eagerVariables });
      record(`no guard fires for ${name} (${eagerVariables ? "eager" : "lazy"} variables)`, true);
    } catch (e) {
      record(`no guard fires for ${name} (${eagerVariables ? "eager" : "lazy"} variables)`, false, e.message);
    }
  }
}
for (const name of ["bootstrap-same-rg", "bootstrap-cross-rg"]) {
  try {
    evaluateTemplate(readJson(built["bootstrap/bootstrap.bicep"]), parameterValues(readJson(P(name))), defaultScope({ resourceGroup: null, deploymentName: "bootstrap", rgLocations: {} }), { eagerVariables: true });
    record(`no guard fires for ${name} (eager variables)`, true);
  } catch (e) {
    record(`no guard fires for ${name} (eager variables)`, false, e.message);
  }
}
try {
  evaluateTemplate(after, parameterValues(readJson(paramOut["host/infra/main.bicepparam"])), scope, { eagerVariables: true });
  record("no guard fires for main.bicepparam (eager variables)", true);
} catch (e) {
  record("no guard fires for main.bicepparam (eager variables)", false, e.message);
}

// 8. bootstrap + entra-app invariants
log("\n## 8. bootstrap.bicep / entra-app.bicep invariants");
const ROLE = {
  owner: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
  uaa: "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9",
  rbacAdmin: "f58310d9-a9f6-439a-9e8d-f62e7b41a168",
  contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
  acrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  openAiUser: "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
};
const APP_GUIDS = ["4633458b-17de-408a-b874-0445c86b69e6", "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3", "ba92f5b4-2d11-453d-a403-e96b0029c9fe", ROLE.acrPull, ROLE.openAiUser];
const bootstrap = readJson(built["bootstrap/bootstrap.bicep"]);
const subScope = defaultScope({ resourceGroup: null, deploymentName: "bootstrap", rgLocations: {} });
const roleGuidOf = (ra) => String(ra.properties.roleDefinitionId).split("/").pop().toLowerCase();
for (const name of ["bootstrap-same-rg", "bootstrap-cross-rg"]) {
  const checks = [];
  const chk = (label, ok) => checks.push([label, ok]);
  try {
    const pv = parameterValues(readJson(P(name)));
    const r = evaluateTemplate(bootstrap, pv, subScope);
    const inv = r.inventory.filter((i) => !i.module);
    const root = inv.filter((i) => i.deployedBy === "main");
    chk("AC-A4: subscription scope declares only resourceGroups + roleDefinitions", root.every((i) => ["Microsoft.Resources/resourceGroups", "Microsoft.Authorization/roleDefinitions"].includes(i.type)));
    const idRg = `/subscriptions/${subScope.subscriptionId}/resourcegroups/${pv.identityResourceGroupName}`.toLowerCase();
    const ras = inv.filter((i) => i.type === "Microsoft.Authorization/roleAssignments");
    chk("U1: no role assignment scoped to (or inside) the identity RG", ras.every((ra) => !ra.id.toLowerCase().startsWith(`${idRg}/`)));
    chk("U1: identities + FICs deployed into the identity RG only", inv.filter((i) => /userAssignedIdentities/.test(i.type)).every((i) => i.id.toLowerCase().startsWith(`${idRg}/`)));
    chk("S12: every role assignment principalType ServicePrincipal", ras.every((ra) => ra.properties.principalType === "ServicePrincipal"));
    chk("no Owner / User Access Administrator grant", ras.every((ra) => ![ROLE.owner, ROLE.uaa].includes(roleGuidOf(ra))));
    const admins = ras.filter((ra) => roleGuidOf(ra) === ROLE.rbacAdmin);
    const planRef = (s) => /id-squad-ci-plan-prod\)\.principalid/i.test(s);
    const deployRef = (s) => /id-squad-ci-deploy-prod\)\.principalid/i.test(s);
    chk("S4/C1: every RBAC Administrator grant has conditionVersion 2.0 + condition", admins.length > 0 && admins.every((ra) => ra.properties.conditionVersion === "2.0" && typeof ra.properties.condition === "string"));
    for (const ra of admins) {
      const c = ra.properties.condition;
      const guidsIn = (src) => {
        const m = new RegExp(`@${src}\\[Microsoft\\.Authorization/roleAssignments:RoleDefinitionId\\] ForAnyOfAnyValues:GuidEquals \\{([^}]*)\\}`).exec(c);
        return m ? m[1].split(",").map((s) => s.trim()) : null;
      };
      const excl = [...c.matchAll(/:PrincipalId\] ForAnyOfAllValues:GuidNotEquals \{([^}]*)\}/g)].map((m) => m[1]);
      const onResource = /\/providers\/Microsoft\.(ContainerRegistry\/registries|CognitiveServices\/accounts)\/[^/]+\/providers\/Microsoft\.Authorization\/roleAssignments\//.test(ra.id);
      const expected = onResource ? (ra.id.includes("ContainerRegistry") ? [ROLE.acrPull] : [ROLE.openAiUser]) : APP_GUIDS;
      const where = onResource ? "resource-scope single-GUID (C2)" : "app RG 5-GUID (S4)";
      chk(`${where}: write + delete allow-lists == ${expected.length} GUID(s)`, JSON.stringify(guidsIn("Request")) === JSON.stringify(expected) && JSON.stringify(guidsIn("Resource")) === JSON.stringify(expected));
      chk(`${where}: PrincipalType ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'} on write AND delete`, (c.match(/:PrincipalType\] ForAnyOfAnyValues:StringEqualsIgnoreCase \{'ServicePrincipal'\}/g) || []).length === 2);
      chk(`${where}: PrincipalId GuidNotEquals excludes BOTH CI principals on write AND delete`, excl.length === 2 && excl.every((e) => planRef(e) && deployRef(e)));
      chk(`${where}: no unreplaced placeholder`, !/__[A-Z_]+__/.test(c));
    }
    const cond = admins[0]?.properties.condition || "";
    log(`    [${name}] app-RG RBAC Administrator condition (principal ids symbolic until deploy):\n      ${cond}`);
    const defs = inv.filter((i) => i.type === "Microsoft.Authorization/roleDefinitions");
    chk("AC-A7: custom role names carry the env + subscription discriminator", defs.every((d) => d.properties.roleName.endsWith(`-prod-${subScope.subscriptionId}`)));
    chk("AC-A7: assignableScopes de-duplicated (union)", defs.every((d) => new Set(d.properties.assignableScopes).size === d.properties.assignableScopes.length));
    const acrBuild = defs.find((d) => d.properties.roleName.startsWith("squad-ci-acr-build"));
    const acrActions = acrBuild?.properties.permissions[0].actions || [];
    chk("C3: squad-ci-acr-build = registries/read, listBuildSourceUploadUrl, scheduleRun, runs/read, runs/listLogSasUrl", JSON.stringify([...acrActions].sort()) === JSON.stringify(["Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action", "Microsoft.ContainerRegistry/registries/read", "Microsoft.ContainerRegistry/registries/runs/listLogSasUrl/action", "Microsoft.ContainerRegistry/registries/runs/read", "Microsoft.ContainerRegistry/registries/scheduleRun/action"]));
    const planReader = defs.find((d) => d.properties.roleName.startsWith("squad-ci-plan-reader"));
    chk("S6: squad-ci-plan-reader = */read + deployments validate/whatIf only", JSON.stringify(planReader?.properties.permissions[0].actions) === JSON.stringify(["*/read", "Microsoft.Resources/deployments/validate/action", "Microsoft.Resources/deployments/whatIf/action"]));
    const fics = inv.filter((i) => /federatedIdentityCredentials$/.test(i.type));
    const subj = (n) => fics.filter((f) => f.id.includes(`/userAssignedIdentities/id-squad-ci-${n}-prod/`)).map((f) => f.properties.subject).sort();
    chk("S6: ciPlanIdentity subjects == pull_request + ref:refs/heads/main", JSON.stringify(subj("plan")) === JSON.stringify([`repo:${pv.githubRepository}:pull_request`, `repo:${pv.githubRepository}:ref:refs/heads/main`]));
    chk("ciDeployIdentity subject == environment:prod", JSON.stringify(subj("deploy")) === JSON.stringify([`repo:${pv.githubRepository}:environment:prod`]));
    const planRas = ras.filter((ra) => planRef(String(ra.properties.principalId)));
    chk("S6: ciPlanIdentity holds only squad-ci-plan-reader", planRas.length > 0 && planRas.every((ra) => roleGuidOf(ra) === planReader?.name.toLowerCase()));
    const cross = pv.openAiAccountResourceId !== undefined && pv.openAiAccountResourceId !== "";
    chk(cross ? "cross-RG: single-GUID admin at registry AND AOAI resource scope" : "same-RG: no cross-RG role definition / resource-scope admin", cross ? admins.length === 3 : admins.length === 1 && !defs.some((d) => d.properties.roleName.startsWith("squad-ci-cross-rg-deploy")));
    log(`    [${name}] role assignments:`);
    for (const ra of ras) log(`      ${roleGuidOf(ra)} -> ${planRef(String(ra.properties.principalId)) ? "ciPlanIdentity" : "ciDeployIdentity"} at ${ra.id.split("/providers/Microsoft.Authorization/")[0]}`);
  } catch (e) {
    chk(`evaluate ${name}: ${e.message}`, false);
  }
  for (const [label, ok] of checks) record(`${name}: ${label}`, ok);
}
// FIC dependsOn chain (compiled template, A11)
const ciMod = (Array.isArray(bootstrap.resources) ? bootstrap.resources : Object.values(bootstrap.resources)).find((r) => /ci-identities/.test(r.name));
const ciRes = ciMod.properties.template.resources;
const ciList = Array.isArray(ciRes) ? ciRes : Object.values(ciRes);
const fic = (n) => ciList.find((r) => /federatedIdentityCredentials/.test(r.type) && r.name.includes(n));
record("A11: FIC chain github-main dependsOn github-pull-request; deploy FIC dependsOn github-main", (fic("github-main")?.dependsOn || []).some((d) => d.includes("github-pull-request")) && (fic("github-environment")?.dependsOn || []).some((d) => d.includes("github-main")));
try {
  evaluateTemplate(bootstrap, parameterValues(readJson(paramOut["host/infra/tests/fixtures/failing/bootstrap-identity-rg-overlap.bicepparam"])), subScope);
  record("guard bootstrap-identity-rg-overlap (U1)", false, "accepted an identity RG equal to the app RG");
} catch (e) {
  record("guard bootstrap-identity-rg-overlap (U1)", e instanceof GuardFailure && /dedicated resource group/.test(e.guardMessage), e.guardMessage || e.message);
}
// entra-app
try {
  const entra = readJson(built["bootstrap/entra-app.bicep"]);
  const r = evaluateTemplate(entra, parameterValues(readJson(P("entra-app"))), scope);
  const app = r.inventory.find((i) => i.type.startsWith("Microsoft.Graph/applications"));
  const sp = r.inventory.find((i) => i.type.startsWith("Microsoft.Graph/servicePrincipals"));
  const body = app.properties;
  const scopes = body.api.oauth2PermissionScopes;
  const admin = scopes.filter((s) => s.type === "Admin").map((s) => s.value).sort();
  const e = (label, ok) => record(`entra-app: ${label}`, ok);
  e("S8: uniqueName set", typeof body.uniqueName === "string" && body.uniqueName.length > 0);
  e("S8/C6: api.requestedAccessTokenVersion == 2", body.api.requestedAccessTokenVersion === 2);
  e("S8: identifierUris = api://<tenantId>/<uniqueName>, no appId self-reference", body.identifierUris.length === 1 && body.identifierUris[0] === `api://${scope.tenantId}/${body.uniqueName}`);
  e("S8: 11 delegated scopes, declared unconditionally, all enabled", scopes.length === 11 && scopes.every((s) => s.isEnabled === true) && !(Array.isArray(entra.resources) ? entra.resources : Object.values(entra.resources)).some((x) => x.condition));
  e("S8: Admin-consent-only == Squad.Backlog, Squad.Federate, Squad.MemoryWrite, Squad.Run", JSON.stringify(admin) === JSON.stringify(["Squad.Backlog", "Squad.Federate", "Squad.MemoryWrite", "Squad.Run"]));
  e("S8: Squad.Operate allowedMemberTypes == ['User']", JSON.stringify(body.appRoles.map((x) => [x.value, x.allowedMemberTypes])) === JSON.stringify([["Squad.Operate", ["User"]]]));
  e("S8: no passwordCredentials / keyCredentials", !("passwordCredentials" in body) && !("keyCredentials" in body) && !/passwordCredentials|keyCredentials/.test(readFileSync(join(infra, "bootstrap/entra-app.bicep"), "utf8").replace(/\/\/.*$/gm, "")));
  e("S8: servicePrincipal declared for the application", !!sp && String(sp.properties.appId).includes(".appId"));
  e("scope ids deterministic (guid of uniqueName + value)", new Set(scopes.map((s) => s.id)).size === 11);
} catch (err) {
  record("entra-app evaluation", false, err.message);
}

// 9. determinism: no runtime value in any resource / module name (AC-A9)
log("\n## 9. deterministic names (no module output / reference() in any name)");
function nameProblems(template, parentParams, path) {
  const probs = [];
  const res = Array.isArray(template.resources) ? template.resources : Object.values(template.resources || {});
  const vars = template.variables || {};
  const expand = (text, seen = new Set()) =>
    String(text).replace(/variables\('([^']+)'\)/g, (m, v) => {
      if (seen.has(v) || vars[v] === undefined) return m;
      seen.add(v);
      return `(${expand(JSON.stringify(vars[v]), seen)})`;
    });
  for (const r of res) {
    const fields = [r.name, r.scope, r.resourceGroup, r.subscriptionId].filter((v) => v !== undefined).map((v) => expand(JSON.stringify(v)));
    for (const f of fields) {
      if (/reference\(|list[A-Za-z]*\(/.test(f)) probs.push(`${path}: ${r.type} name/scope uses a runtime value: ${f.slice(0, 160)}`);
      for (const m of f.matchAll(/parameters\('([^']+)'\)/g)) {
        const pv = parentParams?.[m[1]];
        if (pv && /reference\(|list[A-Za-z]*\(/.test(JSON.stringify(pv))) probs.push(`${path}: ${r.type} name/scope uses parameter '${m[1]}' fed from a runtime value`);
      }
    }
    if (r.type === "Microsoft.Resources/deployments" && r.properties?.template) {
      const vals = Object.fromEntries(Object.entries(r.properties.parameters || {}).map(([k, v]) => [k, expand(JSON.stringify(typeof v === "string" ? v : v.value))]));
      probs.push(...nameProblems(r.properties.template, vals, `${path}/${String(r.name).slice(0, 60)}`));
    }
  }
  return probs;
}
for (const f of ["main.bicep", "bootstrap/bootstrap.bicep"]) {
  const probs = nameProblems(readJson(built[f]), null, f);
  probs.forEach((p) => log(`    ${p}`));
  record(`deterministic names: ${f}`, probs.length === 0, probs.length ? `${probs.length} problem(s)` : "every resource/module name, scope and guid() input is start-of-deployment computable");
}

// 10. C8: runEncryptionKeyBase64 never committed as a literal
log("\n## 10. security C8: committed .bicepparam files never carry the run-encryption key");
const keyProblems = [];
for (const f of walk(join(repoRoot, "host"), (p) => p.endsWith(".bicepparam") && !p.endsWith(".local.bicepparam"))) {
  readFileSync(f, "utf8")
    .split(/\r?\n/)
    .forEach((line, n) => {
      const m = /^\s*param\s+runEncryptionKeyBase64\s*=\s*(.+?)\s*$/.exec(line);
      if (m && !/^readEnvironmentVariable\('[A-Z0-9_]+'(\s*,\s*'')?\)$/.test(m[1])) keyProblems.push(`${rel(f)}:${n + 1}`);
    });
}
record("no literal runEncryptionKeyBase64 in any committed .bicepparam", keyProblems.length === 0, keyProblems.join(", ") || "only readEnvironmentVariable('<VAR>'[, '']) is allowed");

// 11. source-level byte-identity (D2 / A8)
log("\n## 11. env concat order byte-identical to baseline source");
const baseSrc = readFileSync(baseMain, "utf8");
const newSrc = readFileSync(join(infra, "main.bicep"), "utf8");
const concats = [...baseSrc.matchAll(/env: (concat\([^\n]*)/g)].map((m) => m[1].trim());
for (const c of concats) record(`concat preserved: ${c.slice(0, 90)}...`, newSrc.includes(c));
const lf = (s) => s.replace(/\r\n/g, "\n");
const bsrc = lf(baseSrc);
const nsrc = lf(newSrc);
const paramBlocks = [...bsrc.matchAll(/(^@[^\n]*\n)*^param [^\n]*/gm)].map((m) => m[0]);
const blockName = (b) => /^param (\w+)/m.exec(b)[1];
const drifted = paramBlocks.filter((b) => !nsrc.includes(b) && !EXPECTED_CHANGED_PARAMS[blockName(b)]);
const intendedDrift = paramBlocks.filter((b) => !nsrc.includes(b) && EXPECTED_CHANGED_PARAMS[blockName(b)]).map(blockName);
record(`source: ${paramBlocks.length - intendedDrift.length}/${paramBlocks.length} baseline param declarations byte-identical; reviewed changes only: ${intendedDrift.join(", ") || "none"}`, paramBlocks.length > 0 && drifted.length === 0, drifted.map((d) => d.split("\n").pop()).join("; "));
const typeBlock = (/@description\('Squad MCP application[^\n]*\ntype SquadConfig = \{[\s\S]*?\n\}/.exec(bsrc) || [""])[0];
record("source: SquadConfig type block byte-identical", typeBlock.length > 0 && nsrc.includes(typeBlock));
const envVarNames = [...bsrc.matchAll(/^var (\w+Env) = /gm)].map((m) => m[1]).filter((n) => n !== "webBaseEnv");
const envDrift = envVarNames.filter((n) => {
  const m = new RegExp(`var ${n} = [\\s\\S]*?\\n(?=\\n)`).exec(bsrc);
  return !m || !nsrc.includes(m[0]);
});
record(`source: ${envVarNames.length} env-var blocks byte-identical (webBaseEnv changes only endpoint/deployment/client-id sources, proven equal by sec-diff)`, envDrift.length === 0, envDrift.join(", "));

// 12. environments/prod.bicepparam (cicd escalation D1a) + placeholder preflight
log("\n## 12. environments/prod.bicepparam (env-var driven) and the placeholder preflight");
const prodFile = join(infra, "environments", "prod.bicepparam");
const prodOut = (name) => join(out, "prod", `${name}.parameters.json`);
mkdirSync(join(out, "prod"), { recursive: true });
const buildProd = (name, env) => {
  const r = az(["bicep", "build-params", "--file", prodFile, "--outfile", prodOut(name)], env);
  return { ...r, json: r.code === 0 ? readJson(prodOut(name)) : null };
};
const pv = (j, n) => j?.parameters?.[n]?.value;
const noPlaceholders = (file) => spawnSync(process.execPath, [join(here, "check-no-placeholders.mjs"), file], { encoding: "utf8" });

// 12a. full fake env: builds, no placeholders, no guard fires, wiring is right.
const full = { code: paramOut["host/infra/environments/prod.bicepparam"] ? 0 : 1, json: readJson(paramOut["host/infra/environments/prod.bicepparam"]) };
record("prod: builds with a full fake env set", full.code === 0 && Object.keys(full.json.parameters).length === Object.keys(after.parameters).length - 1, `${Object.keys(full.json.parameters).length} params (every main.bicep param except location)`);
record("prod: audience defaults to the appId GUID (v2 aud); issuer is /v2.0", pv(full.json, "squad").audience === PROD_REQUIRED_ENV.SQUAD_INFRA_ENTRA_CLIENT_ID && pv(full.json, "squad").allowedIssuers.endsWith("/v2.0") && pv(full.json, "authOpenIdIssuer").endsWith("/v2.0"));
record("prod: CSV list -> trimmed array (budgetAlertEmails)", JSON.stringify(pv(full.json, "budgetAlertEmails")) === JSON.stringify(["alerts@example.com", "oncall@example.com"]));
record("prod: bool 'True' / int '8' parsed", pv(full.json, "enableRemotePipeline") === true && pv(full.json, "squad").tenantConcurrency === 8);
const pre = noPlaceholders(paramOut["host/infra/environments/prod.bicepparam"]);
record("preflight: prod (full env) has no <PLACEHOLDER> -> exit 0", pre.status === 0, pre.stdout.trim());
for (const eager of [false, true]) {
  try {
    const r = evaluateTemplate(after, parameterValues(full.json), scope, { eagerVariables: eager, stubs: { [registryRef]: "squadfixture.azurecr.io" } });
    const budget = r.inventory.find((i) => i.type === "Microsoft.Consumption/budgets");
    record(`prod: no guard fires against main.json (${eager ? "eager" : "lazy"} variables); pinned budget start kept`, budget?.properties.timePeriod.startDate === "2026-07-01");
  } catch (e) {
    record(`prod: no guard fires against main.json (${eager ? "eager" : "lazy"} variables)`, false, e.message);
  }
}

// 12b. required-only env: every optional param equals main.bicep's own default.
const minimal = buildProd("required-only", PROD_REQUIRED_ENV);
const parity = [];
if (minimal.json) {
  for (const [n, v] of Object.entries(minimal.json.parameters)) {
    const d = after.parameters[n]?.defaultValue;
    if (d === undefined) continue; // required in main.bicep: supplied by a required env var
    if (typeof d === "string" && d.startsWith("[")) {
      if (v.value !== "") parity.push(`${n}: expression default in main.bicep, prod must pass '' (got ${JSON.stringify(v.value)})`);
    } else if (JSON.stringify(canonical(d)) !== JSON.stringify(canonical(v.value))) parity.push(`${n}: ${JSON.stringify(v.value)} != main default ${JSON.stringify(d)}`);
  }
}
record("prod: required-only env builds and every optional param equals main.bicep's default (or '' for expression defaults)", minimal.code === 0 && parity.length === 0, parity.join("; ") || `${Object.keys(minimal.json?.parameters || {}).length} params`);
try {
  const r = evaluateTemplate(after, parameterValues(minimal.json), scope, { eagerVariables: true });
  const budget = r.inventory.find((i) => i.type === "Microsoft.Consumption/budgets");
  const oaiRg = r.inventory.filter((i) => i.module).map((i) => i.name);
  record("prod: required-only -> budget start = first day of the current UTC month; no OpenAI / AcrPull module (U4, D8)", budget?.properties.timePeriod.startDate === "2026-09-01" && !oaiRg.some((n) => /openai|acr-pull/.test(n)), `startDate=${budget?.properties.timePeriod.startDate}`);
} catch (e) {
  record("prod: required-only evaluates", false, e.message);
}

// 12c. every required var missing in turn -> the build fails and names the var.
for (const name of Object.keys(PROD_REQUIRED_ENV)) {
  const env = { ...PROD_REQUIRED_ENV };
  delete env[name];
  const r = buildProd(`missing-${name}`, env);
  record(`prod: fails clearly without ${name}`, r.code !== 0 && r.text.includes(name), (r.text.split("\n").find((l) => l.includes(name)) || r.text.split("\n")[0] || "").replace(/^.*?(Error BCP\d+)/, "$1").slice(0, 200));
}
// 12d. conditional / malformed inputs.
const negative = [
  ["existing mode without model endpoint", { SQUAD_INFRA_MODEL_ENDPOINT: undefined }, "SQUAD_INFRA_MODEL_ENDPOINT is required when SQUAD_INFRA_OPENAI_MODE"],
  ["non-boolean flag", { SQUAD_INFRA_ENABLE_WORKER: "yes" }, "enableWorker"],
  ["non-integer number", { SQUAD_INFRA_TENANT_CONCURRENCY: "four" }, "squad"],
  ["'*' in allowed origins", { SQUAD_INFRA_ALLOWED_ORIGINS: "https://a.example, *" }, "must not contain"],
  ["empty alert email list", { SQUAD_INFRA_BUDGET_ALERT_EMAILS: " , " }, "must list at least one address"],
  ["deployment without model name", { SQUAD_INFRA_OPENAI_DEPLOYMENT_NAME: "gpt-4o", SQUAD_INFRA_OPENAI_MODEL_VERSION: "2024-11-20" }, "SQUAD_INFRA_OPENAI_MODEL_NAME and SQUAD_INFRA_OPENAI_MODEL_VERSION are required"],
];
for (const [label, delta, expected] of negative) {
  const env = { ...PROD_REQUIRED_ENV };
  for (const [k, v] of Object.entries(delta)) if (v === undefined) delete env[k]; else env[k] = v;
  const r = buildProd(`neg-${label.replace(/\W+/g, "-")}`, env);
  record(`prod: rejects ${label}`, r.code !== 0 && r.text.includes(expected), (r.text.split("\n").find((l) => /Error/.test(l)) || "").replace(/^.*?(Error BCP\d+)/, "$1").slice(0, 200));
}
// 12e. create mode: endpoint/deployment/allow-list derive so the A6 guard passes.
{
  const env = { ...PROD_REQUIRED_ENV, SQUAD_INFRA_OPENAI_MODE: "create", SQUAD_INFRA_OPENAI_ACCOUNT_NAME: "squadfixture-aoai", SQUAD_INFRA_OPENAI_DEPLOYMENT_NAME: "gpt-4o", SQUAD_INFRA_OPENAI_MODEL_NAME: "gpt-4o", SQUAD_INFRA_OPENAI_MODEL_VERSION: "2024-11-20" };
  delete env.SQUAD_INFRA_MODEL_ENDPOINT;
  delete env.SQUAD_INFRA_MODEL_DEPLOYMENT;
  const r = buildProd("create", env);
  try {
    const ev = evaluateTemplate(after, parameterValues(r.json), scope, { eagerVariables: true });
    const acct = ev.inventory.find((i) => i.type === "Microsoft.CognitiveServices/accounts");
    const dep = ev.inventory.find((i) => i.type === "Microsoft.CognitiveServices/accounts/deployments");
    record("prod: create mode derives endpoint + allow-list (A6 guard passes); K1 default GlobalStandard/10; account in the app RG", r.code === 0 && acct?.properties.disableLocalAuth === true && dep?.sku.name === "GlobalStandard" && dep?.sku.capacity === 10 && acct.id.includes("/resourceGroups/rg-squadmcp-fixture/"));
  } catch (e) {
    record("prod: create mode evaluates", false, e.message || r.text);
  }
}
// 12f. legacy api:// audience still honored when set explicitly.
{
  const r = buildProd("legacy-audience", { ...PROD_REQUIRED_ENV, SQUAD_INFRA_AUDIENCE: "api://11111111-1111-1111-1111-111111111111" });
  record("prod: an existing api:// environment keeps its audience via SQUAD_INFRA_AUDIENCE", pv(r.json, "squad")?.audience === "api://11111111-1111-1111-1111-111111111111");
}
// 12g. the run-encryption key is env-only, secure in main.bicep, and never committed.
{
  const r = buildProd("with-key", { ...PROD_REQUIRED_ENV, SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64: DUMMY_KEY });
  record("prod: run-encryption key read from SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64 (default ''), param is securestring", pv(r.json, "runEncryptionKeyBase64") === DUMMY_KEY && pv(minimal.json, "runEncryptionKeyBase64") === "" && after.parameters.runEncryptionKeyBase64.type === "securestring");
}
// 12h. preflight negative + self-tests.
{
  const mainPre = noPlaceholders(paramOut["host/infra/main.bicepparam"]);
  record("preflight: main.bicepparam template still has placeholders -> exit 1 (lists path + token only)", mainPre.status === 1 && /squad\.audience still contains <ENTRA_CLIENT_ID>/.test(mainPre.stdout), `${mainPre.stdout.trim().split("\n").length} hit(s)`);
  const planted = { parameters: { a: { value: { b: ["ok", "x-<SUB_ID>-y"] } }, c: { value: "<ref(not a placeholder)>" } } };
  const hits = findPlaceholders(planted);
  record("preflight self-test: nested placeholder found; lowercase <ref(...)> ignored", hits.length === 1 && hits[0].path === "a.b[1]" && hits[0].token === "<SUB_ID>");
  const bad = noPlaceholders(join(out, "does-not-exist.json"));
  record("preflight: unreadable input -> exit 2", bad.status === 2);
}
// 12i. the documented contract and the file agree exactly (cicd maps these names).
{
  const fileVars = new Set([...readFileSync(prodFile, "utf8").matchAll(/readEnvironmentVariable\('([A-Z0-9_]+)'/g)].map((m) => m[1]));
  const docVars = new Set([...readFileSync(join(infra, "environments", "README.md"), "utf8").matchAll(/^\| `(SQUAD_INFRA_[A-Z0-9_]+)` \|/gm)].map((m) => m[1]));
  const onlyFile = [...fileVars].filter((v) => !docVars.has(v));
  const onlyDoc = [...docVars].filter((v) => !fileVars.has(v));
  record(`prod: env-var contract table == variables read by prod.bicepparam (${fileVars.size})`, fileVars.size > 0 && onlyFile.length === 0 && onlyDoc.length === 0, [...onlyFile.map((v) => `undocumented ${v}`), ...onlyDoc.map((v) => `unused ${v}`)].join(", "));
  record("prod: every variable uses the SQUAD_INFRA_ prefix", [...fileVars].every((v) => v.startsWith("SQUAD_INFRA_")));
}

// Summary
const failed = results.filter((r) => !r.ok);
log(`\n## Summary: ${results.length - failed.length}/${results.length} checks passed; lint ${lintErrors} error(s), ${lintWarnings} warning(s)`);
failed.forEach((f) => log(`FAILED: ${f.step} ${f.detail}`));
writeFileSync(join(out, "validation-report.md"), report.join("\n"));
writeFileSync(join(out, "validation-summary.json"), JSON.stringify({ results, lintErrors, lintWarnings }, null, 2));
process.exit(failed.length ? 1 : 0);
