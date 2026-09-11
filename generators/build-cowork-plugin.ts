/**
 * Validate the Copilot Cowork project-management skill and dynamic MCP connector.
 *
 * The Agent Skill owns the stable project workflow. The server remains the
 * source of truth for its enabled tools through initialize and tools/list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { packageRoot } from "../src/paths.js";

const MANIFEST_VERSION = "1.29";
const MANIFEST_SCHEMA =
  "https://developer.microsoft.com/json-schemas/teams/v1.29/MicrosoftTeams.schema.json";
const MAX_CONNECTORS = 10;
const MAX_SKILLS = 20;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_COMPANION_FILES = 20;
const MAX_COMPANION_FILE_BYTES = 5 * 1024 * 1024;
const MAX_COMPANION_TOTAL_BYTES = 10 * 1024 * 1024;
const REQUIRED_PROJECT_SKILL = "./skills/hve-project-manager";
const REQUIRED_PROJECT_CONTRACT = "references/project-contract.md";
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.!-]*$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

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

export interface CoworkSkill {
  folder?: string;
}

export interface CoworkManifest {
  $schema?: string;
  manifestVersion?: string;
  version?: string;
  agentSkills?: CoworkSkill[];
  agentConnectors?: CoworkConnector[];
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMcpUrl(value: string): boolean {
  return (
    value === "https://<CONTAINER_APP_FQDN>/mcp" ||
    /^https:\/\/[^<>\s/]+(?::\d+)?\/mcp\/?$/.test(value)
  );
}

function validSkillFolder(folder: string): boolean {
  if (folder.length > 256 || !folder.startsWith("./skills/")) {
    return false;
  }
  const name = folder.slice("./skills/".length);
  return name.length <= 64 && SKILL_NAME.test(name);
}

function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/** Validate the manifest contract Cowork consumes at runtime. */
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

  const skills = Array.isArray(manifest.agentSkills) ? manifest.agentSkills : [];
  if (manifest.agentSkills !== undefined && !Array.isArray(manifest.agentSkills)) {
    problems.push("agentSkills must be an array.");
  }
  if (skills.length === 0) {
    problems.push("At least one agentSkill is required.");
  }
  if (skills.length > MAX_SKILLS) {
    problems.push(`Agent Skills: ${skills.length} exceeds the limit of ${MAX_SKILLS}.`);
  }
  const skillFolders = new Set<string>();
  for (const skill of skills) {
    const folder = skill.folder?.trim() ?? "";
    if (!validSkillFolder(folder)) {
      problems.push(
        `Agent Skill folder must be ./skills/<lower-kebab-name>; found ${folder || "(missing)"}.`,
      );
      continue;
    }
    if (skillFolders.has(folder)) {
      problems.push(`Duplicate Agent Skill folder: ${folder}.`);
    }
    skillFolders.add(folder);
  }
  if (!skillFolders.has(REQUIRED_PROJECT_SKILL)) {
    problems.push(`The package must declare ${REQUIRED_PROJECT_SKILL}.`);
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

/** Validate every packaged SKILL.md and its bounded companion files. */
export function validateSkillPackage(
  coworkRoot: string,
  manifest: CoworkManifest,
): string[] {
  const problems: string[] = [];
  const resolvedRoot = resolve(coworkRoot);

  for (const skill of manifest.agentSkills ?? []) {
    const folder = skill.folder?.trim() ?? "";
    if (!validSkillFolder(folder)) {
      continue;
    }

    const skillDirectory = resolve(resolvedRoot, folder.slice(2));
    if (!skillDirectory.startsWith(`${resolvedRoot}${sep}`)) {
      problems.push(`Agent Skill folder escapes the package root: ${folder}.`);
      continue;
    }

    const skillPath = join(skillDirectory, "SKILL.md");
    if (!existsSync(skillPath)) {
      problems.push(`Agent Skill ${folder} is missing SKILL.md.`);
      continue;
    }
    if (statSync(skillPath).size > MAX_SKILL_FILE_BYTES) {
      problems.push(`Agent Skill ${folder}/SKILL.md exceeds 1 MB.`);
    }

    const text = readFileSync(skillPath, "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) {
      problems.push(`Agent Skill ${folder}/SKILL.md has no YAML frontmatter.`);
      continue;
    }

    let metadata: unknown;
    try {
      metadata = parseYaml(frontmatter[1]);
    } catch {
      problems.push(`Agent Skill ${folder}/SKILL.md has invalid YAML frontmatter.`);
      continue;
    }
    if (!isRecord(metadata)) {
      problems.push(`Agent Skill ${folder}/SKILL.md frontmatter must be an object.`);
      continue;
    }

    const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
    const description =
      typeof metadata.description === "string" ? metadata.description.trim() : "";
    const expectedName = basename(skillDirectory);
    if (name !== expectedName) {
      problems.push(
        `Agent Skill ${folder} name must match its folder (${expectedName}); found ${name || "(missing)"}.`,
      );
    }
    if (description.length === 0 || description.length > 1024) {
      problems.push(`Agent Skill ${folder} description must contain 1-1024 characters.`);
    }
    if (text.slice(frontmatter[0].length).trim().length === 0) {
      problems.push(`Agent Skill ${folder}/SKILL.md needs an instruction body.`);
    }
    if (
      folder === REQUIRED_PROJECT_SKILL &&
      !existsSync(join(skillDirectory, ...REQUIRED_PROJECT_CONTRACT.split("/")))
    ) {
      problems.push(
        `Agent Skill ${folder} is missing ${REQUIRED_PROJECT_CONTRACT}.`,
      );
    }

    const companionFiles = collectFiles(skillDirectory).filter(
      (path) => resolve(path) !== resolve(skillPath),
    );
    if (companionFiles.length > MAX_COMPANION_FILES) {
      problems.push(
        `Agent Skill ${folder} has ${companionFiles.length} companion files; maximum is ${MAX_COMPANION_FILES}.`,
      );
    }

    let companionBytes = 0;
    for (const file of companionFiles) {
      const packagePath = relative(skillDirectory, file).replaceAll("\\", "/");
      const parts = packagePath.split("/");
      if (
        parts.some(
          (part) =>
            part.startsWith(".") ||
            !SAFE_FILE_NAME.test(part) ||
            WINDOWS_RESERVED_NAME.test(part),
        )
      ) {
        problems.push(`Agent Skill ${folder} has an unsafe companion path: ${packagePath}.`);
      }
      const size = statSync(file).size;
      companionBytes += size;
      if (size > MAX_COMPANION_FILE_BYTES) {
        problems.push(`Agent Skill companion ${folder}/${packagePath} exceeds 5 MB.`);
      }
    }
    if (companionBytes > MAX_COMPANION_TOTAL_BYTES) {
      problems.push(`Agent Skill ${folder} companion files exceed 10 MB in total.`);
    }
  }

  return problems;
}

export async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const root = packageRoot();
  const coworkRoot = join(root, "cowork");
  const manifestPath = join(coworkRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${relative(root, manifestPath)}.`);
    return 1;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CoworkManifest;
  const problems = [
    ...validateManifest(manifest),
    ...validateSkillPackage(coworkRoot, manifest),
  ];
  if (problems.length > 0) {
    console.error(`Cowork package validation failed:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }

  console.log(
    `Cowork project package OK: ${(manifest.agentSkills ?? []).length} skill(s), ` +
      `${(manifest.agentConnectors ?? []).length} connector(s); tools resolve at runtime through ` +
      "initialize + tools/list.",
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
