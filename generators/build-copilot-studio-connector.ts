/**
 * Copilot Studio connector generator (Step 1.6 — PROD-1, PROD-2, PROD-3, PROD-4).
 *
 * Projects the Copilot Studio MCP connector from the one authored catalog,
 * exposing ONLY the hero tools. It is a build artifact, not a hand-maintained
 * file — regenerate it, never edit `generated/copilot-studio-connector/` by hand.
 *
 *   * PROD-1 — the remotely-exposed tools are projected: the four synchronous
 *     advisory tools (`squad_research`, `squad_review`, `squad_plan`,
 *     `squad_architect`), the gated async pipeline `squad_run`, and the
 *     `squad_status` poll utility. squad_run is exposed but holds at the Human Gate.
 *   * PROD-2 — the fidelity claim is locked to "squad-guided / embedded" (the
 *     same banner the runtime uses), never "squad-executed"; the generator
 *     refuses to emit copy that contains the forbidden phrase.
 *   * PROD-3 / PROD-4 — only the `copilot-studio` target is produced. No M365 /
 *     Agent 365 and no Cowork manifest is generated or promised here.
 *
 * Additive: this is a NEW generator beside `build-manifests.ts`; it does not edit
 * the Phase 0 generator.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadCatalog, type ToolCatalog } from "../src/catalog/catalog.js";
import { isRemotelyExposed, requiredScopeFor, SQUAD_STATUS_TOOL, SQUAD_RENDER_PPTX_TOOL } from "../src/auth/scopes.js";
import { SQUAD_GUIDED_BANNER } from "../src/engine/render-embedded.js";
import { packageRoot } from "../src/paths.js";

const FORBIDDEN_CLAIM = "squad-executed";
const DELEGATED_PHRASE = "delegated execution";
const TARGET = "copilot-studio";
const PROTOCOL = "mcp-streamable-1.0";

/**
 * The authored catalog describes the Phase 0 DELEGATED surface (VS Code stdio):
 * the tool returns a charter and the calling host runs the subagent loop. The
 * Copilot Studio connector is the EMBEDDED surface — the server runs the squad
 * stage and returns a finished artifact — so projecting the catalog copy verbatim
 * would tell a maker the wrong thing about where execution happens (MINOR-1) and
 * undercut the locked "squad-guided / embedded" claim (PROD-2). We rewrite the
 * catalog's "Delegated execution: …" sentence into the embedded banner here, in
 * the connector projection only; the catalog (the delegated truth) is untouched.
 */
const DELEGATED_SENTENCE = /\s*Delegated execution:.*?(?=\s+Use for\b|$)/i;

function embeddedExecutionSentence(toolId: string): string {
  if (toolId === "squad_review") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs the review stage under the squad's ` +
      "gates and methodology and returns a finished reviewer artifact (a single reviewer pass, not a convened council verdict)."
    );
  }
  if (toolId === "squad_run") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs the full squad pipeline server-side ` +
      "under its gates and methodology. Because the pipeline is gated, the call returns immediately with a " +
      "run id and PAUSES at the Human Gate; poll squad_status with that run id to advance the run after an " +
      "out-of-band approval and to retrieve the finished artifact."
    );
  }
  return (
    ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs this squad stage under its gates and ` +
    "methodology and returns the finished artifact."
  );
}

/**
 * Project a hero tool's connector description with embedded (not delegated)
 * execution copy. Exported for direct unit assertion.
 */
export function toConnectorDescription(toolId: string, description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  const rewritten = normalized.replace(DELEGATED_SENTENCE, embeddedExecutionSentence(toolId));
  return rewritten.replace(/\s+/g, " ").trim();
}

export interface ConnectorHeroTool {
  name: string;
  title: string;
  description: string;
  scope: string | undefined;
}

/**
 * The synthetic status-poll utility projected into the connector. It is not a
 * catalog tool (no squad routing intent), so it is described here directly.
 */
function statusConnectorTool(): ConnectorHeroTool {
  return {
    name: SQUAD_STATUS_TOOL,
    title: "Squad Status",
    description:
      `Poll an async squad run by its run id (${SQUAD_GUIDED_BANNER}). Returns the run status; when the run ` +
      "is complete, returns the finished squad-guided artifact. A held run stays paused until an operator " +
      "approves it out-of-band — the squad never auto-releases a gate.",
    scope: requiredScopeFor(SQUAD_STATUS_TOOL),
  };
}

