/**
 * Save local MCP deployment endpoint + credentials into the gitignored
 * `deploy-output/` directory (or an external workspace) and compile the
 * v1.29 dynamic Microsoft 365 Copilot Cowork + Code plugin (`hve-squad-cowork.zip`)
 * from the deployed MCP server configuration.
 *
 * Security boundary:
 *   - Tracked repository paths are ALWAYS refused for live values or compiled bundles.
 *   - Only paths outside the repository OR inside the gitignored `deploy-output/`
 *     folder may receive live endpoints, Entra/OAuth IDs, credentials, or `.zip` outputs.
 *   - Raw secrets/tokens are written only to `mcp-credentials.local.env` (`0600` mode)
 *     when explicitly supplied, and NEVER enter `manifest.json`, the `.zip`, or
 *     `cowork-build-receipt.json`.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { packageRoot } from "../src/paths.js";
import { buildZip, type ZipEntry } from "../generators/build-cowork-package.js";
import {
  collectSkillFiles,
  type CoworkManifest,
  validateManifest,
  validateSkillPackage,
} from "../generators/build-cowork-plugin.js";

export const DEFAULT_DEPLOY_OUTPUT_DIR = "deploy-output";
export const LOCAL_CONFIG_FILENAME = "mcp-deployment.local.json";
export const LOCAL_CREDENTIALS_ENV_FILENAME = "mcp-credentials.local.env";
export const COMPILED_ZIP_FILENAME = "hve-squad-cowork.zip";
export const BUILD_RECEIPT_FILENAME = "cowork-build-receipt.json";

export interface LocalDeploymentMetadata {
  subscriptionId?: string;
  resourceGroup?: string;
  containerAppName?: string;
  keyVaultName?: string;
  managedIdentityPrincipalId?: string;
}

export interface LocalCredentialReferences {
  bearerTokenEnvVar?: string;
  operatorTokenEnvVar?: string;
  envFile?: string;
  keyVaultSecretUris?: Record<string, string>;
}

export interface LocalMcpDeploymentConfig {
  schemaVersion: 1;
  mcpServerUrl: string;
  oauthReferenceId: string;
  tenantId?: string;
  resourceClientId?: string;
  appIdUri?: string;
  packageId?: string;
  packageVersion?: string;
  websiteUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  savedAt?: string;
  liveVerified?: boolean;
  liveTools?: string[];
  deployment?: LocalDeploymentMetadata;
  credentials?: LocalCredentialReferences;
}

export interface CompileCoworkOptions {
  coworkRoot?: string;
  outDir?: string;
  configPath?: string;
  saveConfig?: boolean;
  mcpServerUrl?: string;
  fqdn?: string;
  oauthReferenceId?: string;
  tenantId?: string;
  resourceClientId?: string;
  appIdUri?: string;
  packageId?: string;
  packageVersion?: string;
  websiteUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  containerAppName?: string;
  keyVaultName?: string;
  managedIdentityPrincipalId?: string;
  bearerToken?: string;
  operatorToken?: string;
  verifyLive?: boolean;
  allowPlaceholders?: boolean;
  fetchImpl?: typeof fetch;
}

export interface CoworkCompileReceipt {
  schemaVersion: 1;
  compiledAt: string;
  manifestVersion: string;
  packageId: string;
  packageVersion: string;
  mcpServerUrl: string;
  oauthReferenceId: string;
  zipPath: string;
  zipSha256: string;
  zipBytes: number;
  entries: { name: string; bytes: number; sha256: string }[];
  liveVerification: {
    attempted: boolean;
    verified: boolean;
    serverName?: string;
    serverVersion?: string;
    discoveredTools?: string[];
  };
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalPath(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  return join(canonicalPath(dirname(target)), relative(dirname(target), target));
}

/**
 * Check whether an output directory is safe for live deployment metadata and compiled plugins:
 * either completely outside the repository, or inside the gitignored `deploy-output/` folder
 * (or `cowork/build/`). Tracked repository locations are always rejected.
 */
export function isAllowedLocalOutputDir(targetDir: string, repoRoot = packageRoot()): boolean {
  const rootCanon = canonicalPath(resolve(repoRoot));
  const targetCanon = canonicalPath(resolve(targetDir));
  const rel = relative(rootCanon, targetCanon);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return true;
  }
  const normalized = rel.replaceAll("\\", "/");
  return (
    normalized === DEFAULT_DEPLOY_OUTPUT_DIR ||
    normalized.startsWith(`${DEFAULT_DEPLOY_OUTPUT_DIR}/`) ||
    normalized === "cowork/build" ||
    normalized.startsWith("cowork/build/")
  );
}

