import { SQUAD_GUIDED_BANNER } from "../engine/render-embedded.js";

const DELEGATED_SENTENCE = /\s*Delegated execution:.*?(?=\s+Use for\b|$)/i;
const DELEGATED_PIPELINE = /Research -> Plan -> Implement -> Review/gi;

const MUTATING_TOOLS = new Set(["squad_memory_write", "squad_memory_sync"]);
const STATEFUL_TOOLS = new Set([
  "squad_research",
  "squad_plan",
  "squad_review",
  "squad_architect",
  "squad_run",
  "squad_federate",
  "squad_business_plan",
  "squad_backlog",
  "squad_render_pptx",
]);

export interface RemoteToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

interface RemoteToolDescriptor {
  name: string;
  title: string;
  description: string;
}

function embeddedExecutionSentence(toolId: string): string {
  if (toolId === "squad_review") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs the review stage under the squad's ` +
      "gates and methodology and returns a finished reviewer artifact (a single reviewer pass, not a convened council verdict)."
    );
  }
  if (toolId === "squad_federate") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs the federation meta layer server-side ` +
      "under its gates and methodology. Because the federation layer is gated, the call returns immediately " +
      "with a run id and PAUSES at the Human Gate; poll squad_status with that run id after an out-of-band " +
      "approval to retrieve the finished federation decision."
    );
  }
  if (toolId === "squad_run") {
    return (
      ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs the full advisory pipeline server-side ` +
      "under its gates and methodology. Because the pipeline is gated, the call returns immediately with a " +
      "run id and PAUSES at the Human Gate; poll squad_status with that run id after an out-of-band approval " +
      "to retrieve the finished artifact."
    );
  }
  return (
    ` Embedded execution (${SQUAD_GUIDED_BANNER}): the server runs this squad stage under its gates and ` +
    "methodology and returns the finished artifact."
  );
}

/** Rewrite the delegated catalog copy into the truthful remote embedded posture. */
export function toRemoteToolDescription(toolId: string, description: string): string {
  let normalized = description.replace(/\s+/g, " ").trim();
  if (toolId === "squad_run") {
    normalized = normalized.replace(
      DELEGATED_PIPELINE,
      "Research -> Plan -> Council -> Review -> Backlog handoff",
    );
  }
  return normalized
    .replace(DELEGATED_SENTENCE, embeddedExecutionSentence(toolId))
    .replace(/\s+/g, " ")
    .trim();
}

/** Preserve the confirmation hints that pinned Cowork tool descriptions carried. */
export function remoteToolAnnotations(toolId: string, title: string): RemoteToolAnnotations {
  if (MUTATING_TOOLS.has(toolId)) {
    return { title, destructiveHint: true };
  }
  if (STATEFUL_TOOLS.has(toolId)) {
    return { title };
  }
  return { title, readOnlyHint: true };
}

/** Project any runtime descriptor into the metadata served to remote MCP hosts. */
export function projectRemoteToolDescriptor<T extends RemoteToolDescriptor>(
  descriptor: T,
): T & { annotations: RemoteToolAnnotations } {
  return {
    ...descriptor,
    description: toRemoteToolDescription(descriptor.name, descriptor.description),
    annotations: remoteToolAnnotations(descriptor.name, descriptor.title),
  };
}
