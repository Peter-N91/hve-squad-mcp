import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot } from "../../src/paths.js";

const bicep = readFileSync(join(packageRoot(), "host", "infra", "main.bicep"), "utf8");
const params = readFileSync(join(packageRoot(), "host", "infra", "main.bicepparam"), "utf8");

test("per-user deployment stays opt-in and shares durable run, credential and flow tables", () => {
  assert.match(bicep, /param enablePerUserGithub bool = false/);
  assert.match(bicep, /param stageExecutor string = 'builtin'/);
  assert.match(params, /param enablePerUserGithub = false/);
  assert.match(bicep, /enableRemotePipeline \|\| enableMemoryTable \|\| enablePerUserGithub/);
  for (const table of ["githubLinkTable", "githubLinkFlowTable"]) {
    assert.match(bicep, new RegExp(`resource ${table} '[^']+' = if \\(enablePerUserGithub\\)`));
  }
  assert.match(bicep, /SQUAD_MCP_GITHUB_LINK_STORE', value: 'table'/);
  assert.match(bicep, /SQUAD_MCP_RUN_STATE_BACKEND', value: 'table'/);
});

test("all Copilot runtime policy reaches both processes without sharing a filesystem owner", () => {
  const runtime = bicep.slice(bicep.indexOf("var runtimeEnv ="), bicep.indexOf("var webRuntimeEndpointEnv"));
  for (const variable of [
    "STAGE_EXECUTOR", "COPILOT_CONNECTION_TOKEN", "COPILOT_MODEL", "COPILOT_ROUTING",
    "UPSTREAM_RUNTIME_ENABLED", "COPILOT_TOOLS", "COPILOT_SUBAGENTS", "COPILOT_ALLOW_SHELL",
    "COPILOT_ALLOWED_HOSTS", "COPILOT_SANDBOX_WORKSPACE", "COPILOT_IDENTITY_REVERIFY_MS", "COPILOT_SESSION_STATE_DIR",
  ]) assert.ok(runtime.includes(`SQUAD_MCP_${variable}`), variable);
  const web = bicep.slice(bicep.indexOf("resource app "), bicep.indexOf("resource authConfig "));
  const worker = bicep.slice(bicep.indexOf("resource workerJob "), bicep.indexOf("resource budget "));
  for (const text of [web, worker]) {
    assert.match(text, /perUserEnv, runtimeEnv/);
    assert.match(text, /clientAllowListEnv/);
    assert.match(text, /volumeMounts: sessionMounts/);
    assert.match(text, /volumes: sessionVolumes/);
    assert.match(text, /memoryEncryptionEnv, renderEnv, memoryEnv, businessEnv/);
  }
  assert.match(web, /maxReplicas: enableCopilot \? 1 : maxReplicas/);
  assert.match(web, /activeRevisionsMode: 'Single'/);
  assert.match(web, /webRuntimeEndpointEnv/);
  assert.match(worker, /workerRuntimeEndpointEnv/);
  assert.match(bicep, /SQUAD_MCP_COPILOT_CLI_URL', value: workerCopilotCliUrl != copilotCliUrl \? workerCopilotCliUrl : ''/);
  assert.match(worker, /replicaRetryLimit: enableCopilot \? 0 : 1/);
  assert.match(bicep, /@minValue\(2700\)\s+param workerReplicaTimeoutSeconds int = 2700/);
  assert.match(worker, /replicaTimeout: workerReplicaTimeoutSeconds/);
  assert.match(worker, /cronExpression: enableCopilot \? copilotWorkerCron : workerCron/);
  assert.match(bicep, /@minLength\(1\)\s+param copilotSessionStorageName/);
  assert.match(bicep, /storageName: copilotSessionStorageName/);
  assert.match(bicep, /mountPath: copilotSessionStateDir/);
  assert.doesNotMatch(bicep, /accountKey:|storage!\.listKeys|fileServices\/shares@/);
});

test("secrets use identity-backed Key Vault references and separate keyring configuration", () => {
  const secrets = bicep.slice(bicep.indexOf("var encryptionSecrets ="), bicep.indexOf("var encryptionEnv ="));
  assert.doesNotMatch(secrets, /\bvalue:/);
  for (const name of ["run-encryption-key", "github-client-secret", "link-entra-client-secret",
    "github-link-key", "github-link-old-keys", "copilot-connection-token"]) assert.ok(secrets.includes(name), name);
  assert.match(secrets, /keyVaultUrl:/);
  assert.match(secrets, /identity: identity.id/);
  for (const variable of ["GITHUB_CLIENT_SECRET", "LINK_ENTRA_CLIENT_SECRET", "GITHUB_LINK_KEY_B64",
    "GITHUB_LINK_OLD_KEYS", "COPILOT_CONNECTION_TOKEN"]) {
    assert.match(bicep, new RegExp(`name: 'SQUAD_MCP_${variable}', secretRef:`));
    assert.doesNotMatch(bicep, new RegExp(`name: 'SQUAD_MCP_${variable}', value:`));
  }
  assert.match(bicep, /SQUAD_MCP_GITHUB_LINK_KEY_ID', value: githubLinkKeyId/);
  assert.match(bicep, /!enablePerUserGithub\) \? \[\{ name: 'copilot-github-token'/);
});

test("Copilot web readiness checks the SDK during idle periods without changing builtin deployments", () => {
  const probes = bicep.slice(bicep.indexOf("var copilotServerProbes ="), bicep.indexOf("var sessionVolumes ="));
  assert.match(probes, /enableCopilot \? \[/);
  assert.match(probes, /type: 'Readiness'/);
  assert.match(probes, /path: '\/readyz'/);
  assert.match(probes, /port: 3000/);
  assert.match(probes, /periodSeconds: 10/);
  assert.match(probes, /timeoutSeconds: 5/);
  assert.match(probes, /failureThreshold: 3/);
  assert.match(probes, /\] : \[\]/);
  const web = bicep.slice(bicep.indexOf("resource app "), bicep.indexOf("resource authConfig "));
  assert.match(web, /probes: copilotServerProbes/);
});

test("ingress remains authenticated with exact conditional browser route exclusions", () => {
  const auth = bicep.slice(bicep.indexOf("resource authConfig "), bicep.indexOf("resource storage "));
  assert.match(auth, /unauthenticatedClientAction: 'Return401'/);
  assert.doesNotMatch(auth, /AllowAnonymous/);
  assert.match(auth, /excludedPaths: enablePerUserGithub \?/);
  const exclusions = auth.slice(auth.indexOf("excludedPaths:"), auth.indexOf("] : []"));
  assert.deepEqual([...exclusions.matchAll(/'([^']+)'/g)].map(([, value]) => value), [
    "/github/link/start", "/github/link/entra-callback", "/github/link/callback", "/github/link/confirm",
  ]);
  assert.match(auth, /allowedAudiences: allAudiences/);
  assert.match(bicep, /SQUAD_MCP_AUDIENCE', value: join\(allAudiences, ','\)/);
  assert.match(bicep, /SQUAD_MCP_ALLOWED_CLIENTS', value: allowedClientsJson/);
  for (const name of ["ALLOWED_ISSUERS", "ALLOWED_TENANTS", "JWKS_URI"]) assert.ok(bicep.includes(`SQUAD_MCP_${name}`));
});
