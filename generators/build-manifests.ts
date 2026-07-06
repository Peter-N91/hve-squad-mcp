/**
 * Manifest generator (build-time).
 *
 * Reads the authored catalog plus the deployed squad sources — the routing and
 * roster instructions and the `*.agent.md` personas — all READ-ONLY, validates
 * them against each other, and emits the runtime MCP `tools/list` descriptor
 * (`generated/mcp-tools.schema.json`).
 *
 * Drift contract (the load-bearing rule): the build FAILS (exit non-zero) when a
 * catalog tool maps to a routing intent that is not a real routing row, or to a
 * role/council agent that is not an installed agent. Per-surface manifest
 * projection (Copilot Studio, M365, Cowork) is added in Phase 1; Phase 0 emits
 * the runtime descriptor and establishes this drift check.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCatalog, type CatalogTool, type ToolCatalog } from "../src/catalog/catalog.js";
import { generatedSchemaPath, resolveSquadGithubRoot } from "../src/paths.js";

const GENERATOR_NAME = "generators/build-manifests.ts";
const DESCRIPTOR_NAME = "hve-squad-mcp";

// ---------------------------------------------------------------------------
// Markdown table parsing (skips fenced code blocks so example tables inside
// ``` fences are ignored).
// ---------------------------------------------------------------------------

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isSeparatorLine(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function parseTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (isTableLine(line) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j += 1) {
        if (/^\s*```/.test(lines[j]) || !isTableLine(lines[j])) {
          break;
        }
        rows.push(splitRow(lines[j]));
      }
      tables.push({ headers, rows });
      i = j - 1;
    }
  }
  return tables;
}

function splitKeywords(cell: string): string[] {
  return cell
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

// ---------------------------------------------------------------------------
// Read-only inputs: routing rows, roster agents, squad agent names.
// ---------------------------------------------------------------------------

export interface RoutingRow {
  patterns: string[];
}

/** Parse the Default Routing Rules table into the set of intent keyword rows. */
export function parseRoutingRows(markdown: string): RoutingRow[] {
  const table = parseTables(markdown).find((t) =>
    (t.headers[0] ?? "").toLowerCase().includes("pattern"),
  );
  if (!table) {
    throw new Error("Could not find the routing table (Pattern / Keyword) in squad-routing.instructions.md.");
  }
  return table.rows
    .filter((row) => row.length > 0 && row[0].length > 0)
    .map((row) => ({ patterns: splitKeywords(row[0]) }));
}

