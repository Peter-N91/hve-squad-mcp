/**
 * Render an {@link EmbeddedResult} into MCP tool-call content.
 *
 * PROD-2: the fidelity claim is locked to **"squad-guided / embedded"** — never
 * "squad-executed". The banner below is the single source of that wording for
 * the embedded path; the connector description (`generated/copilot-studio-connector/`)
 * uses the same phrase so the partner-facing claim is consistent.
 *
 * The three outcomes render distinctly:
 *   * completed — the artifact, the matched routing, and a machine block.
 *   * held (PROD-5) — the human-approval request; this is a valid paused state,
 *     not an error, and it makes the never-auto-release behavior visible.
 *   * denied — a quota/cost or unsupported-role refusal, surfaced as an error.
 */
import type { EmbeddedResult } from "./embedded.js";
import type { ProjectContextAcknowledgement } from "./project-context-bridge.js";

/** The locked fidelity claim (PROD-2). */
export const SQUAD_GUIDED_BANNER = "squad-guided / embedded";

export interface RenderedToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function routingLines(result: EmbeddedResult): string[] {
  const r = result.matchedRouting;
  return [
    "## matchedRouting",
    "",
    `- intent: ${r.routingIntent}`,
    `- role: ${r.role}`,
    `- tier: ${r.tier}`,
    `- council: ${r.council.length > 0 ? r.council.join(", ") : "(none)"}`,
  ];
}

function bridgeSummary(
  bridge: ProjectContextAcknowledgement | undefined,
): Record<string, unknown> | undefined {
  if (!bridge) {
    return undefined;
  }
  const { trackingUpdates, ...summary } = bridge;
  return {
    ...summary,
    trackingUpdatePaths: (trackingUpdates ?? []).map((update) => update.path),
  };
}

export function renderEmbeddedResult(
  result: EmbeddedResult,
  contextBridge?: ProjectContextAcknowledgement,
): RenderedToolResult {
  if (result.outcome === "denied") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `The squad declined this request (${result.reason ?? "denied"}). ` +
            "No model call was made.",
        },
      ],
      structuredContent: contextBridge ? { contextBridge } : undefined,
    };
  }

  if (result.outcome === "held") {
    const text = [
      `<!-- hve-squad MCP (${SQUAD_GUIDED_BANNER}): paused at a Human Gate. -->`,
      "",
      "## Human Gate — approval required",
      "",
      result.approvalRequest ??
        "This action is paused for human approval and will not proceed until approved out-of-band.",
      "",
      ...routingLines(result),
      "",
      "## machine-readable",
      "",
      "```json",
      JSON.stringify(
        {
          mode: "embedded",
          outcome: "held",
          reason: result.reason,
          runId: result.runId,
          contextBridge: bridgeSummary(contextBridge),
        },
        null,
        2,
      ),
      "```",
    ].join("\n");
    return {
      content: [{ type: "text", text }],
      structuredContent: contextBridge ? { contextBridge } : undefined,
    };
  }

  // completed
  const text = [
    `<!-- hve-squad MCP (${SQUAD_GUIDED_BANNER}). Produced server-side under the squad's gates. -->`,
    "",
    `## Result (${SQUAD_GUIDED_BANNER})`,
    "",
    result.artifact ?? "",
    "",
    ...routingLines(result),
    "",
    "## machine-readable",
    "",
    "```json",
    JSON.stringify(
      {
        mode: "embedded",
        outcome: "completed",
        backendId: result.backendId,
        runId: result.runId,
        usage: result.usage,
        contextBridge: bridgeSummary(contextBridge),
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    structuredContent: contextBridge ? { contextBridge } : undefined,
  };
}
