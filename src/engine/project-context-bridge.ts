import type { RedactingLogger } from "../observability/logger.js";
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
} from "./squad-memory-state.js";

export const PROJECT_CONTEXT_SCHEMA_VERSION = 2;
export const PROJECT_CONTEXT_REGISTRY_PATH = "context/bridge";
// Not a valid caller-supplied project name, nor a projected tracking path.
export const PROJECT_CONTEXT_INDEX_PROJECT = "_hve-project-index";
export const PROJECT_CONTEXT_INDEX_PATH_PREFIX = "identities/";
export const PROJECT_CONTEXT_TRACKING_ROOT = ".copilot-tracking";
export const PROJECT_CONTEXT_UPDATE_MAX_CHARS = 64_000;

/** Broker callers must never read, enumerate, or mutate bridge-owned metadata. */
export function isProjectContextMetadata(project: string, path?: string): boolean {
  return project === PROJECT_CONTEXT_INDEX_PROJECT || path === PROJECT_CONTEXT_REGISTRY_PATH;
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export const PROJECT_INPUT_SCHEMA = {
  type: "string",
  pattern: PROJECT_NAME.source,
  description:
    "Legacy project partition or display slug. Schema v2 resolves the immutable projectId to its durable partition.",
} as const;

export const PROJECT_CONTEXT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "projectId", "revision", "sequence"],
  properties: {
    schemaVersion: { type: "integer", enum: [1, PROJECT_CONTEXT_SCHEMA_VERSION] },
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
  allOf: [{
    if: { properties: { schemaVersion: { const: 2 } } },
    then: {
      required: ["storage"],
      properties: {
        storage: { type: "object", required: ["provider", "driveId", "folderItemId"] },
      },
    },
  }],
} as const;

export interface ProjectContextStorage {
  provider: "onedrive" | "sharepoint";
  driveId?: string;
  folderItemId?: string;
  displayPath?: string;
}