/**
 * The synthetic deterministic render tool projected into the connector. Not a
 * catalog tool (no squad routing intent) and served only when the operator
 * enables render; it is documented here so a maker knows to grant its
 * least-privilege {@link SQUAD_RENDER_PPTX_TOOL} scope.
 */
function renderConnectorTool(): ConnectorHeroTool {
  return {
    name: SQUAD_RENDER_PPTX_TOOL,
    title: "Squad Render PPTX",
    description:
      "Render a PowerPoint deck from content YAML and style YAML and return a short-lived download link to " +
      "the generated .pptx file. Deterministic file output: no model call and no impactful action. Served only " +
      "when the operator has enabled the render feature.",
    scope: requiredScopeFor(SQUAD_RENDER_PPTX_TOOL),
  };
}

export interface ConnectorManifest {
  /** The single surface this thin slice targets (PROD-1). */
  targets: string[];
  /** Locked fidelity claim (PROD-2). */
  fidelityClaim: string;
  /** The MCP transport protocol the connector negotiates. */
  protocol: string;
  /** The tools exposed over the remote boundary (Phase 1b.4). */
  tools: ConnectorHeroTool[];
  /** Explicitly recorded non-targets (PROD-3, PROD-4). */
  deferredTargets: string[];
}

/** Build the deterministic connector manifest (the testable summary artifact). */
export function buildConnectorManifest(catalog: ToolCatalog): ConnectorManifest {
  const tools: ConnectorHeroTool[] = catalog.tools
    .filter((tool) => isRemotelyExposed(tool.id))
    .map((tool) => ({
      name: tool.id,
      title: tool.title,
      description: toConnectorDescription(tool.id, tool.description),
      scope: requiredScopeFor(tool.id),
    }));
  // Append the synthetic status-poll utility (not a catalog tool).
  tools.push(statusConnectorTool());
  // Append the synthetic deterministic render tool (not a catalog tool).
  tools.push(renderConnectorTool());

  const manifest: ConnectorManifest = {
    targets: [TARGET],
    fidelityClaim: SQUAD_GUIDED_BANNER,
    protocol: PROTOCOL,
    tools,
    deferredTargets: ["m365", "agent-365", "cowork"],
  };

  // PROD-2: refuse to emit a connector that claims execution rather than guidance.
  const blob = JSON.stringify(manifest).toLowerCase();
  if (blob.includes(FORBIDDEN_CLAIM)) {
    throw new Error(`Connector copy must not contain the forbidden claim "${FORBIDDEN_CLAIM}" (PROD-2).`);
  }
  // PROD-2 / MINOR-1: the embedded connector must not carry the Phase 0 delegated
  // execution copy — that would tell a maker the calling host runs the loop.
  for (const tool of manifest.tools) {
    if (tool.description.toLowerCase().includes(DELEGATED_PHRASE)) {
      throw new Error(
        `Tool "${tool.name}" still carries delegated-execution copy; ` +
          `the embedded connector must read "${SQUAD_GUIDED_BANNER}" (PROD-2).`,
      );
    }
  }
  return manifest;
}

/** Build the Swagger 2.0 definition Copilot Studio imports as a custom connector. */
export function buildSwagger(manifest: ConnectorManifest): Record<string, unknown> {
  return {
    swagger: "2.0",
    info: {
      title: "hve-squad (squad-guided / embedded)",
      description:
        `Calls the hve-squad MCP server (${manifest.fidelityClaim}). The squad runs server-side ` +
        "under its gates and methodology; this connector exposes " +
        `${manifest.tools.map((tool) => tool.name).join(", ")}.`,
      version: "1.0",
    },
    host: "<SQUAD_MCP_HOST>",
    basePath: "/",
    schemes: ["https"],
    consumes: ["application/json"],
    produces: ["application/json"],
    paths: {
      "/mcp": {
        post: {
          summary: "hve-squad MCP (squad-guided / embedded)",
          description: `Streamable HTTP MCP endpoint. ${manifest.fidelityClaim}.`,
          operationId: "InvokeMCP",
          "x-ms-agentic-protocol": manifest.protocol,
          responses: { "200": { description: "Success" } },
        },
      },
    },
    securityDefinitions: {
      "entra-oauth2": {
        type: "oauth2",
        flow: "accessCode",
        authorizationUrl: "https://login.microsoftonline.com/<ENTRA_TENANT_ID>/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/<ENTRA_TENANT_ID>/oauth2/v2.0/token",
        scopes: Object.fromEntries(
          manifest.tools
            .filter((tool) => typeof tool.scope === "string")
            .map((tool) => [tool.scope as string, `Invoke ${tool.name}`]),
        ),
      },
    },
    security: [{ "entra-oauth2": [] }],
  };
}