export function assertSafeLocalOutputDir(targetDir: string, repoRoot = packageRoot()): void {
  if (!isAllowedLocalOutputDir(targetDir, repoRoot)) {
    throw new Error(
      `Refusing to write live deployment state or compiled Cowork plugin into tracked repository path "${targetDir}". ` +
        `Use "${DEFAULT_DEPLOY_OUTPUT_DIR}/" (gitignored) or a directory outside the repository.`,
    );
  }
}

export function normalizeMcpServerUrl(mcpServerUrl?: string, fqdn?: string): string | undefined {
  if (mcpServerUrl && mcpServerUrl.trim()) {
    const trimmed = mcpServerUrl.trim();
    if (trimmed === "https://<CONTAINER_APP_FQDN>/mcp") return trimmed;
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("mcpServerUrl must use https:// without credentials, query string, or fragment.");
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    if (cleanPath === "" || cleanPath === "/") {
      parsed.pathname = "/mcp";
    } else if (cleanPath !== "/mcp") {
      throw new Error(`mcpServerUrl path must end with /mcp; got "${parsed.pathname}".`);
    } else {
      parsed.pathname = "/mcp";
    }
    return parsed.toString();
  }
  if (fqdn && fqdn.trim()) {
    const host = fqdn.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!host || /[<>\s]/.test(host)) {
      throw new Error(`Invalid Container App FQDN: "${fqdn}".`);
    }
    return `https://${host}/mcp`;
  }
  return undefined;
}

