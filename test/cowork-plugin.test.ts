import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import {
  type CoworkManifest,
  validateManifest,
  validateSkillPackage,
} from "../generators/build-cowork-plugin.js";
import {
  assertSafeLocalOutputDir,
  BUILD_RECEIPT_FILENAME,
  COMPILED_ZIP_FILENAME,
  compileCoworkPlugin,
  isAllowedLocalOutputDir,
  loadSavedDeploymentConfig,
  LOCAL_CONFIG_FILENAME,
  LOCAL_CREDENTIALS_ENV_FILENAME,
  normalizeMcpServerUrl,
  parseCompileCliArgs,
} from "../scripts/compile-cowork-plugin.js";
import { crc32 } from "../generators/build-cowork-package.js";
import { inspectTaskContext } from "../src/engine/model-preflight.js";
import { packageRoot } from "../src/paths.js";

const root = packageRoot();
const manifest = JSON.parse(
  readFileSync(join(root, "cowork", "manifest.json"), "utf8"),
) as CoworkManifest;

function readZipEntryNamesAndBytes(zip: Buffer): Map<string, Buffer> {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const localOffset = zip.readUInt32LE(offset + 42);
    const dataLen = zip.readUInt32LE(offset + 24);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(start, start + dataLen);
    assert.equal(crc32(data), zip.readUInt32LE(offset + 16));
    if (!name.endsWith("/")) {
      entries.set(name, data);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("cowork v1.29 manifest and bundled skills pass validation with placeholders intact", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual(validateSkillPackage(join(root, "cowork"), manifest), []);
  const remote = manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.equal(remote?.mcpServerUrl, "https://<CONTAINER_APP_FQDN>/mcp");
  assert.equal(remote?.authorization?.referenceId, "<OAUTH_CLIENT_REGISTRATION_ID>");
  assert.equal(remote?.mcpToolDescription, undefined, "dynamic v1.29 discovery omits mcpToolDescription");
});

test("cowork context-preflight packet and stakeholder library templates remain valid", () => {
  const preflight = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "context-preflight.md"),
    "utf8",
  );
  const packetText = preflight.match(/```json\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(packetText);
  const inspection = inspectTaskContext(packetText);
  assert.equal(inspection.packet, true);
  assert.equal(inspection.preflight, undefined);

  const library = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "stakeholder-library.md"),
    "utf8",
  );
  const templates = new Map(
    [...library.matchAll(/^### `([^`]+)`\r?\n\r?\n```markdown\r?\n([\s\S]*?)```/gm)].map(
      (match) => [match[1], match[2]],
    ),
  );
  assert.deepEqual([...templates.keys()], [
    "START-HERE.md",
    "library/deliverables.md",
    "library/decisions.md",
    "library/next-steps.md",
  ]);
  const targets = new Set([
    ...[...templates.keys()].map((path) => `/${path}`),
    "/artifact-index.md",
    "/state.md",
    "/next-actions.md",
  ]);
  for (const [path, content] of templates) {
    for (const [, , href] of content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      assert.ok(targets.has(posix.resolve("/", posix.dirname(path), href)), `${path} -> ${href}`);
    }
  }
});

