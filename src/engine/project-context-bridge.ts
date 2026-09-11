import type { RedactingLogger } from "../observability/logger.js";
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
} from "./squad-memory-state.js";

export const PROJECT_CONTEXT_SCHEMA_VERSION = 1;
export const PROJECT_CONTEXT_REGISTRY_PATH = "context/bridge";
export const PROJECT_CONTEXT_TRACKING_ROOT = ".copilot-tracking";
export const PROJECT_CONTEXT_UPDATE_MAX_CHARS = 64_000;
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export const PROJECT_INPUT_SCHEMA = {
  type: "string",
  pattern: PROJECT_NAME.source,
  description:
    "Stable lower-kebab project partition. Cowork uses the hve-project.json slug.",
} as const;

export const PROJECT_CONTEXT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "projectId", "revision", "sequence"],
  properties: {
    schemaVersion: { type: "integer", const: PROJECT_CONTEXT_SCHEMA_VERSION },
    projectId: { type: "string", pattern: PROJECT_ID.source },
    revision: { type: "integer", minimum: 0 },
    sequence: { type: "integer", minimum: 0 },
    digest: { type: "string", pattern: SHA256.source },
    trackingRoot: {
      type: "string",
      const: PROJECT_CONTEXT_TRACKING_ROOT,
    },
    storage: {
      type: "object",
      additionalProperties: false,
      required: ["provider"],
      properties: {
        provider: { type: "string", enum: ["onedrive", "sharepoint"] },
        driveId: { type: "string", minLength: 1 },
        folderItemId: { type: "string", minLength: 1 },
        displayPath: { type: "string" },
      },
    },
  },
} as const;

export interface ProjectContextStorage {
  provider: "onedrive" | "sharepoint";
  driveId?: string;
  folderItemId?: string;
  displayPath?: string;
}

export interface ProjectContextEnvelope {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  sequence: number;
  digest?: string;
  trackingRoot?: ".copilot-tracking";
  storage?: ProjectContextStorage;
}

export type ProjectContextStatus =
  | "registered"
  | "current"
  | "advanced"
  | "stateless";

export interface ProjectContextTrackingUpdate {
  path: string;
  content: string;
  updatedAt: number;
}

export interface ProjectContextAcknowledgement {
  schemaVersion: 1;
  status: ProjectContextStatus;
  project: string;
  projectId: string;
  acceptedRevision: number;
  acceptedSequence: number;
  acceptedDigest?: string;
  expectedNextRevision: number;
  trackingRoot: ".copilot-tracking";
  runId?: string;
  toolId?: string;
  trackingStatus?: "available" | "unavailable" | "not-configured";
  trackingUpdates?: ProjectContextTrackingUpdate[];
  trackingTruncated?: boolean;
}

interface StoredProjectContext extends ProjectContextEnvelope {
  project: string;
  acceptedAt: number;
}

export class ProjectContextError extends Error {
  constructor(
    readonly reason:
      | "invalid_project_context"
      | "project_identity_conflict"
      | "project_storage_conflict"
      | "stale_project_context"
      | "project_context_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ProjectContextError";
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseStorage(value: unknown): ProjectContextStorage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.storage must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.provider !== "onedrive" && record.provider !== "sharepoint") {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.storage.provider must be onedrive or sharepoint.",
    );
  }
  return {
    provider: record.provider,
    driveId: optionalString(record.driveId),
    folderItemId: optionalString(record.folderItemId),
    displayPath: optionalString(record.displayPath),
  };
}

