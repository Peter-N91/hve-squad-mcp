/**
 * Copilot Cowork plugin generator (PROD-3).
 *
 * Projects the Cowork plugin package from the same authored sources every other
 * surface is built from:
 *
 *   * `tools.catalog.yml` + the synthetic tool descriptors -> the
 *     `mcpToolDescription` file the v1.28 manifest requires.
 *   * `cowork/skills/` -> the Agent Skills the package ships (hand-authored
 *     prose, exactly like `copilot-studio/`; this generator VALIDATES them
 *     rather than writing them).
 *
 * Cowork has no sub-agents (`agents/` is not supported in the M365 manifest), so
 * the parent/child topology of `copilot-studio/` is projected as ONE dispatcher
 * skill plus narrow spoke skills that hand off to each other in prose. That
 * handoff is advisory: Cowork selects skills by description, and nothing here
 * can enforce an order the way a Copilot Studio parent can.
 *
 * The generator refuses to emit a package that would be rejected at upload:
 * every ASKILL-M and ASKILL-P rule documented for Agent Skills packaging is
 * checked here, so a failure surfaces at build time rather than as an HTTP 400.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { loadCatalog, type ToolCatalog } from "../src/catalog/catalog.js";
import { requiredScopeFor } from "../src/auth/scopes.js";
import { SQUAD_GUIDED_BANNER } from "../src/engine/render-embedded.js";
import { packageRoot } from "../src/paths.js";
import { emitOrCheck } from "./emit.js";

const FORBIDDEN_CLAIM = "squad-executed";
const DELEGATED_PHRASE = "delegated execution";

/** Agent Skills packaging limits (ASKILL-M002, companion-file rules, loading model). */
const MAX_SKILLS = 20;
const MAX_CONNECTORS = 10;
const MAX_COMPANION_FILES = 20;
const MAX_COMPANION_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_COMPANION_BYTES = 10 * 1024 * 1024;
const MAX_FOLDER_PATH_CHARS = 256;
const MAX_DESCRIPTION_CHARS = 1024;
/** The documented target for a skill body; over this the body stops loading reliably. */
const SKILL_BODY_TOKEN_TARGET = 5000;
/** Rough chars-per-token used only to warn well before the real limit. */
const CHARS_PER_TOKEN = 4;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One tool as the `mcpToolDescription` file declares it (MCP `tools/list` shape). */
export interface CoworkTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  annotations: { title: string; readOnlyHint?: boolean; destructiveHint?: boolean };
  /** The OAuth scope the server enforces for this tool (documentation only). */
  scope: string | undefined;
}

/**
 * Rewrite the catalog's Phase 0 DELEGATED copy into the embedded claim. The
 * catalog describes the VS Code stdio surface, where the calling host runs the
 * subagent loop; Cowork is a tool caller, so shipping that copy verbatim would
 * tell a user the wrong thing about where execution happens (PROD-2 / MINOR-1).
 */
const DELEGATED_SENTENCE = /\s*Delegated execution:.*?(?=\s+Use for\b|$)/i;