function addAgentName(set: Set<string>, cell: string | undefined): void {
  if (!cell) {
    return;
  }
  for (const raw of cell.split(",")) {
    const name = raw.replace(/`/g, "").trim();
    if (!name || name === "—" || name === "-" || /thin charter/i.test(name)) {
      continue;
    }
    set.add(name);
  }
}

/** Parse the roster Cast Catalog into the set of Primary + Alternate agent names. */
export function parseRosterAgents(markdown: string): string[] {
  const table = parseTables(markdown).find((t) =>
    t.headers.some((h) => h.toLowerCase().includes("primary agent")),
  );
  if (!table) {
    throw new Error("Could not find the roster cast catalog (Primary Agent) in squad-roster.instructions.md.");
  }
  const primaryIdx = table.headers.findIndex((h) => h.toLowerCase().includes("primary agent"));
  const alternateIdx = table.headers.findIndex((h) => h.toLowerCase().includes("alternate"));
  const names = new Set<string>();
  for (const row of table.rows) {
    addAgentName(names, row[primaryIdx]);
    if (alternateIdx >= 0) {
      addAgentName(names, row[alternateIdx]);
    }
  }
  return [...names];
}

/** Read `name:` frontmatter from every `*.agent.md` in a directory. */
export function readAgentNames(agentsDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md"));
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(agentsDir, file), "utf8");
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) {
      continue;
    }
    const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      names.push(nameMatch[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return names;
}

export interface GeneratorInputs {
  catalog: ToolCatalog;
  routingRows: RoutingRow[];
  knownAgents: Set<string>;
  githubRoot: string;
}

/** Load all generator inputs from disk (catalog + read-only squad sources). */
export function loadGeneratorInputs(): GeneratorInputs {
  const githubRoot = resolveSquadGithubRoot();
  if (!githubRoot) {
    throw new Error(
      "Could not resolve the squad .github root (squad-routing.instructions.md not found under squad-src/.github or .github).",
    );
  }
  const routingMd = readFileSync(
    join(githubRoot, "instructions", "squad", "squad-routing.instructions.md"),
    "utf8",
  );
  const rosterMd = readFileSync(
    join(githubRoot, "instructions", "squad", "squad-roster.instructions.md"),
    "utf8",
  );
  const routingRows = parseRoutingRows(routingMd);
  const rosterAgents = parseRosterAgents(rosterMd);
  const squadAgents = readAgentNames(join(githubRoot, "agents", "squad"));
  const knownAgents = new Set<string>([...rosterAgents, ...squadAgents]);
  return { catalog: loadCatalog(), routingRows, knownAgents, githubRoot };
}

// ---------------------------------------------------------------------------
// Drift validation + descriptor emission.
// ---------------------------------------------------------------------------

/**
 * Validate the catalog against the routing rows and known agents. Returns a list
 * of drift errors; an empty list means the catalog and the deployed cast agree.
 */
export function validateCatalog(
  catalog: ToolCatalog,
  routingRows: RoutingRow[],
  knownAgents: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const tool of catalog.tools) {
    // Check A — the routing intent must be a real routing row (catch-all is the
    // full pipeline, not a single row, so it is exempt).
    if (!tool.catchAll) {
      const keywords = splitKeywords(tool.routingIntent);
      const matched = routingRows.some((row) =>
        keywords.length > 0 && keywords.every((keyword) => row.patterns.includes(keyword)),
      );
      if (!matched) {
        errors.push(
          `tool "${tool.id}": routingIntent "${tool.routingIntent}" does not match any routing row in squad-routing.instructions.md`,
        );
      }
    }
    // Check B — the mapped role and every council member must be an installed agent.
    if (!knownAgents.has(tool.role)) {
      errors.push(
        `tool "${tool.id}": role/agent "${tool.role}" is not an installed agent (not in the roster cast catalog or squad agents)`,
      );
    }
    for (const member of tool.council) {
      if (!knownAgents.has(member)) {
        errors.push(
          `tool "${tool.id}": council member "${member}" is not an installed agent`,
        );
      }
    }
  }
  return errors;
}

interface DescriptorTool {
  name: string;
  title: string;
  description: string;
  inputSchema: CatalogTool["input"];
  routing: {
    intent: string;
    role: string;
    tier: string;
    parallelEligible: boolean;
    catchAll: boolean;
    gates: boolean;
    council: string[];
  };
}

export interface RuntimeDescriptor {
  name: string;
  schemaVersion: string;
  generatedBy: string;
  source: string;
  tools: DescriptorTool[];
}

/** Project the catalog into the runtime MCP descriptor (deterministic: no timestamp). */
export function buildDescriptor(catalog: ToolCatalog): RuntimeDescriptor {
  return {
    name: DESCRIPTOR_NAME,
    schemaVersion: catalog.schemaVersion,
    generatedBy: GENERATOR_NAME,
    source: "tools.catalog.yml",
    tools: catalog.tools.map((tool) => ({
      name: tool.id,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      routing: {
        intent: tool.routingIntent,
        role: tool.role,
        tier: tool.tier,
        parallelEligible: tool.parallelEligible,
        catchAll: tool.catchAll,
        gates: tool.gates,
        council: tool.council,
      },
    })),
  };
}

/** Run the generator as a CLI. Returns the process exit code. */
export function runCli(): number {
  let inputs: GeneratorInputs;
  try {
    inputs = loadGeneratorInputs();
  } catch (error) {
    process.stderr.write(`[build-manifests] input error: ${String(error)}\n`);
    return 1;
  }

  const errors = validateCatalog(inputs.catalog, inputs.routingRows, inputs.knownAgents);
  if (errors.length > 0) {
    process.stderr.write(
      `[build-manifests] catalog<->cast drift detected (${errors.length}):\n` +
        errors.map((message) => `  - ${message}`).join("\n") +
        "\n",
    );
    return 1;
  }

  const descriptor = buildDescriptor(inputs.catalog);
  const outPath = generatedSchemaPath();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  process.stderr.write(
    `[build-manifests] wrote ${outPath} (${descriptor.tools.length} tools; no drift).\n`,
  );
  return 0;
}

// Run only when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
