import { gzipSync, gunzipSync } from "node:zlib";
import { Ajv } from "ajv";
import type { AdvisoryResumeState } from "./advisory-pipeline.js";
import type { CoordinatorRequest } from "./coordinator-engine.js";
import type { ResearchCheckpoint } from "./research-runtime.js";

export interface PersistedAdvisoryCheckpoint {
  version: 1;
  request: CoordinatorRequest;
  resume: AdvisoryResumeState;
  stage: ResearchCheckpoint;
}

export class AdvisoryCheckpointPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Human-input checkpoint persistence failed.", { cause });
  }
}

const validateEnvelope = new Ajv({ strict: false }).compile<PersistedAdvisoryCheckpoint>({
  type: "object", required: ["version", "request", "resume", "stage"], additionalProperties: false,
  properties: {
    version: { const: 1 },
    request: { type: "object", required: ["request"], properties: { request: { type: "string" } } },
    resume: {
      type: "object", required: ["plan", "stages", "nextIndex"],
      properties: {
        plan: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["kind", "role"] } },
        stages: { type: "array", maxItems: 100, items: { type: "object", required: ["role", "section", "text"] } },
        nextIndex: { type: "integer", minimum: 0, maximum: 99 },
      },
    },
    stage: {
      type: "object",
      required: ["version", "tenantId", "project", "runId", "date", "request", "actor", "messages", "files", "calls", "tools", "evidenceSequence", "questions", "elapsedMs", "spentUsd", "questionId", "toolCallId"],
      properties: {
        version: { const: 1 },
        ...Object.fromEntries(["tenantId", "project", "runId", "date", "questionId", "toolCallId"].map((key) => [key, { type: "string", minLength: 1 }])),
        ...Object.fromEntries(["calls", "tools", "evidenceSequence", "questions", "elapsedMs", "spentUsd"].map((key) => [key, { type: "number", minimum: 0 }])),
        stageCalls: { type: "integer", minimum: 0 },
        stageTools: { type: "integer", minimum: 0 },
        stageElapsedMs: { type: "number", minimum: 0 },
        usage: {
          type: "array",
          maxItems: 1000,
          items: { anyOf: [{ type: "object" }, { type: "null" }] },
        },
        actor: { type: "object", required: ["persona", "ancestors", "loadedSkills", "skillTexts", "written", "evidence", "lanes"] },
        messages: { type: "array", minItems: 1, maxItems: 500 },
        files: { type: "array", maxItems: 48 },
      },
    },
  },
});

const MAX_RAW_BYTES = 4_000_000;
// Checkpoints spill to private blob storage; compression must not impose a tiny
// table-row budget on an otherwise valid, bounded conversation.
const MAX_COMPRESSED_BYTES = 4_100_000;

/** Private run-state data, never a client-supplied resume token. */
export function encodeAdvisoryCheckpoint(value: unknown): string {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  if (raw.length > MAX_RAW_BYTES) throw new Error("Advisory checkpoint exceeds its uncompressed limit.");
  const compressed = gzipSync(raw);
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new Error("Advisory checkpoint exceeds its storage limit.");
  return compressed.toString("base64");
}

export function decodeAdvisoryCheckpoint(value: string): unknown {
  if (value.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid advisory checkpoint encoding.");
  }

  const raw = gunzipSync(Buffer.from(value, "base64"), { maxOutputLength: MAX_RAW_BYTES });
  return JSON.parse(raw.toString("utf8"));
}

export function readAdvisoryCheckpoint(value: string): PersistedAdvisoryCheckpoint {
  const decoded = decodeAdvisoryCheckpoint(value);
  if (!validateEnvelope(decoded) || decoded.resume.nextIndex >= decoded.resume.plan.length) {
    throw new Error("Invalid advisory checkpoint envelope.");
  }
  return decoded;
}