function embeddedSentence(toolId: string): string {
  if (toolId === "squad_run" || toolId === "squad_federate") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs this server-side under its gates. ` +
      "Because it is gated, the call returns immediately with a run id and may PAUSE at the Human Gate; " +
      "poll squad_status with that run id to advance the run after an out-of-band operator approval."
    );
  }
  if (toolId === "squad_review") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs the review stage under the squad's gates ` +
      "and returns a finished reviewer artifact (a single reviewer pass, not a convened council verdict)."
    );
  }
  return (
    ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs this squad stage under its gates and ` +
    "returns the finished artifact."
  );
}

export function toCoworkDescription(toolId: string, description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  return normalized.replace(DELEGATED_SENTENCE, embeddedSentence(toolId)).replace(/\s+/g, " ").trim();
}

/** Text-in / text-out advisory tools carry no impactful action. */
function advisoryAnnotations(title: string) {
  return { title, readOnlyHint: true };
}

/**
 * Annotate a catalog tool. A gated catch-all (`squad_run`, `squad_federate`)
 * allocates durable run state and can pause at the Human Gate, so it is NOT
 * read-only even though it lands no impactful action — claiming otherwise would
 * let it auto-run once annotation-driven confirmation reaches this connector.
 */
function catalogAnnotations(tool: { title: string; gates: boolean }) {
  return tool.gates ? { title: tool.title } : advisoryAnnotations(tool.title);
}

/**
 * The synthetic tools, declared here for the same reason
 * `build-copilot-studio-connector.ts` declares them: they are transport-level
 * utilities, not routing intents, so they are absent from `tools.catalog.yml`.
 *
 * `annotations` drive Cowork's confirmation prompts for non-Microsoft MCP
 * servers. Setting them is forward-compatible: the prompts surface as that
 * rollout expands, with no change here.
 */
function syntheticTools(): CoworkTool[] {
  const project = {
    type: "string",
    pattern: "^[a-z0-9][a-z0-9-]*$",
    description: "The project namespace within your tenant (lowercase dns-ish label).",
  };
  const target = {
    type: "string",
    pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
    description:
      "Optional operator-declared storage destination to use. Omit to use the deployment's default.",
  };
  return [
    {
      name: "squad_status",
      title: "Squad Status",
      description:
        "Poll an async squad run by its run id and return its status; when the run is complete, return " +
        "the finished squad-guided artifact. A held run stays paused until an operator approves it " +
        "out-of-band — the squad never auto-releases a gate.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string", description: "The server-allocated run id returned by squad_run." },
        },
      },
      annotations: advisoryAnnotations("Squad Status"),
      scope: requiredScopeFor("squad_status"),
    },
    {
      name: "squad_business_plan",
      title: "Squad Business Plan",
      description:
        `Turn an idea, opportunity, or rough brief into a sponsor-readable business plan (${SQUAD_GUIDED_BANNER}) ` +
        "in exactly ten sections: Summary, Problem and Customer, Proposed Solution, Value and Success " +
        "Measures, Scope, Go-to-Market, Cost and Effort Outline, Risks and Dependencies, Milestones, and " +
        "Open Questions. Plans only: it reaches no tracker and writes to no business system. Served only " +
        "when the operator has enabled the business tools.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["request"],
        properties: {
          request: { type: "string", minLength: 1, description: "The opportunity and the sponsor decision." },
          context: { type: "string", description: "Evidence, customer, constraints, budget envelope." },
          squad: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "Optional sub-squad target." },
        },
      },
      annotations: advisoryAnnotations("Squad Business Plan"),
      scope: requiredScopeFor("squad_business_plan"),
    },
    {
      name: "squad_backlog",
      title: "Squad Backlog",
      description:
        `Turn approved scope into a structured delivery backlog (${SQUAD_GUIDED_BANNER}) returned as JSON: ` +
        "epics, user stories with acceptance criteria, and tasks, plus a flattened 'workItems' array with " +
        "stable 'ref'/'parentRef' ids. Create the items by calling the Azure DevOps or Jira connector once " +
        "per element of 'workItems', parents first, linking children by 'parentRef'. This tool only plans — " +
        "it writes nothing to Azure DevOps or Jira. Served only when the operator has enabled the business tools.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["request"],
        properties: {
          request: { type: "string", minLength: 1, description: "The outcome to decompose." },
          context: { type: "string", description: "Approved plan, NFRs, definition of done, exclusions." },
          squad: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "Optional sub-squad target." },
        },
      },
      annotations: advisoryAnnotations("Squad Backlog"),
      scope: requiredScopeFor("squad_backlog"),
    },
    {
      name: "squad_render_pptx",
      title: "Squad Render PPTX",
      description:
        "Render a PowerPoint deck from content YAML and style YAML and return a short-lived download link " +
        "to the generated .pptx file. Deterministic: no model call. Creates a stored file as its only side " +
        "effect. Served only when the operator has enabled rendering.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["contentYaml", "styleYaml"],
        properties: {
          contentYaml: {
            type: "string",
            description: "A YAML document with a top-level 'slides:' array; each item is one slide.",
          },
          styleYaml: { type: "string", description: "The global style.yaml body (dimensions, layouts, defaults)." },
        },
      },
      annotations: { title: "Render PowerPoint Deck" },
      scope: requiredScopeFor("squad_render_pptx"),
    },
    {
      name: "squad_memory_read",
      title: "Squad Memory Read",
      description:
        "Read one entry of the project's own squad memory and return its content and etag (the etag to pass " +
        "as expectedEtag on a subsequent write). Deterministic: no model call, no impactful action.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["project", "path"],
        properties: {
          project,
          path: { type: "string", description: "The logical memory path (e.g. 'state', 'decisions')." },
          target,
        },
      },
      annotations: advisoryAnnotations("Squad Memory Read"),
      scope: requiredScopeFor("squad_memory_read"),
    },
    {
      name: "squad_memory_write",
      title: "Squad Memory Write",
      description:
        "Write (create or replace) one entry of the project's own squad memory under compare-and-swap and " +
        "return the new etag. Pass the prior etag as expectedEtag to guard against clobbering a concurrent " +
        "writer; omit it for a first write. Deterministic: no model call.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["project", "path", "content"],
        properties: {
          project,
          path: { type: "string", description: "The logical memory path (e.g. 'state', 'decisions')." },
          content: { type: "string", description: "The full new content to persist at 'path'." },
          expectedEtag: { type: "string", description: "The etag from the prior read; the write applies only if it matches." },
          target,
        },
      },
      annotations: { title: "Squad Memory Write", destructiveHint: true },
      scope: requiredScopeFor("squad_memory_write"),
    },
    {
      name: "squad_memory_sync",
      title: "Squad Memory Sync",
      description:
        "Flush a batch of the project's own squad-memory entries in one call. Each item is written under its " +
        "own compare-and-swap; a stale expectedEtag on one item is reported as a conflict in the results " +
        "without aborting the others. Returns a per-item result array. Deterministic: no model call.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["project", "items"],
        properties: {
          project,
          items: {
            type: "array",
            description: "The entries to flush; each is applied under its own compare-and-swap.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "content"],
              properties: {
                path: { type: "string", description: "The logical memory path." },
                content: { type: "string", description: "The full new content for this entry." },
                expectedEtag: { type: "string", description: "The etag from the prior read of this entry." },
              },
            },
          },
          target,
        },
      },
      annotations: { title: "Squad Memory Sync", destructiveHint: true },
      scope: requiredScopeFor("squad_memory_sync"),
    },
    {
      name: "squad_history",
      title: "Squad History",
      description:
        "Browse and open what previous squad runs produced for a project: the squad state, each role's " +
        "deliverables, and the per-agent history. Use op='index' for a compact picture of what exists, " +
        "op='list' to enumerate a directory, and op='read' to open one artifact. Deterministic: no model " +
        "call. Served only when the operator has enabled the squad ledger.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["project"],
        properties: {
          project,
          op: {
            type: "string",
            enum: ["index", "list", "read"],
            description: "index (default) summarizes; list enumerates a prefix; read opens one path.",
          },
          prefix: { type: "string", description: "For op='list': a directory such as '.copilot-tracking/plans'." },
          path: { type: "string", description: "For op='read': the artifact path from a list result." },
        },
      },
      annotations: advisoryAnnotations("Squad History"),
      scope: requiredScopeFor("squad_history"),
    },
  ];
}

/** The `mcpToolDescription` payload: every tool the Cowork connector can reach. */
export function buildToolDescription(catalog: ToolCatalog): {
  name: string;
  fidelityClaim: string;
  generatedBy: string;
  source: string;
  tools: CoworkTool[];
} {
  const tools: CoworkTool[] = catalog.tools.map((tool) => ({
    name: tool.id,
    title: tool.title,
    description: toCoworkDescription(tool.id, tool.description),
    inputSchema: tool.input,
    annotations: catalogAnnotations(tool),
    scope: requiredScopeFor(tool.id),
  }));
  tools.push(...syntheticTools());

  const payload = {
    name: "hve-squad",
    fidelityClaim: SQUAD_GUIDED_BANNER,
    generatedBy: "generators/build-cowork-plugin.ts",
    source: "tools.catalog.yml",
    tools,
  };

  // PROD-2: never ship copy that claims execution rather than guidance.
  const blob = JSON.stringify(payload).toLowerCase();
  if (blob.includes(FORBIDDEN_CLAIM)) {
    throw new Error(`Cowork copy must not contain the forbidden claim "${FORBIDDEN_CLAIM}" (PROD-2).`);
  }
  for (const tool of payload.tools) {
    if (tool.description.toLowerCase().includes(DELEGATED_PHRASE)) {
      throw new Error(
        `Tool "${tool.name}" still carries delegated-execution copy; Cowork is a tool caller (PROD-2).`,
      );
    }
  }
  return payload;
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

/**
 * Parse a skill's YAML frontmatter.
 *
 * Uses the real YAML parser rather than a regex: the Cowork docs recommend a
 * block scalar (`description: |`) for the description, and a hand-rolled matcher
 * silently captured the `|` itself — which made the length check pass on a
 * one-character string and validate nothing.
 */
function parseFrontmatter(source: string): SkillFrontmatter | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (name.length === 0 || description.length === 0) {
    return undefined;
  }
  return { name, description };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Validate the authored skills against the packaging rules Cowork enforces at
 * upload. Returns the problems found; an empty list means the package is
 * uploadable as far as these rules can tell.
 */
export function validateSkills(coworkRoot: string, skillFolders: string[]): string[] {
  const problems: string[] = [];

  if (skillFolders.length > MAX_SKILLS) {
    problems.push(`ASKILL-M002: ${skillFolders.length} skills exceeds the limit of ${MAX_SKILLS}.`);
  }

  for (const folder of skillFolders) {
    if (folder.length > MAX_FOLDER_PATH_CHARS) {
      problems.push(`ASKILL-M003: folder path exceeds ${MAX_FOLDER_PATH_CHARS} characters: ${folder}`);
    }
    const abs = join(coworkRoot, folder);
    if (!existsSync(abs)) {
      problems.push(`ASKILL-P001: folder referenced in manifest is missing from the package: ${folder}`);
      continue;
    }
    const skillFile = join(abs, "SKILL.md");
    if (!existsSync(skillFile)) {
      problems.push(`ASKILL-P002: no SKILL.md in ${folder}`);
      continue;
    }
    const source = readFileSync(skillFile, "utf8");
    const front = parseFrontmatter(source);
    if (!front) {
      problems.push(`ASKILL-P003/P004/P005: ${folder}/SKILL.md needs valid frontmatter with name and description.`);
      continue;
    }
    const expected = folder.split("/").pop() ?? "";
    if (front.name !== expected) {
      problems.push(`ASKILL-P006: ${folder}/SKILL.md declares name "${front.name}" but the folder is "${expected}".`);
    }
    if (!KEBAB.test(front.name)) {
      problems.push(`Naming: "${front.name}" is not kebab-case (lowercase alphanumerics and single hyphens).`);
    }
    if (front.description.length < 1 || front.description.length > MAX_DESCRIPTION_CHARS) {
      problems.push(
        `Description: ${folder} is ${front.description.length} chars; the limit is ${MAX_DESCRIPTION_CHARS}. ` +
          "Over the limit the skill never loads.",
      );
    }
    const body = source.slice(source.indexOf("---", 3) + 3);
    const approxTokens = Math.round(body.length / CHARS_PER_TOKEN);
    if (approxTokens > SKILL_BODY_TOKEN_TARGET) {
      problems.push(
        `Body size: ${folder}/SKILL.md is ~${approxTokens} tokens, over the ${SKILL_BODY_TOKEN_TARGET}-token ` +
          "target. Move detail into references/.",
      );
    }

    const companions = walk(abs).filter((file) => file !== skillFile);
    if (companions.length > MAX_COMPANION_FILES) {
      problems.push(`Companions: ${folder} has ${companions.length} companion files; the limit is ${MAX_COMPANION_FILES}.`);
    }
    let total = 0;
    for (const file of companions) {
      const size = statSync(file).size;
      total += size;
      const rel = relative(abs, file).replace(/\\/g, "/");
      if (size > MAX_COMPANION_BYTES) {
        problems.push(`Companions: ${folder}/${rel} is larger than 5 MB.`);
      }
      if (rel.includes("..") || rel.startsWith("/") || rel.split("/").some((part) => part.startsWith("."))) {
        problems.push(`Companions: ${folder}/${rel} uses a hidden segment or path traversal.`);
      }
    }
    if (total > MAX_TOTAL_COMPANION_BYTES) {
      problems.push(`Companions: ${folder} companions total ${total} bytes, over the 10 MB limit.`);
    }
  }
  return problems;
}

interface CoworkManifest {
  agentSkills?: { folder: string }[];
  agentConnectors?: {
    toolSource?: { remoteMcpServer?: { mcpToolDescription?: { file?: string } } };
  }[];
}

/**
 * Validate the manifest's own constraints and its references into the package.
 *
 * Paths are checked as ARCHIVE ENTRY NAMES, not just as filesystem paths. The
 * packaging service resolves `mcpToolDescription.file` and each skill `folder`
 * by literal lookup against the zip's entry names, which carry no `./` prefix
 * and no backslashes. A `./tools/x.json` that resolves perfectly well on disk is
 * therefore reported at publish time as "not found in the app package" — so a
 * path that would not match an entry is an error here, not a style preference.
 */
export function validateManifest(coworkRoot: string, manifest: CoworkManifest): string[] {
  const problems: string[] = [];

  /** Reject any path shape a zip entry name can never take. */
  const checkEntryPath = (value: string, field: string): void => {
    if (value.startsWith("./") || value.startsWith("../")) {
      problems.push(
        `${field} is "${value}"; the package service matches archive entry names literally and those ` +
          `carry no "./" prefix. Use "${value.replace(/^\.\.?\//, "")}".`,
      );
    }
    if (value.includes("\\")) {
      problems.push(`${field} is "${value}"; archive entry names use forward slashes only.`);
    }
    if (value.startsWith("/")) {
      problems.push(`${field} is "${value}"; the path must be relative to the package root.`);
    }
  };

  const skills = manifest.agentSkills ?? [];
  for (const entry of skills) {
    if (!entry.folder) {
      problems.push("ASKILL-M001: every agentSkills entry needs a 'folder'.");
      continue;
    }
    checkEntryPath(entry.folder, `agentSkills folder`);
  }
  const connectors = manifest.agentConnectors ?? [];
  if (connectors.length > MAX_CONNECTORS) {
    problems.push(`Connectors: ${connectors.length} exceeds the limit of ${MAX_CONNECTORS}.`);
  }
  for (const connector of connectors) {
    const file = connector.toolSource?.remoteMcpServer?.mcpToolDescription?.file;
    if (!file) {
      problems.push(
        "mcpToolDescription is required on every remoteMcpServer connector; without it the upload " +
          "fails with HTTP 400.",
      );
      continue;
    }
    checkEntryPath(file, "mcpToolDescription.file");
    if (!existsSync(join(coworkRoot, file))) {
      problems.push(`mcpToolDescription.file points at ${file}, which is not in the package.`);
    }
  }
  return problems;
}

/** Stable content hash, so a rebuild that changed nothing is visible as such. */
function digest(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
}

export async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const root = packageRoot();
  const coworkRoot = join(root, "cowork");
  const catalog = loadCatalog(join(root, "tools.catalog.yml"));

  const payload = buildToolDescription(catalog);
  const toolsPath = join(coworkRoot, "tools", "hve-squad-tools.json");
  const toolsJson = `${JSON.stringify(payload, null, 2)}\n`;

  const stale = emitOrCheck(new Map([[toolsPath, toolsJson]]), check, root);
  if (check && stale.length > 0) {
    console.error(`Stale Cowork outputs (run \`npm run generate:cowork\`):\n  ${stale.join("\n  ")}`);
    return 1;
  }

  const manifestPath = join(coworkRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`Missing ${relative(root, manifestPath)}.`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CoworkManifest;
  const folders = (manifest.agentSkills ?? []).map((entry) => entry.folder);

  const problems = [
    ...validateManifest(coworkRoot, manifest),
    ...validateSkills(coworkRoot, folders),
  ];
  if (problems.length > 0) {
    console.error(`Cowork package validation failed:\n  - ${problems.join("\n  - ")}`);
    return 1;
  }

  console.log(
    `Cowork package OK: ${folders.length} skill(s), ` +
      `${(manifest.agentConnectors ?? []).length} connector(s), ` +
      `${payload.tools.length} tool(s) described (tools digest ${digest(toolsJson)}).`,
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
