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
 *   * held (PROD-5) — either queued/running work or an actual human-approval
 *     request, distinguished by reason; neither is a completed result.
 *   * denied — a quota/cost or unsupported-role refusal, surfaced as an error.
 */
import type { EmbeddedResult } from "./embedded.js";
import type { ProjectContextAcknowledgement } from "./project-context-bridge.js";
import { responsibleAiMessage } from "./responsible-ai.js";
import { modelFailureMessage, readModelFailure } from "./model-backend.js";

/** The locked fidelity claim (PROD-2). */
export const SQUAD_GUIDED_BANNER = "squad-guided / embedded";

const PRE_DISPATCH_DENIALS = new Set([
  "concurrency_cap",
  "cost_ceiling",
  "held_run_cap",
  "role_not_embedded_in_thin_slice",
  "role_not_resolvable",
]);

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
    if (result.responsibleAi) {
      const structuredContent = {
        outcome: result.outcome,
        reason: result.reason,
        runId: result.runId,
        responsibleAi: result.responsibleAi,
        ...(contextBridge ? { contextBridge } : {}),
      };
      return {
        isError: true,
        content: [{ type: "text", text: [
          responsibleAiMessage(result.responsibleAi),
          "## machine-readable", "```json",
          JSON.stringify({ ...structuredContent, contextBridge: bridgeSummary(contextBridge) }, null, 2), "```",
          result.artifact ?? "",
        ].filter(Boolean).join("\n\n") }],
        structuredContent,
      };
    }
    const modelFailure = readModelFailure(result.modelFailure);
    // Quota denials can also occur while resuming an existing run.
    const noModelCall = result.runId === undefined && result.artifact === undefined &&
      PRE_DISPATCH_DENIALS.has(result.reason ?? "");
    const failure = result.artifact || result.reason === "run_failed"
      ? `The squad run stopped (${result.reason ?? "run_failed"}). It did not complete successfully.`
      : noModelCall
        ? `The squad declined this request (${result.reason ?? "denied"}). No model call was made.`
        : `The squad request did not complete successfully (${result.reason ?? "denied"}).`;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: [failure, ...(modelFailure ? ["", modelFailureMessage(modelFailure)] : []), "", "## machine-readable", "", "```json",
                JSON.stringify({
                  outcome: result.outcome, reason: result.reason, runId: result.runId,
                  ...(modelFailure ? { modelFailure } : {}),
                  contextBridge: bridgeSummary(contextBridge),
                }, null, 2),
                "```", "", result.artifact ?? ""].join("\n"),
        },
      ],
      structuredContent: {
        outcome: result.outcome, reason: result.reason, runId: result.runId,
        ...(modelFailure ? { modelFailure } : {}),
        ...(contextBridge ? { contextBridge } : {}),
      },
    };
  }

  if (result.outcome === "held") {
    if (result.humanInput) {
      const text = [
        `<!-- hve-squad MCP (${SQUAD_GUIDED_BANNER}): awaiting human input. -->`,
        "", "## Human response required", "",
        result.humanInput.notice ?? "", result.humanInput.question,
        ...(result.humanInput.choices ?? []).map((choice) => `- ${choice}`), "",
        "Display the notice and question verbatim. Collect the user's explicit answer, then call squad_respond with this runId and questionId. Verify accepted=true before polling the same run. This does not grant operator approval or start a new run.",
        "If the user needs collaborators or more time, leave the decision pending in the shared project and stop this turn. No response or polling is required to keep this run held. Resume the same question when a substantive decision is available.",
        result.expiresAt === undefined ? "The deployment's retention policy still applies; indefinite resumption is not guaranteed." : `Run retention expires at ${new Date(result.expiresAt).toISOString()}.`,
        "", "## machine-readable", "", "```json",
        JSON.stringify({ outcome: "held", reason: result.reason, runId: result.runId, expiresAt: result.expiresAt, humanInput: result.humanInput, contextBridge: bridgeSummary(contextBridge) }, null, 2),
        "```",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { outcome: "held", reason: result.reason, runId: result.runId, expiresAt: result.expiresAt, humanInput: result.humanInput, ...(contextBridge ? { contextBridge } : {}) },
      };
    }
    const queued = ["queued", "queued_for_worker", "run_already_in_flight"].includes(result.reason ?? "");
    const text = [
      `<!-- hve-squad MCP (${SQUAD_GUIDED_BANNER}): ${queued ? "work is queued or running" : "paused at a Human Gate"}. -->`,
      "",
      queued ? "## Work queued or running" : "## Human Gate — approval required",
      "",
      queued
        ? "Work has not finished. Poll squad_status for the same run; this response does not request human approval."
        : result.approvalRequest ??
          "This action is paused for human approval. An operator with Squad.Operate must approve through squad_approve or /admin/approve; then poll the same run.",
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