function assertNoSecretMaterialInPublicField(label: string, value: string): void {
  if (
    /^(?:gh[pousr]_|github_pat_|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
  ) {
    throw new Error(`${label} appears to contain a raw token or private key; pass identifiers only.`);
  }
}

function validateGuid(label: string, value: string): void {
  if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a valid UUID/GUID; got "${value}".`);
  }
}

export function loadSavedDeploymentConfig(configPath: string): LocalMcpDeploymentConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<LocalMcpDeploymentConfig>;
  if (raw.schemaVersion !== 1 || typeof raw.mcpServerUrl !== "string" || typeof raw.oauthReferenceId !== "string") {
    throw new Error(`Invalid local deployment config at ${configPath}: expected schemaVersion 1, mcpServerUrl, and oauthReferenceId.`);
  }
  return raw as LocalMcpDeploymentConfig;
}

function writeCredentialsEnvFile(
  outDir: string,
  mcpServerUrl: string,
  bearerToken?: string,
  operatorToken?: string,
): string | undefined {
  if (!bearerToken && !operatorToken) return undefined;
  const envPath = join(outDir, LOCAL_CREDENTIALS_ENV_FILENAME);
  const lines = [
    "# Local gitignored MCP credentials for smoke testing and operator actions.",
    "# NEVER commit or share this file.",
    `SQUAD_MCP_ENDPOINT=${mcpServerUrl}`,
  ];
  if (bearerToken) {
    if (/[\r\n\0]/.test(bearerToken)) throw new Error("bearerToken must not contain control newlines.");
    lines.push(`SQUAD_MCP_BEARER_TOKEN=${bearerToken}`);
  }
  if (operatorToken) {
    if (/[\r\n\0]/.test(operatorToken)) throw new Error("operatorToken must not contain control newlines.");
    lines.push(`SQUAD_MCP_OPERATOR_TOKEN=${operatorToken}`);
  }
  writeFileSync(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Windows ACLs ignore POSIX mode bits; best-effort on POSIX hosts.
  }
  return LOCAL_CREDENTIALS_ENV_FILENAME;
}

export async function verifyDeployedMcpServer(
  mcpServerUrl: string,
  bearerToken?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  serverName?: string;
  serverVersion?: string;
  discoveredTools: string[];
}> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    origin: "https://copilotstudio.microsoft.com",
  };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  const initRes = await fetchImpl(mcpServerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "hve-squad-cowork-compiler", version: "1.0.0" },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!initRes.ok) {
    throw new Error(`Live MCP initialize failed with HTTP ${initRes.status}.`);
  }
  const initBody = (await initRes.json()) as {
    result?: { serverInfo?: { name?: string; version?: string } };
  };
  const sessionId = initRes.headers.get("mcp-session-id");
  const listHeaders = { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
  const listRes = await fetchImpl(mcpServerUrl, {
    method: "POST",
    headers: listHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!listRes.ok) {
    throw new Error(`Live MCP tools/list failed with HTTP ${listRes.status}.`);
  }
  const listBody = (await listRes.json()) as {
    result?: { tools?: { name?: string }[] };
  };
  const discoveredTools = (listBody.result?.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return {
    serverName: initBody.result?.serverInfo?.name,
    serverVersion: initBody.result?.serverInfo?.version,
    discoveredTools,
  };
}

export async function compileCoworkPlugin(options: CompileCoworkOptions = {}): Promise<{
  config: LocalMcpDeploymentConfig;
  manifest: CoworkManifest;
  zip: Buffer;
  receipt: CoworkCompileReceipt;
}> {
  const root = packageRoot();
  const coworkRoot = resolve(options.coworkRoot ?? join(root, "cowork"));
  const outDir = resolve(options.outDir ?? join(root, DEFAULT_DEPLOY_OUTPUT_DIR));
  assertSafeLocalOutputDir(outDir, root);

  const configPath = resolve(options.configPath ?? join(outDir, LOCAL_CONFIG_FILENAME));
  assertSafeLocalOutputDir(dirname(configPath), root);
  const saved = loadSavedDeploymentConfig(configPath);

  const baseManifest = JSON.parse(
    readFileSync(join(coworkRoot, "manifest.json"), "utf8"),
  ) as CoworkManifest;

  const resolvedUrl =
    normalizeMcpServerUrl(options.mcpServerUrl, options.fqdn) ??
    (saved?.mcpServerUrl ? normalizeMcpServerUrl(saved.mcpServerUrl) : undefined) ??
    baseManifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer?.mcpServerUrl ??
    "";

  const resolvedOAuthRef = (
    options.oauthReferenceId?.trim() ||
    saved?.oauthReferenceId?.trim() ||
    baseManifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer?.authorization?.referenceId ||
    ""
  );

  if (!options.allowPlaceholders) {
    if (!resolvedUrl || /<[A-Z0-9_]+>/i.test(resolvedUrl) || resolvedUrl.includes("example.invalid")) {
      throw new Error(
        `A live HTTPS MCP endpoint URL is required (no placeholders). Pass --mcp-server-url / --fqdn or save ${LOCAL_CONFIG_FILENAME} first.`,
      );
    }
    if (!resolvedOAuthRef || /<[A-Z0-9_]+>/i.test(resolvedOAuthRef)) {
      throw new Error(
        `A live OAuthPluginVault referenceId is required (no placeholders). Pass --oauth-reference-id or save ${LOCAL_CONFIG_FILENAME} first.`,
      );
    }
  }

  assertNoSecretMaterialInPublicField("oauthReferenceId", resolvedOAuthRef);
  if (!resolvedOAuthRef || /\s/.test(resolvedOAuthRef) || resolvedOAuthRef.length > 128) {
    throw new Error("oauthReferenceId must be 1-128 non-whitespace characters.");
  }

  const tenantId = options.tenantId?.trim() || saved?.tenantId;
  if (tenantId && !options.allowPlaceholders) validateGuid("tenantId", tenantId);
  const resourceClientId = options.resourceClientId?.trim() || saved?.resourceClientId;
  if (resourceClientId && !options.allowPlaceholders) validateGuid("resourceClientId", resourceClientId);
  const packageId = options.packageId?.trim() || saved?.packageId || baseManifest.id || "";
  validateGuid("packageId", packageId);
  const packageVersion = options.packageVersion?.trim() || saved?.packageVersion || baseManifest.version || "";
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(packageVersion)) {
    throw new Error(`packageVersion must be valid semver; got "${packageVersion}".`);
  }

  const manifest: CoworkManifest = structuredClone(baseManifest);
  manifest.id = packageId;
  manifest.version = packageVersion;
  if (manifest.developer) {
    if (options.websiteUrl ?? saved?.websiteUrl) manifest.developer.websiteUrl = options.websiteUrl ?? saved?.websiteUrl;
    if (options.privacyUrl ?? saved?.privacyUrl) manifest.developer.privacyUrl = options.privacyUrl ?? saved?.privacyUrl;
    if (options.termsUrl ?? saved?.termsUrl) manifest.developer.termsOfUseUrl = options.termsUrl ?? saved?.termsUrl;
  }
  const remote = manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  if (!remote) {
    throw new Error("Base cowork/manifest.json is missing agentConnectors[0].toolSource.remoteMcpServer.");
  }
  remote.mcpServerUrl = resolvedUrl;
  remote.authorization = {
    type: "OAuthPluginVault",
    referenceId: resolvedOAuthRef,
  };

  const problems = [
    ...validateManifest(manifest),
    ...validateSkillPackage(coworkRoot, manifest),
  ];
  if (problems.length > 0) {
    throw new Error(`Cowork v1.29 package validation failed:\n  - ${problems.join("\n  - ")}`);
  }

  let liveVerification: CoworkCompileReceipt["liveVerification"] = {
    attempted: false,
    verified: false,
  };
  if (options.verifyLive) {
    const bearer = options.bearerToken ?? process.env.SQUAD_MCP_BEARER_TOKEN;
    const probe = await verifyDeployedMcpServer(resolvedUrl, bearer, options.fetchImpl);
    liveVerification = {
      attempted: true,
      verified: true,
      serverName: probe.serverName,
      serverVersion: probe.serverVersion,
      discoveredTools: probe.discoveredTools,
    };
  }

  mkdirSync(outDir, { recursive: true });
  const envFile = writeCredentialsEnvFile(outDir, resolvedUrl, options.bearerToken, options.operatorToken);

  const deploymentMeta: LocalDeploymentMetadata = {
    ...saved?.deployment,
    ...(options.subscriptionId ? { subscriptionId: options.subscriptionId.trim() } : {}),
    ...(options.resourceGroup ? { resourceGroup: options.resourceGroup.trim() } : {}),
    ...(options.containerAppName ? { containerAppName: options.containerAppName.trim() } : {}),
    ...(options.keyVaultName ? { keyVaultName: options.keyVaultName.trim() } : {}),
    ...(options.managedIdentityPrincipalId
      ? { managedIdentityPrincipalId: options.managedIdentityPrincipalId.trim() }
      : {}),
  };

  const appIdUri =
    options.appIdUri?.trim() ||
    saved?.appIdUri ||
    (resourceClientId ? `api://${resourceClientId}` : undefined);

  const config: LocalMcpDeploymentConfig = {
    schemaVersion: 1,
    mcpServerUrl: resolvedUrl,
    oauthReferenceId: resolvedOAuthRef,
    ...(tenantId ? { tenantId } : {}),
    ...(resourceClientId ? { resourceClientId } : {}),
    ...(appIdUri ? { appIdUri } : {}),
    packageId,
    packageVersion,
    ...(manifest.developer?.websiteUrl ? { websiteUrl: manifest.developer.websiteUrl } : {}),
    ...(manifest.developer?.privacyUrl ? { privacyUrl: manifest.developer.privacyUrl } : {}),
    ...(manifest.developer?.termsOfUseUrl ? { termsUrl: manifest.developer.termsOfUseUrl } : {}),
    savedAt: new Date().toISOString(),
    ...(liveVerification.attempted
      ? { liveVerified: liveVerification.verified, liveTools: liveVerification.discoveredTools }
      : saved?.liveVerified !== undefined
        ? { liveVerified: saved.liveVerified, liveTools: saved.liveTools }
        : {}),
    ...(Object.keys(deploymentMeta).length > 0 ? { deployment: deploymentMeta } : {}),
    credentials: {
      bearerTokenEnvVar: "SQUAD_MCP_BEARER_TOKEN",
      operatorTokenEnvVar: "SQUAD_MCP_OPERATOR_TOKEN",
      ...(envFile
        ? { envFile }
        : saved?.credentials?.envFile
          ? { envFile: saved.credentials.envFile }
          : {}),
      keyVaultSecretUris: saved?.credentials?.keyVaultSecretUris ?? {},
    },
  };

  if (options.saveConfig || !existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const zipEntries: ZipEntry[] = [
    { name: "manifest.json", data: manifestBytes },
    { name: "color.png", data: readFileSync(join(coworkRoot, "color.png")) },
    { name: "outline.png", data: readFileSync(join(coworkRoot, "outline.png")) },
  ];

  for (const skill of manifest.agentSkills ?? []) {
    const folder = (skill.folder ?? "").trim().slice(2); // strip "./"
    const skillDir = join(coworkRoot, ...folder.split("/"));
    for (const fullPath of collectSkillFiles(skillDir)) {
      const relInSkill = relative(skillDir, fullPath).replaceAll("\\", "/");
      const entryName = `${folder}/${relInSkill}`;
      const rawBytes = readFileSync(fullPath);
      // Normalize text files to LF so cross-platform builds produce identical archives.
      const isBinary = /\.(?:png|jpg|jpeg|gif|webp|ico|zip|pdf)$/i.test(entryName);
      const data = isBinary
        ? rawBytes
        : Buffer.from(rawBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
      zipEntries.push({ name: entryName, data });
    }
  }

  for (const entry of zipEntries) {
    if (!entry.name.endsWith(".png")) {
      const text = entry.data.toString("utf8");
      if (
        /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
      ) {
        throw new Error(`Refusing to package secret-shaped content in ${entry.name}.`);
      }
    }
  }

  const zip = buildZip(zipEntries);
  const zipPath = join(outDir, COMPILED_ZIP_FILENAME);
  writeFileSync(join(outDir, "manifest.json"), manifestBytes);
  writeFileSync(zipPath, zip);

  const sortedEntries = [...zipEntries]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    .map((entry) => ({
      name: entry.name,
      bytes: entry.data.length,
      sha256: sha256Hex(entry.data),
    }));

  const receipt: CoworkCompileReceipt = {
    schemaVersion: 1,
    compiledAt: new Date().toISOString(),
    manifestVersion: String(manifest.manifestVersion),
    packageId,
    packageVersion,
    mcpServerUrl: resolvedUrl,
    oauthReferenceId: resolvedOAuthRef,
    zipPath,
    zipSha256: sha256Hex(zip),
    zipBytes: zip.length,
    entries: sortedEntries,
    liveVerification,
  };
  writeFileSync(join(outDir, BUILD_RECEIPT_FILENAME), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return { config, manifest, zip, receipt };
}

const VALUE_FLAGS: Readonly<Record<string, keyof CompileCoworkOptions>> = {
  "--out-dir": "outDir",
  "--config": "configPath",
  "--mcp-server-url": "mcpServerUrl",
  "--fqdn": "fqdn",
  "--oauth-reference-id": "oauthReferenceId",
  "--auth-config-id": "oauthReferenceId",
  "--tenant-id": "tenantId",
  "--resource-client-id": "resourceClientId",
  "--app-id-uri": "appIdUri",
  "--package-id": "packageId",
  "--package-version": "packageVersion",
  "--website-url": "websiteUrl",
  "--privacy-url": "privacyUrl",
  "--terms-url": "termsUrl",
  "--subscription-id": "subscriptionId",
  "--resource-group": "resourceGroup",
  "--container-app-name": "containerAppName",
  "--key-vault-name": "keyVaultName",
  "--managed-identity-principal-id": "managedIdentityPrincipalId",
  "--bearer-token": "bearerToken",
  "--operator-token": "operatorToken",
};

export function parseCompileCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CompileCoworkOptions {
  const options: CompileCoworkOptions = {
    mcpServerUrl: env.HVE_COWORK_MCP_SERVER_URL,
    fqdn: env.HVE_COWORK_FQDN,
    oauthReferenceId: env.HVE_COWORK_AUTH_CONFIG_ID ?? env.HVE_COWORK_OAUTH_REFERENCE_ID,
    tenantId: env.HVE_COWORK_TENANT_ID,
    resourceClientId: env.HVE_COWORK_RESOURCE_CLIENT_ID,
    packageId: env.HVE_COWORK_PACKAGE_ID,
    packageVersion: env.HVE_COWORK_PACKAGE_VERSION,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--save-config") {
      options.saveConfig = true;
      continue;
    }
    if (arg === "--verify-live") {
      options.verifyLive = true;
      continue;
    }
    if (arg === "--allow-placeholders") {
      options.allowPlaceholders = true;
      continue;
    }
    const key = VALUE_FLAGS[arg];
    if (!key) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    (options as Record<string, unknown>)[key] = value;
    i += 1;
  }
  return options;
}

export async function runCli(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const options = parseCompileCliArgs(argv, env);
    const { receipt } = await compileCoworkPlugin(options);
    process.stdout.write(
      `[compile-cowork-plugin] compiled ${receipt.zipPath} (${receipt.entries.length} files, ${receipt.zipBytes} bytes, sha256=${receipt.zipSha256.slice(0, 12)}…) -> ${receipt.mcpServerUrl}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `[compile-cowork-plugin] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
