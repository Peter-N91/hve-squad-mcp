import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog } from "../../src/catalog/catalog.js";
import { requiredScopeFor } from "../../src/auth/scopes.js";
import { packageRoot } from "../../src/paths.js";
import { PerUserCopilotCredentials } from "../../src/engine/copilot/user-credentials.js";
import { UserIdentityGate } from "../../src/transports/user-identity-gate.js";
import type { SquadMemoryStore } from "../../src/engine/squad-memory-state.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";
import { remoteToolAnnotations } from "../../src/transports/remote-tool-metadata.js";
import { buildHarness, initializeSession } from "../conformance/support/harness.js";
import { bearer } from "../conformance/support/fake-auth.js";
import {
  buildApiProperties, buildConnectorManifest, buildSwagger, connectorRequestedScopes, connectorTools,
} from "../../generators/build-copilot-studio-connector.js";
import { buildCoworkTools, coworkRequestedScopes } from "../../generators/build-cowork-package.js";

const catalog = loadCatalog();
const manifest = buildConnectorManifest(catalog);
const all = connectorTools(manifest);
const root = packageRoot();
const generated = join(root, "generated", "copilot-studio-connector");

function identityGate(): UserIdentityGate {
  return new UserIdentityGate({
    credentials: new PerUserCopilotCredentials({
      tokens: { async tokenFor() { throw new Error("not linked"); } },
      verifier: { async verify() { return { models: [] }; } },
    }),
    executionTools: new Set(),
    link: {
      async begin() { return { url: "https://example.invalid/github/link/start", expiresAt: Date.now() }; },
      async status() { return { linked: false }; }, async unlink() {},
    },
  });
}