export function parseProjectContextEnvelope(
  value: unknown,
): ProjectContextEnvelope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PROJECT_CONTEXT_SCHEMA_VERSION) {
    throw new ProjectContextError(
      "invalid_project_context",
      `projectContext.schemaVersion must be ${PROJECT_CONTEXT_SCHEMA_VERSION}.`,
    );
  }
  if (typeof record.projectId !== "string" || !PROJECT_ID.test(record.projectId)) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.projectId must be a UUID.",
    );
  }
  if (!Number.isInteger(record.revision) || Number(record.revision) < 0) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.revision must be a non-negative integer.",
    );
  }
  if (!Number.isInteger(record.sequence) || Number(record.sequence) < 0) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.sequence must be a non-negative integer.",
    );
  }
  const digest = optionalString(record.digest);
  if (digest && !SHA256.test(digest)) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.digest must be a lowercase or uppercase SHA-256 hex digest.",
    );
  }
  if (
    record.trackingRoot !== undefined &&
    record.trackingRoot !== PROJECT_CONTEXT_TRACKING_ROOT
  ) {
    throw new ProjectContextError(
      "invalid_project_context",
      `projectContext.trackingRoot must be ${PROJECT_CONTEXT_TRACKING_ROOT}.`,
    );
  }
  return {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    projectId: record.projectId,
    revision: Number(record.revision),
    sequence: Number(record.sequence),
    digest,
    trackingRoot: PROJECT_CONTEXT_TRACKING_ROOT,
    storage: parseStorage(record.storage),
  };
}

function storageConflicts(
  current: ProjectContextStorage | undefined,
  incoming: ProjectContextStorage | undefined,
): boolean {
  if (!current || !incoming) {
    return false;
  }
  return (
    current.provider !== incoming.provider ||
    (current.driveId !== undefined && current.driveId !== incoming.driveId) ||
    (current.folderItemId !== undefined &&
      current.folderItemId !== incoming.folderItemId)
  );
}

function parseStored(entry: SquadMemoryEntry): StoredProjectContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content);
  } catch {
    throw new ProjectContextError(
      "project_context_conflict",
      "The server's stored project context is malformed.",
    );
  }
  const envelope = parseProjectContextEnvelope(parsed);
  if (!envelope) {
    throw new ProjectContextError(
      "project_context_conflict",
      "The server's stored project context is missing.",
    );
  }
  const record = parsed as Record<string, unknown>;
  const project = optionalString(record.project);
  const acceptedAt = Number(record.acceptedAt);
  if (!project || !PROJECT_NAME.test(project) || !Number.isFinite(acceptedAt)) {
    throw new ProjectContextError(
      "project_context_conflict",
      "The server's stored project context has invalid metadata.",
    );
  }
  return { ...envelope, project, acceptedAt };
}

function isNewer(
  incoming: ProjectContextEnvelope,
  current: StoredProjectContext,
): boolean {
  return (
    incoming.revision > current.revision ||
    (incoming.revision === current.revision &&
      incoming.sequence > current.sequence) ||
    (incoming.revision === current.revision &&
      incoming.sequence === current.sequence &&
      (incoming.digest !== current.digest ||
        JSON.stringify(incoming.storage) !== JSON.stringify(current.storage)))
  );
}

function acknowledgement(
  project: string,
  envelope: ProjectContextEnvelope,
  status: ProjectContextStatus,
): ProjectContextAcknowledgement {
  return {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    status,
    project,
    projectId: envelope.projectId,
    acceptedRevision: envelope.revision,
    acceptedSequence: envelope.sequence,
    acceptedDigest: envelope.digest,
    expectedNextRevision: envelope.revision + 1,
    trackingRoot: PROJECT_CONTEXT_TRACKING_ROOT,
  };
}