test("validateSkillPackage rejects missing metadata contracts on project-manager and code skills", () => {
  const fixture = mkdtempSync(join(tmpdir(), "cowork-validate-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const pmSkill = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(pmSkill, "utf8");
    writeFileSync(
      pmSkill,
      original.replace("context-preflight-protocol: references/context-preflight.md", ""),
      "utf8",
    );
    assert.ok(
      validateSkillPackage(fixture, manifest).some((p) =>
        p.includes("metadata.context-preflight-protocol=references/context-preflight.md"),
      ),
    );
    writeFileSync(pmSkill, original, "utf8");
    assert.deepEqual(validateSkillPackage(fixture, manifest), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("output directory guard permits gitignored deploy-output and external dirs while blocking tracked repo dirs", () => {
  assert.equal(isAllowedLocalOutputDir(join(root, "deploy-output"), root), true);
  assert.equal(isAllowedLocalOutputDir(join(root, "deploy-output", "staging"), root), true);
  assert.equal(isAllowedLocalOutputDir(join(root, "cowork", "build"), root), true);
  assert.equal(isAllowedLocalOutputDir(join(tmpdir(), "external-cowork-out"), root), true);

  for (const forbidden of [
    root,
    join(root, "cowork"),
    join(root, "generated", "cowork-package"),
    join(root, "src"),
    join(root, ".github"),
  ]) {
    assert.equal(isAllowedLocalOutputDir(forbidden, root), false, forbidden);
    assert.throws(() => assertSafeLocalOutputDir(forbidden, root), /Refusing to write live deployment state/);
  }
});

test("compileCoworkPlugin saves local deployment config + credentials, verifies live MCP, and builds deterministic v1.29 zip without leaking secrets", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cowork-compile-test-"));
  const seenMethods: string[] = [];
  const seenAuthHeaders: (string | null)[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    const headers = new Headers(init?.headers);
    seenMethods.push(body.method ?? "");
    seenAuthHeaders.push(headers.get("authorization"));
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "hve-squad-mcp", version: "0.8.0" } },
        }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-123" } },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            { name: "squad_run" },
            { name: "squad_status" },
            { name: "squad_respond" },
            { name: "squad_history" },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const first = await compileCoworkPlugin({
      outDir,
      saveConfig: true,
      fqdn: "squad-mcp.eastus2.azurecontainerapps.io",
      oauthReferenceId: "auth-cfg-998877",
      tenantId: "11111111-2222-3333-4444-555555555555",
      resourceClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      subscriptionId: "99999999-8888-7777-6666-555555555555",
      resourceGroup: "rg-squad-mcp",
      containerAppName: "ca-squad-mcp",
      keyVaultName: "kv-squad-mcp",
      bearerToken: "synthetic-local-test-bearer-token",
      verifyLive: true,
      fetchImpl: fakeFetch,
    });

    assert.deepEqual(seenMethods, ["initialize", "tools/list"]);
    assert.deepEqual(seenAuthHeaders, [
      "Bearer synthetic-local-test-bearer-token",
      "Bearer synthetic-local-test-bearer-token",
    ]);
    assert.equal(first.manifest.manifestVersion, "1.29");
    assert.equal(
      first.manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer?.mcpServerUrl,
      "https://squad-mcp.eastus2.azurecontainerapps.io/mcp",
    );
    assert.equal(
      first.manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer?.authorization?.referenceId,
      "auth-cfg-998877",
    );
    assert.equal(
      first.manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer?.mcpToolDescription,
      undefined,
    );

    // Local config and separate env credential file are written in outDir.
    const saved = loadSavedDeploymentConfig(join(outDir, LOCAL_CONFIG_FILENAME));
    assert.ok(saved);
    assert.equal(saved.mcpServerUrl, "https://squad-mcp.eastus2.azurecontainerapps.io/mcp");
    assert.equal(saved.oauthReferenceId, "auth-cfg-998877");
    assert.equal(saved.appIdUri, "api://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.equal(saved.liveVerified, true);
    assert.deepEqual(saved.liveTools, ["squad_run", "squad_status", "squad_respond", "squad_history"]);
    assert.equal(saved.credentials?.envFile, LOCAL_CREDENTIALS_ENV_FILENAME);

    const envContent = readFileSync(join(outDir, LOCAL_CREDENTIALS_ENV_FILENAME), "utf8");
    assert.match(envContent, /SQUAD_MCP_BEARER_TOKEN=synthetic-local-test-bearer-token/);

    // Neither the manifest, receipt, config JSON, nor zip may contain the bearer token.
    const receiptRaw = readFileSync(join(outDir, BUILD_RECEIPT_FILENAME), "utf8");
    const configRaw = readFileSync(join(outDir, LOCAL_CONFIG_FILENAME), "utf8");
    assert.ok(!receiptRaw.includes("synthetic-local-test-bearer-token"));
    assert.ok(!configRaw.includes("synthetic-local-test-bearer-token"));

    const entries = readZipEntryNamesAndBytes(first.zip);
    assert.ok(entries.has("manifest.json"));
    assert.ok(entries.has("color.png"));
    assert.ok(entries.has("outline.png"));
    assert.ok(entries.has("skills/hve-project-manager/SKILL.md"));
    assert.ok(entries.has("skills/hve-project-manager/references/execution-protocol.md"));
    assert.ok(entries.has("skills/hve-code-implement/SKILL.md"));
    assert.ok(entries.has("skills/hve-code-implement/scripts/verify-receipt.mjs"));
    for (const [name, bytes] of entries) {
      if (!name.endsWith(".png")) {
        assert.ok(!bytes.toString("utf8").includes("synthetic-local-test-bearer-token"), name);
      }
    }

    // Recompiling with zero CLI flags reuses saved mcp-deployment.local.json and produces byte-identical zip.
    const second = await compileCoworkPlugin({ outDir });
    assert.ok(first.zip.equals(second.zip), "recompiling from saved local config produces identical zip bytes");
    assert.ok(existsSync(join(outDir, COMPILED_ZIP_FILENAME)));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("compileCoworkPlugin rejects unresolved placeholders, bad URLs, and raw tokens in public fields", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "cowork-compile-neg-"));
  try {
    await assert.rejects(() => compileCoworkPlugin({ outDir }), /live HTTPS MCP endpoint URL is required/);
    assert.throws(() => normalizeMcpServerUrl("http://insecure.example.com/mcp"), /https/);
    assert.throws(() => normalizeMcpServerUrl("https://host.example.com/other"), /must end with \/mcp/);
    assert.equal(normalizeMcpServerUrl("https://host.example.com"), "https://host.example.com/mcp");
    await assert.rejects(
      () =>
        compileCoworkPlugin({
          outDir,
          fqdn: "valid.azurecontainerapps.io",
          oauthReferenceId: `ghp_${"x".repeat(30)}`,
        }),
      /raw token/,
    );
    assert.deepEqual(
      parseCompileCliArgs(["--save-config", "--fqdn", "app.example.io", "--auth-config-id", "ref-1"], {}),
      {
        mcpServerUrl: undefined,
        fqdn: "app.example.io",
        oauthReferenceId: "ref-1",
        tenantId: undefined,
        resourceClientId: undefined,
        packageId: undefined,
        packageVersion: undefined,
        saveConfig: true,
      },
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("gitignored deploy-output excludes local deployment files while tracking agent skill and instructions", () => {
  const skillText = readFileSync(
    join(root, ".github", "skills", "deploy-mcp-cowork", "SKILL.md"),
    "utf8",
  );
  const fmMatch = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fmMatch, "deploy-mcp-cowork SKILL.md has YAML frontmatter");
  const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
  assert.equal(fm.name, "deploy-mcp-cowork");
  assert.ok(typeof fm.description === "string" && fm.description.length > 20);
  assert.match(skillText, /deploy-output\/mcp-deployment\.local\.json/);
  assert.match(skillText, /npm run cowork:compile/);

  const copilotInstructions = readFileSync(join(root, ".github", "copilot-instructions.md"), "utf8");
  assert.match(copilotInstructions, /deploy-mcp-cowork/);
  assert.match(copilotInstructions, /deploy-output\//);

  const scopedInstructions = readFileSync(
    join(root, ".github", "instructions", "mcp-deployment.instructions.md"),
    "utf8",
  );
  assert.match(scopedInstructions, /applyTo:/);
  assert.match(scopedInstructions, /deploy-output\/hve-squad-cowork\.zip/);

  // Verify git check-ignore protects live artifacts inside deploy-output/ while allowing README + example.
  const ignored = spawnSync(
    "git",
    [
      "check-ignore",
      "deploy-output/mcp-deployment.local.json",
      "deploy-output/mcp-credentials.local.env",
      "deploy-output/hve-squad-cowork.zip",
      "deploy-output/cowork-build-receipt.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.equal(ignored.stdout.trim().split(/\r?\n/).length, 4);

  const tracked = spawnSync(
    "git",
    ["check-ignore", "deploy-output/README.md", "deploy-output/mcp-deployment.example.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(tracked.status, 1, "README.md and mcp-deployment.example.json must remain trackable");
});