test("Studio apiProperties validates against the pinned official PowerPlatformConnectors schema", async () => {
  // Source: microsoft/PowerPlatformConnectors, dev/schemas/paconn-apiProperties.schema.json,
  // fetched 2026-10-17. That document has one inline JSONC comment; remove only
  // that known comment, keeping the official validation constraints unchanged.
  const bytes = readFileSync(join(root, "test", "packaging", "fixtures", "paconn-apiProperties.schema.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "a5fe436fc9c3a07697e8a450a8e3851436bd5a409afa14e13f0963fb6e949475");
  const schema = JSON.parse(bytes.toString().replace(
    /("@Request\.OriginalHTTPMethod")\s*\/\/ Same as not being specified/g, "$1",
  ));
  delete schema.id; // legacy identifier metadata, not a validation constraint
  const unwrap = (mod: unknown): any => {
    let value = mod as any;
    while (typeof value !== "function" && value.default) value = value.default;
    return value;
  };
  const Ajv = unwrap(await import("ajv"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  unwrap(await import("ajv-formats"))(ajv);
  const validate = ajv.compile(schema);
  const props = buildApiProperties(manifest);
  assert.equal(validate(props), true, JSON.stringify(validate.errors));
  const invalid = structuredClone(props) as any;
  delete invalid.properties.connectionParameters.token.oAuthSettings.customParameters.resourceUri;
  assert.equal(validate(invalid), false, "aad requires resourceUri");
});

test("Studio uses documented aad OAuth settings, resource delegated scopes and no secret", () => {
  const properties = buildApiProperties(manifest) as any;
  const oauth = properties.properties.connectionParameters.token.oAuthSettings;
  assert.equal(oauth.identityProvider, "aad");
  assert.equal(oauth.clientId, "<ENTRA_CONNECTOR_CLIENT_ID>");
  assert.equal(oauth.redirectMode, "Global");
  assert.equal(oauth.properties.IsFirstParty, "False");
  assert.equal(oauth.properties.AzureActiveDirectoryResourceId, "api://<SQUAD_RESOURCE_CLIENT_ID>");
  assert.equal(oauth.customParameters.resourceUri.value, oauth.properties.AzureActiveDirectoryResourceId);
  assert.equal(oauth.customParameters.tenantId.value, "<ENTRA_TENANT_ID>");
  assert.deepEqual(oauth.scopes, connectorRequestedScopes(manifest));
  assert.equal(oauth.scopes.at(-1), "offline_access");
  assert.doesNotMatch(JSON.stringify(properties), /aadcertificate|clientSecret/);
  assert.deepEqual(JSON.parse(readFileSync(join(generated, "apiProperties.json"), "utf8")), properties);
  const scopes = new Set(oauth.scopes);
  for (const tool of all) assert.ok(scopes.has(`api://<SQUAD_RESOURCE_CLIENT_ID>/${requiredScopeFor(tool.name)}`), tool.name);
  assert.ok(![...scopes].some((scope) => String(scope).includes("Squad.Operate")));
});

test("both hosts, Studio swagger and committed inventory include all three opt-in identity tools", () => {
  const cowork = buildCoworkTools(catalog);
  assert.deepEqual(cowork.map((t) => t.name), all.map((t) => t.name));
  assert.equal(new Set(all.map((t) => t.name)).size, all.length);
  const committed = JSON.parse(readFileSync(join(generated, "connector.manifest.json"), "utf8"));
  assert.deepEqual(connectorTools(committed), all);
  const inventory = JSON.parse(readFileSync(join(root, "generated", "cowork-package", "tools", "hve-squad-tools.json"), "utf8"));
  const swagger = buildSwagger(manifest) as any;
  for (const name of ["squad_github_status", "squad_github_connect", "squad_github_disconnect"]) {
    assert.ok(all.some((t) => t.name === name));
    assert.ok(inventory.tools.some((t: { name: string }) => t.name === name));
    assert.ok(swagger.info.description.includes(name), `${name} is not omitted from Studio summary`);
    assert.equal(all.find((t) => t.name === name)?.scope, "Squad.Run");
  }
  assert.equal(swagger.paths["/mcp"].post["x-ms-agentic-protocol"], "mcp-streamable-1.0");
  assert.deepEqual(coworkRequestedScopes(catalog), connectorRequestedScopes(manifest).filter((s) => s !== "offline_access"));
  for (const tool of cowork) {
    assert.equal(tool.description, all.find((t) => t.name === tool.name)?.description);
    assert.deepEqual(tool.annotations, remoteToolAnnotations(tool.name, tool.title));
  }
  assert.equal(cowork.find((tool) => tool.name === "squad_github_connect")?.annotations.readOnlyHint, undefined);
  assert.equal(cowork.find((tool) => tool.name === "squad_github_disconnect")?.annotations.destructiveHint, true);
  assert.equal(cowork.find((tool) => tool.name === "squad_github_status")?.annotations.readOnlyHint, true);
});

test("optional identity metadata and input schemas match live tools/list; absent by default", async () => {
  const gate = identityGate();
  for (const enabled of [false, true]) {
    const harness = buildHarness({ userIdentity: enabled ? gate : undefined });
    harness.verifier.register({ token: "packaging-user", tenantId: "tenant-placeholder", subject: "user-placeholder", scopes: ["Squad.Run"] });
    const session = await initializeSession(harness.handler, "packaging-user");
    const response = await harness.handler.handle({
      method: "POST", path: "/mcp",
      headers: { origin: "https://copilotstudio.microsoft.com", authorization: bearer("packaging-user"),
        "content-type": "application/json", "mcp-session-id": session },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const tools = (response.body as any).result.tools as any[];
    for (const packaged of buildCoworkTools(catalog).filter((tool) => tool.name.startsWith("squad_github_"))) {
      const live = tools.find((tool) => tool.name === packaged.name);
      if (!enabled) { assert.equal(live, undefined); continue; }
      assert.ok(live, packaged.name);
      assert.equal(live.title, packaged.title);
      assert.equal(live.description, packaged.description);
      assert.deepEqual(live.inputSchema, packaged.inputSchema);
      assert.deepEqual(live.annotations, packaged.annotations);
    }
  }
});

test("both host inventories cover the live enabled Run+Memory user lifecycle through the generated Studio route", async () => {
  const memoryStore: SquadMemoryStore = {
    async list() { return []; }, async read() { return undefined; },
    async listProjects() { return []; },
    async write() { throw new Error("This discovery test must not write memory."); },
  };
  const studio = new Map(all.map((tool) => [tool.name, tool]));
  const cowork = new Map(buildCoworkTools(catalog).map((tool) => [tool.name, tool]));
  const swagger = buildSwagger(manifest) as any;
  const route = Object.keys(swagger.paths).find((path) =>
    swagger.paths[path].post?.["x-ms-agentic-protocol"] === manifest.protocol);
  assert.equal(route, "/mcp");
  for (const write of [false, true]) {
    const harness = buildHarness({ memoryStore, artifactsEnabled: true, userIdentity: identityGate() });
    const token = write ? "lifecycle-writer" : "lifecycle-reader";
    const scopes = ["Squad.Run", "Squad.Memory", ...(write ? ["Squad.MemoryWrite"] : [])];
    harness.verifier.register({ token, tenantId: "tenant-placeholder", subject: "user-placeholder", scopes });
    const session = await initializeSession(harness.handler, token);
    let id = 0;
    const request = (method: string, params: object): Promise<HttpResponseLike> => harness.handler.handle({
      method: "POST", path: route as string,
      headers: { origin: "https://copilotstudio.microsoft.com", authorization: bearer(token),
        "content-type": "application/json", "mcp-session-id": session },
      body: { jsonrpc: "2.0", id: ++id, method, params },
    });
    const response = await request("tools/list", {});
    assert.equal(response.status, 200);
    const live = (response.body as any).result.tools as any[];
    const liveNames = new Set(live.map((tool) => tool.name));
    for (const tool of live) {
      assert.ok(studio.has(tool.name), `${tool.name} missing from Studio`);
      assert.ok(cowork.has(tool.name), `${tool.name} missing from Cowork`);
      assert.ok(scopes.includes(requiredScopeFor(tool.name) as string), tool.name);
      if (["squad_respond", "squad_history", "squad_memory_sync"].includes(tool.name)) {
        for (const packaged of [studio.get(tool.name), cowork.get(tool.name)]) {
          assert.equal(packaged?.description, tool.description);
          assert.deepEqual(packaged?.inputSchema, tool.inputSchema);
        }
      }
    }
    for (const name of ["squad_run", "squad_status", "squad_respond", "squad_history",
      "squad_memory_read", "squad_github_connect", "squad_github_status", "squad_github_disconnect"]) {
      assert.ok(liveNames.has(name), `${name} must be reachable for a normal Run+Memory user`);
    }
    assert.equal(liveNames.has("squad_memory_sync"), write);
    assert.equal(liveNames.has("squad_approve"), false);
    assert.equal(studio.has("squad_approve"), false);
    assert.equal(cowork.has("squad_approve"), false);
    const history = await request("tools/call", { name: "squad_history", arguments: { project: "default", op: "index" } });
    assert.equal(history.status, 200);
    assert.ok((history.body as any).result);
    assert.equal(Boolean((history.body as any).result.isError), false);
    const respond = await request("tools/call", { name: "squad_respond", arguments: {
      runId: "00000000-0000-4000-8000-000000000001",
      questionId: "00000000-0000-4000-8000-000000000002", answer: "The human's answer.",
    } });
    assert.equal(respond.status, 200);
    assert.equal((respond.body as any).result.structuredContent.reason, "run_not_found_or_cross_tenant",
      "The generated route reaches response handling, not an unknown-tool or missing-scope error");
  }
  assert.deepEqual(manifest.operatorTools.map((tool) => [tool.name, tool.scope]), [["squad_approve", "Squad.Operate"]]);
  assert.ok(!connectorRequestedScopes(manifest).some((scope) => scope.includes("Squad.Operate")));
});

test("host guidance requires end-user credentials and distinguishes inbound SSO from downstream OBO", () => {
  const readme = readFileSync(join(generated, "README.md"), "utf8");
  const instructions = readFileSync(join(generated, "agent-instructions.md"), "utf8");
  assert.match(readme, /end-user credentials/i);
  assert.match(readme, /Never use maker-provided\/shared credentials/);
  assert.match(readme, /off by default/);
  assert.match(readme, /No downstream Entra OBO/);
  assert.match(readme, /one Entra tenant only/);
  assert.match(readme, /Guests use their resource-tenant oid/);
  assert.match(readme, /does not enable multi-tenant linking/);
  assert.match(readme, /disconnect\/relink requires new work/);
  assert.match(readme, /before execution[\s\S]*five-minute/);
  assert.match(readme, /identity_retry_pending/);
  assert.match(readme, /during execution aborts[\s\S]*no automatic replay/);
  assert.match(readme, /seven-day TTL/);
  assert.match(readme, /artifact retention is separate/);
  assert.doesNotMatch(readme, /recoverable outages can resume/);
  assert.match(readme, /manual/);
  assert.match(instructions, /github_connection_required/);
  assert.match(instructions, /old runs cannot adopt the new link/);
  assert.match(instructions, /Call squad_respond/);
  assert.match(instructions, /use squad_history/);
});
