/**
 * Validate the connector-only Copilot Cowork package.
 *
 * Cowork supports runtime MCP discovery for agent connectors in app manifest
 * v1.29 and later. The package therefore declares only the remote MCP endpoint
 * and authentication. It deliberately carries no Agent Skills and no pinned
 * mcpToolDescription; Cowork calls initialize and tools/list at runtime.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { packageRoot } from "../src/paths.js";

const MANIFEST_VERSION = "1.29";
const MANIFEST_SCHEMA =
  "https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json";
const MAX_CONNECTORS = 10;

interface CoworkAuthorization {
  type?: string;
  referenceId?: string;
}

interface CoworkRemoteMcpServer {
  mcpServerUrl?: string;
  mcpToolDescription?: unknown;
  authorization?: CoworkAuthorization;
}

interface CoworkConnector {
  id?: string;
  displayName?: string;
  description?: string;
  toolSource?: {
    remoteMcpServer?: CoworkRemoteMcpServer;
  };
}

export interface CoworkManifest {
  $schema?: string;
  manifestVersion?: string;
  agentSkills?: unknown[];
  agentConnectors?: CoworkConnector[];
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validMcpUrl(value: string): boolean {
  return (
    value === "https://<CONTAINER_APP_FQDN>/mcp" ||
    /^https:\/\/[^<>\s/]+(?::\d+)?\/mcp\/?$/.test(value)
  );
}

/** Validate the dynamic-discovery contract Cowork consumes at runtime. */
export function validateManifest(manifest: CoworkManifest): string[] {
  const problems: string[] = [];

  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    problems.push(
      `Dynamic agent-connector discovery requires manifestVersion ${MANIFEST_VERSION}; ` +
        `found ${manifest.manifestVersion ?? "(missing)"}.`,
    );
  }
  if (manifest.$schema !== MANIFEST_SCHEMA) {
    problems.push(`$schema must target the Teams ${MANIFEST_VERSION} schema.`);
  }
  if (hasOwn(manifest, "agentSkills")) {
    problems.push(
      "agentSkills must be omitted: this Cowork package is connector-only and discovers MCP tools at runtime.",
    );
  }

  const connectors = manifest.agentConnectors ?? [];
  if (connectors.length === 0) {
    problems.push("At least one agentConnector is required.");
  }
  if (connectors.length > MAX_CONNECTORS) {
    problems.push(`Connectors: ${connectors.length} exceeds the limit of ${MAX_CONNECTORS}.`);
  }

  const ids = new Set<string>();
  for (const connector of connectors) {
    const id = connector.id?.trim() ?? "";
    if (id.length === 0) {
      problems.push("Every agentConnector needs a non-empty id.");
    } else if (ids.has(id)) {
      problems.push(`Duplicate agentConnector id: ${id}.`);
    } else {
      ids.add(id);
    }
    if (!connector.displayName?.trim()) {
      problems.push(`Connector ${id || "(unnamed)"} needs a displayName.`);
    }
    if (!connector.description?.trim()) {
      problems.push(`Connector ${id || "(unnamed)"} needs a description for orchestration.`);
    }

    const remote = connector.toolSource?.remoteMcpServer;
    if (!remote) {
      problems.push(`Connector ${id || "(unnamed)"} needs toolSource.remoteMcpServer.`);
      continue;
    }
    if (hasOwn(remote, "mcpToolDescription")) {
      problems.push(
        `Connector ${id || "(unnamed)"} must omit mcpToolDescription so Cowork calls tools/list dynamically.`,
      );
    }
    const serverUrl = remote.mcpServerUrl?.trim() ?? "";
    if (!validMcpUrl(serverUrl)) {
      problems.push(
        `Connector ${id || "(unnamed)"} needs an HTTPS /mcp URL; found ${serverUrl || "(missing)"}.`,
      );
    }
    if (remote.authorization?.type !== "OAuthPluginVault") {
      problems.push(`Connector ${id || "(unnamed)"} must use OAuthPluginVault for the Entra-secured server.`);
    }
    if (!remote.authorization?.referenceId?.trim()) {
      problems.push(`Connector ${id || "(unnamed)"} needs an OAuthPluginVault referenceId.`);
    }
  }

  return problems;
}

export async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const root = packageRoot();
  const manifestPath = join(root, "cowork", "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${relative(root, manifestPath)}.`);
    return 1;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CoworkManifest;
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    console.error(`Cowork package validation failed:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }

  console.log(
    `Cowork dynamic MCP package OK: ${(manifest.agentConnectors ?? []).length} connector(s); ` +
      "tools resolve at runtime through initialize + tools/list.",
  );
  if (check) {
    console.log("Check mode: no files written.");
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