export interface ProjectContextEnvelope {
  schemaVersion: 1 | 2;
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
  schemaVersion: 1 | 2;
  status: ProjectContextStatus;
  project: string;
  projectId: string;
  storage?: ProjectContextStorage;
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

interface ProjectIdentity {
  schemaVersion: 1;
  projectId: string;
  project: string;
  storage: ProjectContextStorage;
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
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.schemaVersion must be 1 or 2.",
    );
  }
  if (typeof record.projectId !== "string" || !PROJECT_ID.test(record.projectId)) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.projectId must be a UUID.",
    );
  }
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.revision must be a non-negative integer.",
    );
  }
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) < 0) {
    throw new ProjectContextError(
      "invalid_project_context",
      "projectContext.sequence must be a non-negative integer.",
    );
  }
  const digest = optionalString(record.digest);
  if (record.digest !== undefined && !digest) {
    throw new ProjectContextError("invalid_project_context", "projectContext.digest must be a SHA-256 hex digest.");
  }
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
  const storage = parseStorage(record.storage);
  if (record.schemaVersion === 2) {
    if (!storage?.driveId || !storage.folderItemId) {
      throw new ProjectContextError(
        "invalid_project_context",
        "Schema v2 requires storage.provider, storage.driveId, and storage.folderItemId.",
      );
    }
    const rawStorage = record.storage as Record<string, unknown>;
    if (
      rawStorage.driveId !== storage.driveId ||
      rawStorage.folderItemId !== storage.folderItemId ||
      (rawStorage.displayPath !== undefined && typeof rawStorage.displayPath !== "string")
    ) {
      throw new ProjectContextError("invalid_project_context", "Storage IDs must be nonempty strings without surrounding whitespace.");
    }
  }
  return {
    schemaVersion: record.schemaVersion,
    projectId: record.projectId.toLowerCase(),
    revision: Number(record.revision),
    sequence: Number(record.sequence),
    digest,
    trackingRoot: PROJECT_CONTEXT_TRACKING_ROOT,
    storage,
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

function sameBinding(
  left: ProjectContextStorage | undefined,
  right: ProjectContextStorage | undefined,
): boolean {
  return !!left?.driveId && !!left.folderItemId &&
    left.provider === right?.provider &&
    left.driveId === right.driveId && left.folderItemId === right.folderItemId;
}

function assertBinding(
  current: ProjectContextStorage | undefined,
  incoming: ProjectContextStorage | undefined,
): void {
  if (!sameBinding(current, incoming)) {
    throw new ProjectContextError(
      "project_storage_conflict",
      "This projectId is already registered to a different or incomplete M365 folder binding.",
    );
  }
}

function parseIdentity(entry: SquadMemoryEntry, projectId: string): ProjectIdentity {
  try {
    const value = JSON.parse(entry.content) as ProjectIdentity;
    if (
      value.schemaVersion !== 1 || value.projectId !== projectId ||
      typeof value.project !== "string" || !PROJECT_NAME.test(value.project)
    ) {
      throw new Error("Invalid identity metadata.");
    }
    const envelope = parseProjectContextEnvelope({
      schemaVersion: 2, projectId: value.projectId, revision: 0, sequence: 0,
      storage: value.storage,
    })!;
    return { ...value, storage: envelope.storage! };
  } catch {
    throw new ProjectContextError("project_context_conflict", "The server's project identity index is malformed.");
  }
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
  const acceptedAt = record.acceptedAt;
  if (!project || !PROJECT_NAME.test(project) ||
    typeof acceptedAt !== "number" || !Number.isFinite(acceptedAt)) {
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
    incoming.schemaVersion > current.schemaVersion ||
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
    schemaVersion: envelope.schemaVersion,
    status,
    project,
    projectId: envelope.projectId,
    storage: envelope.storage,
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

  /**
   * Resolve before dispatch so runs, memory, and artifacts all use the same key.
   * Identity creation uses the store's create-only (empty ETag) CAS contract.
   */
  async resolveProject(
    tenantId: string,
    project: string | undefined,
    envelope: ProjectContextEnvelope | undefined,
  ): Promise<string | undefined> {
    envelope = parseProjectContextEnvelope(envelope);
    if (project !== undefined && (typeof project !== "string" || !PROJECT_NAME.test(project))) {
      throw new ProjectContextError("invalid_project_context", "project must be a lower-kebab partition or display slug.");
    }
    if (!envelope || envelope.schemaVersion === 1) {
      if (envelope && !project) {
        throw new ProjectContextError("invalid_project_context", "Schema v1 requires both project and projectContext.");
      }
      if (envelope) {
        const existing = await this.store.read(
          tenantId, PROJECT_CONTEXT_INDEX_PROJECT, `${PROJECT_CONTEXT_INDEX_PATH_PREFIX}${envelope.projectId}`,
        );
        if (existing) {
          const identity = parseIdentity(existing, envelope.projectId);
          if (identity.project !== project) {
            throw new ProjectContextError("project_identity_conflict", "This projectId is bound to another durable partition.");
          }
          assertBinding(identity.storage, envelope.storage);
          await this.validateIdentityTarget(tenantId, identity, `project-${envelope.projectId}`);
        }
      }
      return project;
    }
    const canonical = `project-${envelope.projectId}`;
    const path = `${PROJECT_CONTEXT_INDEX_PATH_PREFIX}${envelope.projectId}`;
    const existing = await this.store.read(tenantId, PROJECT_CONTEXT_INDEX_PROJECT, path);
    if (existing) {
      const identity = parseIdentity(existing, envelope.projectId);
      assertBinding(identity.storage, envelope.storage);
      await this.validateIdentityTarget(tenantId, identity, canonical);
      return identity.project;
    }

    let resolved = canonical;
    if (project && project !== canonical) {
      const legacyEntry = await this.store.read(tenantId, project, PROJECT_CONTEXT_REGISTRY_PATH);
      if (legacyEntry) {
        const legacy = parseStored(legacyEntry);
        if (legacy.project !== project) {
          throw new ProjectContextError("project_context_conflict", "Stored project partition does not match its registry.");
        }
        if (legacy.projectId === envelope.projectId) {
          assertBinding(legacy.storage, envelope.storage);
          resolved = project;
        }
      }
    }
    const identity: ProjectIdentity = {
      schemaVersion: 1,
      projectId: envelope.projectId,
      project: resolved,
      storage: {
        provider: envelope.storage!.provider,
        driveId: envelope.storage!.driveId,
        folderItemId: envelope.storage!.folderItemId,
      },
    };
    await this.validateIdentityTarget(tenantId, identity, canonical);
    const result = await this.store.write(
      tenantId, PROJECT_CONTEXT_INDEX_PROJECT, path, JSON.stringify(identity), "",
    );
    if (!result.ok) {
      const winnerEntry = await this.store.read(tenantId, PROJECT_CONTEXT_INDEX_PROJECT, path);
      if (!winnerEntry) {
        throw new ProjectContextError("project_context_conflict", "Project identity registration failed; retry with a CAS-capable store.");
      }
      const winner = parseIdentity(winnerEntry, envelope.projectId);
      assertBinding(winner.storage, identity.storage);
      if (winner.project !== identity.project) {
        throw new ProjectContextError("project_context_conflict", "Project identity was concurrently registered to another partition.");
      }
      await this.validateIdentityTarget(tenantId, winner, canonical);
    }
    return resolved;
  }

  private async validateIdentityTarget(
    tenantId: string,
    identity: ProjectIdentity,
    canonical: string,
  ): Promise<void> {
    const entry = await this.store.read(tenantId, identity.project, PROJECT_CONTEXT_REGISTRY_PATH);
    if (!entry) {
      if (identity.project !== canonical) {
        throw new ProjectContextError("project_context_conflict", "The legacy project identity target is missing.");
      }
      return;
    }
    const current = parseStored(entry);
    if (current.projectId !== identity.projectId || current.project !== identity.project) {
      throw new ProjectContextError("project_identity_conflict", "The durable project partition is registered to another identity.");
    }
    assertBinding(current.storage, identity.storage);
  }

  async negotiate(
    tenantId: string,
    project: string | undefined,
    envelope: ProjectContextEnvelope | undefined,
  ): Promise<ProjectContextAcknowledgement | undefined> {
    envelope = parseProjectContextEnvelope(envelope);
    project = await this.resolveProject(tenantId, project, envelope);
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
    if (current && (current.projectId !== envelope.projectId || current.project !== project)) {
      throw new ProjectContextError(
        "project_identity_conflict",
        "This project name is already registered to a different projectId.",
      );
    }
    if (current?.schemaVersion === 2 || envelope.schemaVersion === 2 && current) {
      assertBinding(current?.storage, envelope.storage);
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
        schemaVersion: current?.schemaVersion === 2 ? 2 : envelope.schemaVersion,
        project,
        acceptedAt: this.now(),
      };
      const result = await this.store.write(
        tenantId,
        project,
        PROJECT_CONTEXT_REGISTRY_PATH,
        JSON.stringify(stored),
        currentEntry?.etag ?? "",
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
  if (envelope?.schemaVersion === 2) {
    throw new ProjectContextError(
      "project_context_conflict",
      "Schema v2 requires a durable project context store; stateless folder binding is not supported.",
    );
  }
  if (!project || !envelope) {
    return undefined;
  }
  return acknowledgement(project, envelope, "stateless");
}