/** Build the connector connection (auth) properties — placeholders only, no secrets. */
export function buildApiProperties(manifest: ConnectorManifest): Record<string, unknown> {
  return {
    properties: {
      connectionParameters: {
        token: {
          type: "oauthSetting",
          oAuthSettings: {
            identityProvider: "aadcertificate",
            clientId: "<ENTRA_CLIENT_ID>",
            scopes: manifest.tools.map((tool) => tool.scope).filter((scope): scope is string => Boolean(scope)),
            properties: {
              IsFirstParty: "false",
              AzureActiveDirectoryResourceId: "<SQUAD_MCP_AUDIENCE>",
            },
          },
        },
      },
      iconBrandColor: "#0b5394",
      capabilities: ["actions"],
      publisher: "hve-squad",
    },
  };
}

function buildReadme(manifest: ConnectorManifest): string {
  const toolList = manifest.tools
    .map((tool) => `- \`${tool.name}\` — ${tool.title} (scope: \`${tool.scope ?? "n/a"}\`)`)
    .join("\n");
  return [
    "<!-- markdownlint-disable-file -->",
    "# Copilot Studio connector (generated)",
    "",
    `> **Fidelity claim (locked):** ${manifest.fidelityClaim} — NOT "squad-executed".`,
    "> The squad runs server-side under its gates and methodology and returns a finished",
    "> artifact; the calling agent is guided by the squad, it does not itself execute the cast.",
    "",
    "This connector is a **generated build artifact**. Regenerate it with",
    "`npm run generate:connector`; do not edit by hand.",
    "",
    "## Exposed tools (Phase 1b.4)",
    "",
    toolList,
    "",
    "> `squad_run` is the gated async pipeline: it returns a run id and pauses at the",
    "> Human Gate. Poll `squad_status` with that run id to advance the run after an",
    "> out-of-band approval and to retrieve the finished artifact. `squad_plan` and",
    "> `squad_architect` are synchronous advisory tools (single-stage, no impactful action).",
    "",
    "## Not targeted in the thin slice",
    "",
    "- M365 / Agent 365 (deferred to Phase 1b — PROD-4)",
    "- Microsoft Cowork (deferred to Phase 1b pending verification — PROD-3)",
    "",
    "## Import",
    "",
    "1. Replace `<SQUAD_MCP_HOST>`, `<ENTRA_TENANT_ID>`, `<ENTRA_CLIENT_ID>`, and",
    "   `<SQUAD_MCP_AUDIENCE>` in `apiDefinition.swagger.json` / `apiProperties.json`.",
    "2. In Copilot Studio, add a custom connector from the OpenAPI file (or use the MCP",
    "   onboarding wizard) and complete the Entra OAuth 2.0 connection.",
    "3. Enable generative orchestration on the agent so it can call the MCP tools.",
    "",
    "See `host/RUNBOOK.md` for the full deploy + import steps and where real spend begins.",
    "",
  ].join("\n");
}

/** Run the generator as a CLI. Returns the process exit code. */
export function runCli(): number {
  let manifest: ConnectorManifest;
  try {
    manifest = buildConnectorManifest(loadCatalog());
  } catch (error) {
    process.stderr.write(`[build-copilot-studio-connector] ${String(error)}\n`);
    return 1;
  }

  const outDir = join(packageRoot(), "generated", "copilot-studio-connector");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "connector.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    join(outDir, "apiDefinition.swagger.json"),
    `${JSON.stringify(buildSwagger(manifest), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(outDir, "apiProperties.json"),
    `${JSON.stringify(buildApiProperties(manifest), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(outDir, "README.md"), buildReadme(manifest), "utf8");
  process.stderr.write(
    `[build-copilot-studio-connector] wrote ${outDir} (${manifest.tools.length} tools; target=${manifest.targets.join(",")}).\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