export class ProjectContextBridge {
  constructor(
    private readonly store: SquadMemoryStore,
    private readonly logger?: RedactingLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async negotiate(
    tenantId: string,
    project: string | undefined,
    envelope: ProjectContextEnvelope | undefined,
  ): Promise<ProjectContextAcknowledgement | undefined> {
    if (!project && !envelope) {
      return undefined;
    }
    if (!project || !PROJECT_NAME.test(project) || !envelope) {
      throw new ProjectContextError(
        "invalid_project_context",
        "A project-aware call requires both project and projectContext.",
      );
    }
    const currentEntry = await this.store.read(
      tenantId,
      project,
      PROJECT_CONTEXT_REGISTRY_PATH,
    );
    const current = currentEntry ? parseStored(currentEntry) : undefined;
    if (current && current.projectId !== envelope.projectId) {
      throw new ProjectContextError(
        "project_identity_conflict",
        "This project name is already registered to a different projectId.",
      );
    }
    if (current && storageConflicts(current.storage, envelope.storage)) {
      throw new ProjectContextError(
        "project_storage_conflict",
        "This projectId is already registered to a different M365 folder.",
      );
    }
    if (
      current &&
      (envelope.revision < current.revision ||
        (envelope.revision === current.revision &&
          envelope.sequence < current.sequence))
    ) {
      throw new ProjectContextError(
        "stale_project_context",
        `Project context is stale; server has revision ${current.revision}, sequence ${current.sequence}.`,
      );
    }

    const status: ProjectContextStatus = !current
      ? "registered"
      : isNewer(envelope, current)
        ? "advanced"
        : "current";
    if (status !== "current") {
      const stored: StoredProjectContext = {
        ...envelope,
        project,
        acceptedAt: this.now(),
      };
      const result = await this.store.write(
        tenantId,
        project,
        PROJECT_CONTEXT_REGISTRY_PATH,
        JSON.stringify(stored),
        currentEntry?.etag,
      );
      if (!result.ok) {
        throw new ProjectContextError(
          "project_context_conflict",
          "Project context changed concurrently; reload the project checkpoint and retry.",
        );
      }
    }
    return acknowledgement(project, envelope, status);
  }

  async finalize(
    tenantId: string,
    acknowledgementInput: ProjectContextAcknowledgement | undefined,
    runId: string | undefined,
    toolId: string,
    acceptedAt: number,
  ): Promise<ProjectContextAcknowledgement | undefined> {
    if (!acknowledgementInput) {
      return undefined;
    }
    const output: ProjectContextAcknowledgement = {
      ...acknowledgementInput,
      runId,
      toolId,
    };
    try {
      const entries = (
        this.store.listUpdatedSince
          ? await this.store.listUpdatedSince(
              tenantId,
              acknowledgementInput.project,
              acceptedAt,
            )
          : (
              await this.store.list(
                tenantId,
                acknowledgementInput.project,
              )
            ).filter((entry) => entry.updatedAt >= acceptedAt)
      )
        .filter(
          (entry) =>
            entry.path.startsWith(`${PROJECT_CONTEXT_TRACKING_ROOT}/`) ||
              entry.path.startsWith("docs/") ||
              entry.path.startsWith("outputs/"),
        )
        .sort((left, right) => left.path.localeCompare(right.path));
      let remaining = PROJECT_CONTEXT_UPDATE_MAX_CHARS;
      const updates: ProjectContextTrackingUpdate[] = [];
      let truncated = false;
      for (const entry of entries) {
        if (entry.content.length > remaining) {
          truncated = true;
          continue;
        }
        updates.push({
          path: entry.path,
          content: entry.content,
          updatedAt: entry.updatedAt,
        });
        remaining -= entry.content.length;
      }
      return {
        ...output,
        trackingStatus: "available",
        trackingUpdates: updates,
        trackingTruncated: truncated,
      };
    } catch (error) {
      this.logger?.error("project context tracking snapshot failed", {
        project: acknowledgementInput.project,
        error: String(error),
      });
      return { ...output, trackingStatus: "unavailable" };
    }
  }
}

export function statelessProjectContextAcknowledgement(
  project: string | undefined,
  envelope: ProjectContextEnvelope | undefined,
): ProjectContextAcknowledgement | undefined {
  if (!project || !envelope) {
    return undefined;
  }
  return acknowledgement(project, envelope, "stateless");
}
