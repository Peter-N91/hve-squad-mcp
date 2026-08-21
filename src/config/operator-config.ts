/**
 * Operator configuration (server-controlled; never caller-influenced).
 *
 * Every value here is set by the OPERATOR who deploys the server (environment
 * variables sourced from the Container App config + Key Vault). None of it is
 * ever taken from a tool input or request body. This separation is load-bearing
 * for several council conditions:
 *
 *   * SEC-3 — the Azure OpenAI endpoint is operator-configured and validated
 *     against an allow-list, so a caller can never redirect inference to an
 *     attacker-controlled endpoint.
 *   * SEC-8 — the Origin allow-list is operator-configured (never `*`).
 *   * SEC-1 — the expected token audience (RFC 8707 resource indicator) is
 *     operator-configured.
 *   * SEC-9 / COST-1 / COST-2 — per-tenant concurrency and the hard monthly
 *     cost ceiling default here.
 *
 * Secrets (model API key, if used instead of managed identity) are NOT part of
 * this object; they are fetched on demand from Key Vault by the credential
 * provider and registered with the logger for redaction.
 */

/** The hard monthly cost ceiling per tenant (COST-2), default ~$500. */
export const DEFAULT_TENANT_MONTHLY_COST_CEILING_USD = 500;

/** Default per-tenant concurrency cap (SEC-9 / COST-1). */
export const DEFAULT_TENANT_CONCURRENCY = 4;

/** Default idle timeout (ms) after which a session id is forgotten (SEC-8). */
export const DEFAULT_SESSION_IDLE_MS = 5 * 60 * 1000;

/**
 * The memory persistence backends. `graph` persists each memory entry as a
 * markdown file in a SharePoint document library / OneDrive drive via Microsoft
 * Graph, so a team can keep squad state in the knowledge store they already
 * govern rather than in Azure Storage.
 */
export type MemoryBackendKind = "file" | "table" | "graph";

/**
 * One operator-declared memory destination a caller may select BY NAME. The
 * operator owns every credential-bearing field; the caller only ever sees `name`.
 */
export interface MemoryTargetConfig {
  /** The opaque, lower-kebab-case selector a caller passes as `target`. */
  name: string;
  /** Which backend realizes this destination. */
  backend: MemoryBackendKind;
  /** `file` — the directory backing this destination. */
  dir?: string;
  /** `table` — the storage account (falls back to the global `storageAccount`). */
  storageAccount?: string;
  /** `table` — the table name (falls back to the global `memoryTableName`). */
  tableName?: string;
  /** `graph` — the SharePoint/OneDrive drive id. */
  driveId?: string;
  /** `graph` — the folder within the drive that roots squad memory. */
  rootPath?: string;
  /** `graph` — override the Graph endpoint (sovereign clouds). */
  endpoint?: string;
  /** `graph` — encrypt content at rest for this destination (default false). */
  encrypt?: boolean;
}

export interface OperatorConfig {
  /**
   * Accepted token audiences — this resource server's identifiers (SEC-1,
   * RFC 8707). Usually one; several are permitted so a single deployment can
   * serve front doors that mint tokens for different resource identifiers (for
   * example a Copilot Studio connector on `api://<client-id>` alongside a Cowork
   * Entra SSO auth config on the Application ID URI that registration
   * generates). Every entry is matched exactly — never as a prefix or wildcard.
   */
  audiences: string[];
  /** Entra issuer allow-list (e.g. `https://login.microsoftonline.com/<tenant>/v2.0`). */
  allowedIssuers: string[];
  /** Tenants permitted to call (empty = any tenant whose token validates). */
  allowedTenants: string[];
  /** Strict Origin allow-list for the HTTP transport (SEC-8). Never `*`. */
  allowedOrigins: string[];
  /** Azure OpenAI endpoints the embedded backend may call (SEC-3 allow-list). */
  allowedModelEndpoints: string[];
  /** The Azure OpenAI endpoint to use (must be in {@link allowedModelEndpoints}). */
  modelEndpoint: string;
  /** The Azure OpenAI deployment name (operator-config; never caller input). */
  modelDeployment: string;
  /** The Azure OpenAI REST API version. */
  modelApiVersion: string;
  /** Per-tenant concurrency cap (SEC-9 / COST-1). */
  tenantConcurrency: number;
  /** Hard monthly per-tenant cost ceiling in USD (COST-2). */
  tenantMonthlyCostCeilingUsd: number;
  /** Idle timeout (ms) before a session id is forgotten (SEC-8). */
  sessionIdleMs: number;
  /**
   * Whether the gated async pipeline (`squad_run` + `squad_status`) is exposed over
   * the remote boundary. Default FALSE (hero-only, the council-gated posture): the
   * pipeline is exposed only when the operator has explicitly enabled it AND a
   * durable run-state directory is configured, so a held run's approval control is
   * backed by durable state rather than a fail-closed in-memory stub (HIGH-1).
   */
  remotePipelineEnabled: boolean;
  /**
   * Allow a run the server has proven ADVISORY-ONLY to proceed without an
   * out-of-band operator approval. Default FALSE.
   *
   * Without it the remote boundary cannot serve its main case: a Copilot Studio
   * agent has no way to reach `/admin/approve`, so a `product` run holds forever
   * waiting for a human who is not in that loop. The advisory pipeline runs no
   * code and takes no impactful action — it produces finished text into the
   * tracking tree — so the hold protects nothing there while blocking everything.
   *
   * A plan seeding any impactful role (`backlog-executor`, `deployer`,
   * `iac-author`, `azure-diagnose`) still holds, and the decision is made from the
   * server-resolved plan, never from caller input. Requires
   * `remotePipelineEnabled` — there is no pipeline to release otherwise.
   */
  advisoryAutopilotEnabled: boolean;
  /**
   * Directory backing the durable run-state store when the pipeline is enabled.
   * Required when `remotePipelineEnabled` is true AND the backend is `file`. NOTE:
   * a local directory is durable across restarts but NOT shared across replicas; a
   * multi-replica / scale-to-zero deployment needs the `table` backend (WI-06).
   */
  runStateDir: string;
  /**
   * WI-06 — run-state backend: `file` (single-replica, local dir) or `table`
   * (Azure Table Storage, cross-replica ETag CAS). `table` is required for a
   * multi-replica deployment; `file` is the single-replica default.
   */
  runStateBackend: "file" | "table";
  /** WI-06 — Azure Storage account name backing the `table` run-state store. */
  storageAccount: string;
  /** WI-06 — Azure Table name holding run records (default `squadruns`). */
  runTableName: string;
  /**
   * WI-06 — base64-encoded 32-byte data key for AES-256-GCM field encryption of
   * `request`/`context` at rest (MEDIUM-3). Sourced from Key Vault. Empty = no
   * application-level encryption (Azure platform-at-rest encryption still applies).
   */
  encryptionKeyBase64: string;
  /**
   * WI-1b4-WORKER — when true, a background ACA Job drives approved runs and the
   * status poll is READ-ONLY (a run may exceed the 240s HTTP ingress ceiling).
   * Requires `remotePipelineEnabled` and the `table` backend (the worker and the
   * web replicas must share cross-replica run state). Default false (poll drives).
   */
  workerEnabled: boolean;
  /**
   * Whether the deterministic `squad_render_pptx` file-output tool is exposed. Off
   * by default. When enabled, decks are rendered in-image with python-pptx and
   * uploaded to a tenant-scoped Blob container; the caller receives a short-lived
   * user-delegation SAS link. Requires `storageAccount` (the blob artifact store).
   */
  enableRenderPptx: boolean;
  /** Blob container that holds rendered decks (render feature). Default `renders`. */
  renderBlobContainer: string;
  /** Absolute path to the Python 3.11+ interpreter that runs `build_deck.py`. */
  renderPythonPath: string;
  /** Directory containing the `powerpoint` skill's `build_deck.py` + `pptx_*` helpers. */
  renderScriptsDir: string;
  /** Optional operator brand template (`--template`); empty = the skill default look. */
  renderBrandTemplatePath: string;
  /** SAS lifetime in minutes for a rendered-deck download link. Default 60. */
  renderSasTtlMinutes: number;
  /**
   * Whether the shared-state memory broker is exposed (the MCP resource read
   * surface + the `squad_memory_write` CAS tool). Off by default. When enabled,
   * the project's own `.copilot-tracking/squad/` memory + history is exposed as
   * scope-guarded (`Squad.Memory` / `Squad.MemoryWrite`), tenant-isolated MCP
   * resources keyed on the authenticated `tenantId`. Requires a backing store:
   * the `table` backend needs `storageAccount`; the `file` backend needs
   * `memoryDir` (fail-fast, mirroring the HIGH-1 run-state checks).
   */
  enableMemory: boolean;
  /**
   * Memory-broker backend: `file` (single-replica, local dir), `table` (Azure
   * Table Storage, cross-replica ETag CAS), or `graph` (a SharePoint document
   * library / OneDrive drive via Microsoft Graph, `If-Match` CAS). `table` or
   * `graph` is required for a multi-replica deployment; `file` is the
   * single-replica default. Independent from `runStateBackend` so memory and
   * run-state can use different stores.
   */
  memoryBackend: MemoryBackendKind;
  /** Azure Table name holding squad memory entries (default `squadmemory`). */
  memoryTableName: string;
  /** Directory backing the file memory store when `memoryBackend === "file"`. */
  memoryDir: string;
  /**
   * WI-03 — whether the Blob overflow channel is enabled. Off by default (the
   * memory store behaves identically to today). When on, memory `content` whose
   * ENCRYPTED envelope exceeds {@link memoryOverflowThresholdBytes} spills to a
   * tenant-scoped Blob while a tiny pointer entity stays in the primary store; the
   * blob payload is the same at-rest envelope (MEDIUM-3) and the pointer never
   * carries plaintext. Requires `enableMemory`, `storageAccount`, and
   * {@link memoryOverflowContainer} (fail-fast, mirroring the memory checks).
   */
  memoryOverflowEnabled: boolean;
  /** WI-03 — Blob container holding the overflow payloads. Required when enabled. */
  memoryOverflowContainer: string;
  /**
   * WI-03 — the encrypted-envelope byte length above which content spills to Blob.
   * Default 32 KiB (32768) — the Azure Table single-property string cap.
   */
  memoryOverflowThresholdBytes: number;
  /**
   * Whether squad memory is read and written AUTOMATICALLY around every embedded
   * dispatch, instead of only when a caller invokes a memory tool. Off by default.
   * When on, each run is preceded by a read of the resolved project's `state` +
   * `decisions` (injected as DATA, never authority) and followed by a
   * `history/<toolId>-<runId>` write plus a `state` digest append. Requires
   * {@link enableMemory} (there is no store to read/write otherwise).
   */
  memoryAutoEnabled: boolean;
  /**
   * The memory project partition used when a turn pins no federation sub-squad.
   * Server-controlled so continuity is reproducible: a caller can never choose
   * (or accidentally fork) the partition its memory lands in. Lower-kebab-case.
   */
  memoryDefaultProject: string;
  /**
   * Whether a run PERSISTS the squad ledger — `team.md`, `routing.md`,
   * `state.json`, the append-only logs, and each role's deliverable — as a
   * browsable `.copilot-tracking` tree, and exposes `squad_history` to read it
   * back. Off by default.
   *
   * It writes through whichever store {@link memoryBackend} already selected, so
   * an operator chooses the destination once: `file` for a single replica,
   * `table` for multi-replica, `graph` for a SharePoint library humans can open
   * directly. Requires {@link enableMemory} — there is no store otherwise.
   */
  enableArtifacts: boolean;
  /**
   * The SharePoint document library / OneDrive drive id backing the `graph`
   * memory backend. Required when `memoryBackend === "graph"`.
   */
  memoryGraphDriveId: string;
  /** Folder within the drive that roots squad memory (empty = the drive root). */
  memoryGraphRootPath: string;
  /** Override the Graph endpoint (sovereign clouds); empty = the public cloud. */
  memoryGraphEndpoint: string;
  /**
   * Whether `graph` memory content is field-encrypted at rest. Default FALSE: a
   * SharePoint target exists so humans can read the files, and encrypting them
   * defeats that. An operator who needs ciphertext in SharePoint opts in
   * explicitly (and must also configure {@link encryptionKeyBase64}).
   */
  memoryGraphEncrypt: boolean;
  /**
   * Operator-declared, caller-selectable memory destinations. Empty (the default)
   * means a single destination and the `target` input is ignored. Otherwise a
   * caller may select a destination BY NAME from this allow-list only — it can
   * never supply a raw drive id, account, or path (the SEC-3 pattern already used
   * for `allowedModelEndpoints`).
   */
  memoryTargets: MemoryTargetConfig[];
  /** The target used when a call names none. Must be one of {@link memoryTargets}. */
  memoryDefaultTarget: string;
  /**
   * Whether the business-facing tools (`squad_business_plan`, `squad_backlog`) are
   * exposed. Off by default. They are advisory: each runs one embedded dispatch
   * against a real cast persona and returns text / validated JSON. No impactful
   * action — the ADO/Jira WRITE still happens in the native certified connector on
   * the end user's own connection (ADR-0001 trust boundary).
   */
  enableBusinessTools: boolean;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parse the memory backend selector; anything unrecognized falls back to `file`. */
function parseMemoryBackend(value: string | undefined): MemoryBackendKind {
  const normalized = (value ?? "file").trim().toLowerCase();
  return normalized === "table" || normalized === "graph" ? normalized : "file";
}

/** Target-name shape: the opaque selector a caller may pass. */
const MEMORY_TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Parse `SQUAD_MCP_MEMORY_TARGETS` — a JSON array of operator-declared memory
 * destinations. Empty / unset means "one destination", and the `target` input is
 * ignored. Every entry is validated here so a malformed deployment fails at BOOT
 * rather than on the first caller-selected write.
 */
function parseMemoryTargets(value: string | undefined): MemoryTargetConfig[] {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SQUAD_MCP_MEMORY_TARGETS must be a JSON array of memory destinations.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SQUAD_MCP_MEMORY_TARGETS must be a JSON array of memory destinations.");
  }
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`SQUAD_MCP_MEMORY_TARGETS[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!MEMORY_TARGET_NAME.test(name)) {
      throw new Error(
        `SQUAD_MCP_MEMORY_TARGETS[${index}].name must be lower-kebab-case (it is the caller-facing selector).`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`SQUAD_MCP_MEMORY_TARGETS has a duplicate target name "${name}".`);
    }
    seen.add(name);
    const backend = parseMemoryBackend(
      typeof record.backend === "string" ? record.backend : undefined,
    );
    const target: MemoryTargetConfig = { name, backend };
    if (typeof record.dir === "string") target.dir = record.dir.trim();
    if (typeof record.storageAccount === "string") target.storageAccount = record.storageAccount.trim();
    if (typeof record.tableName === "string") target.tableName = record.tableName.trim();
    if (typeof record.driveId === "string") target.driveId = record.driveId.trim();
    if (typeof record.rootPath === "string") target.rootPath = record.rootPath.trim();
    if (typeof record.endpoint === "string") target.endpoint = record.endpoint.trim();
    target.encrypt = record.encrypt === true;

    // Per-backend prerequisites, checked at boot (mirrors the HIGH-1 pattern).
    if (backend === "file" && !target.dir) {
      throw new Error(`SQUAD_MCP_MEMORY_TARGETS["${name}"] (file) requires "dir".`);
    }
    if (backend === "graph" && !target.driveId) {
      throw new Error(`SQUAD_MCP_MEMORY_TARGETS["${name}"] (graph) requires "driveId".`);
    }
    return target;
  });
}

/**
 * Build the operator config from a (typically `process.env`) record. Throws when
 * a hard-required value is missing or self-inconsistent so a misconfigured
 * deployment fails fast at boot rather than at first call.
 */
export function loadOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  // SEC-1: comma-separated so one deployment can serve several front doors, each
  // minting tokens for its own resource identifier. Entries are trimmed and
  // de-duplicated, and blanks are dropped so a stray comma can never introduce an
  // empty audience (which a token with no `aud` would otherwise appear to match).
  const audiences = [
    ...new Set(
      (env.SQUAD_MCP_AUDIENCE ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
  if (audiences.length === 0) {
    throw new Error(
      "SQUAD_MCP_AUDIENCE is required (the resource-server token audience; SEC-1). " +
        "Provide one value, or several separated by commas.",
    );
  }

  const allowedOrigins = splitList(env.SQUAD_MCP_ALLOWED_ORIGINS);
  if (allowedOrigins.includes("*")) {
    throw new Error("SQUAD_MCP_ALLOWED_ORIGINS must not contain '*' (SEC-8: strict Origin allow-list).");
  }

  const allowedModelEndpoints = splitList(env.SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS);
  const modelEndpoint = (env.SQUAD_MCP_MODEL_ENDPOINT ?? "").trim();
  if (modelEndpoint.length > 0 && !allowedModelEndpoints.includes(modelEndpoint)) {
    throw new Error(
      "SQUAD_MCP_MODEL_ENDPOINT must be present in SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS (SEC-3: endpoint allow-list).",
    );
  }

  const remotePipelineEnabled = (env.SQUAD_MCP_REMOTE_PIPELINE_ENABLED ?? "").trim().toLowerCase() === "true";
  const runStateBackend = (env.SQUAD_MCP_RUN_STATE_BACKEND ?? "file").trim().toLowerCase() === "table" ? "table" : "file";
  const runStateDir = (env.SQUAD_MCP_RUN_STATE_DIR ?? "").trim();
  const storageAccount = (env.SQUAD_MCP_STORAGE_ACCOUNT ?? "").trim();
  const runTableName = (env.SQUAD_MCP_RUN_TABLE_NAME ?? "squadruns").trim();
  const workerEnabled = (env.SQUAD_MCP_WORKER_ENABLED ?? "").trim().toLowerCase() === "true";

  if (remotePipelineEnabled && runStateBackend === "file" && runStateDir.length === 0) {
    throw new Error(
      "SQUAD_MCP_RUN_STATE_DIR is required when SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true " +
        "with the file backend (the async pipeline's held-run approval control must be " +
        "backed by durable state; HIGH-1).",
    );
  }
  if (remotePipelineEnabled && runStateBackend === "table" && storageAccount.length === 0) {
    throw new Error(
      "SQUAD_MCP_STORAGE_ACCOUNT is required when SQUAD_MCP_RUN_STATE_BACKEND=table " +
        "(the cross-replica run-state + approval store; WI-06).",
    );
  }
  if (workerEnabled && !remotePipelineEnabled) {
    throw new Error("SQUAD_MCP_WORKER_ENABLED=true requires SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true.");
  }
  if (workerEnabled && runStateBackend !== "table") {
    throw new Error(
      "SQUAD_MCP_WORKER_ENABLED=true requires SQUAD_MCP_RUN_STATE_BACKEND=table " +
        "(the worker and web replicas must share cross-replica run state; WI-06 / WI-1b4-WORKER).",
    );
  }

  const enableRenderPptx = (env.SQUAD_MCP_ENABLE_RENDER_PPTX ?? "").trim().toLowerCase() === "true";
  const renderPythonPath = (env.SQUAD_MCP_RENDER_PYTHON_PATH ?? "").trim();
  const renderScriptsDir = (env.SQUAD_MCP_RENDER_SCRIPTS_DIR ?? "").trim();
  if (enableRenderPptx && storageAccount.length === 0) {
    throw new Error(
      "SQUAD_MCP_STORAGE_ACCOUNT is required when SQUAD_MCP_ENABLE_RENDER_PPTX=true " +
        "(the rendered deck is uploaded to a tenant-scoped Blob container).",
    );
  }
  if (enableRenderPptx && (renderPythonPath.length === 0 || renderScriptsDir.length === 0)) {
    throw new Error(
      "SQUAD_MCP_RENDER_PYTHON_PATH and SQUAD_MCP_RENDER_SCRIPTS_DIR are required when " +
        "SQUAD_MCP_ENABLE_RENDER_PPTX=true (the in-image python-pptx build step).",
    );
  }

  const enableMemory = (env.SQUAD_MCP_ENABLE_MEMORY ?? "").trim().toLowerCase() === "true";
  const memoryBackend = parseMemoryBackend(env.SQUAD_MCP_MEMORY_BACKEND);
  const memoryTableName = (env.SQUAD_MCP_MEMORY_TABLE_NAME ?? "squadmemory").trim();
  const memoryDir = (env.SQUAD_MCP_MEMORY_DIR ?? "").trim();
  const memoryGraphDriveId = (env.SQUAD_MCP_MEMORY_GRAPH_DRIVE_ID ?? "").trim();
  const memoryGraphRootPath = (env.SQUAD_MCP_MEMORY_GRAPH_ROOT_PATH ?? "").trim();
  const memoryGraphEndpoint = (env.SQUAD_MCP_MEMORY_GRAPH_ENDPOINT ?? "").trim();
  const memoryGraphEncrypt = (env.SQUAD_MCP_MEMORY_GRAPH_ENCRYPT ?? "").trim().toLowerCase() === "true";

  if (enableMemory && memoryBackend === "table" && storageAccount.length === 0) {
    throw new Error(
      "SQUAD_MCP_STORAGE_ACCOUNT is required when SQUAD_MCP_ENABLE_MEMORY=true " +
        "with the table backend (the cross-replica, tenant-isolated memory store).",
    );
  }
  if (enableMemory && memoryBackend === "file" && memoryDir.length === 0) {
    throw new Error(
      "SQUAD_MCP_MEMORY_DIR is required when SQUAD_MCP_ENABLE_MEMORY=true " +
        "with the file backend (the directory backing the local memory store).",
    );
  }
  if (enableMemory && memoryBackend === "graph" && memoryGraphDriveId.length === 0) {
    throw new Error(
      "SQUAD_MCP_MEMORY_GRAPH_DRIVE_ID is required when SQUAD_MCP_MEMORY_BACKEND=graph " +
        "(the SharePoint document library / OneDrive drive that holds squad memory).",
    );
  }

  const memoryTargets = parseMemoryTargets(env.SQUAD_MCP_MEMORY_TARGETS);
  const memoryDefaultTarget = (env.SQUAD_MCP_MEMORY_DEFAULT_TARGET ?? "").trim();
  if (memoryTargets.length > 0) {
    if (!enableMemory) {
      throw new Error(
        "SQUAD_MCP_MEMORY_TARGETS requires SQUAD_MCP_ENABLE_MEMORY=true " +
          "(named destinations decorate the shared-state memory store).",
      );
    }
    if (memoryDefaultTarget.length === 0) {
      throw new Error(
        "SQUAD_MCP_MEMORY_DEFAULT_TARGET is required when SQUAD_MCP_MEMORY_TARGETS is set " +
          "(a call that names no target must resolve deterministically).",
      );
    }
    if (!memoryTargets.some((target) => target.name === memoryDefaultTarget)) {
      throw new Error(
        "SQUAD_MCP_MEMORY_DEFAULT_TARGET must name one of SQUAD_MCP_MEMORY_TARGETS.",
      );
    }
  }

  const memoryAutoEnabled = (env.SQUAD_MCP_MEMORY_AUTO_ENABLED ?? "").trim().toLowerCase() === "true";
  if (memoryAutoEnabled && !enableMemory) {
    throw new Error(
      "SQUAD_MCP_MEMORY_AUTO_ENABLED=true requires SQUAD_MCP_ENABLE_MEMORY=true " +
        "(automatic continuity reads and writes through the shared-state memory store).",
    );
  }
  const memoryDefaultProject = (env.SQUAD_MCP_MEMORY_DEFAULT_PROJECT ?? "default").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(memoryDefaultProject)) {
    throw new Error(
      "SQUAD_MCP_MEMORY_DEFAULT_PROJECT must be lower-kebab-case (it is a store partition segment).",
    );
  }

  const enableArtifacts = (env.SQUAD_MCP_ENABLE_ARTIFACTS ?? "").trim().toLowerCase() === "true";
  if (enableArtifacts && !enableMemory) {
    throw new Error(
      "SQUAD_MCP_ENABLE_ARTIFACTS=true requires SQUAD_MCP_ENABLE_MEMORY=true " +
        "(the squad ledger is written through the configured memory store).",
    );
  }

  const advisoryAutopilotEnabled =
    (env.SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED ?? "").trim().toLowerCase() === "true";
  if (advisoryAutopilotEnabled && !remotePipelineEnabled) {
    throw new Error(
      "SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED=true requires SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true " +
        "(there is no gated pipeline to release otherwise).",
    );
  }

  const enableBusinessTools =
    (env.SQUAD_MCP_ENABLE_BUSINESS_TOOLS ?? "").trim().toLowerCase() === "true";
  if (enableBusinessTools && modelEndpoint.length === 0) {
    throw new Error(
      "SQUAD_MCP_MODEL_ENDPOINT is required when SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true " +
        "(the business tools run a server-side advisory dispatch).",
    );
  }

  const memoryOverflowEnabled =
    (env.SQUAD_MCP_MEMORY_OVERFLOW_ENABLED ?? "").trim().toLowerCase() === "true";
  const memoryOverflowContainer = (env.SQUAD_MCP_MEMORY_OVERFLOW_CONTAINER ?? "").trim();
  const memoryOverflowThresholdBytes = numberOr(env.SQUAD_MCP_MEMORY_OVERFLOW_THRESHOLD_BYTES, 32768);

  if (memoryOverflowEnabled && !enableMemory) {
    throw new Error(
      "SQUAD_MCP_MEMORY_OVERFLOW_ENABLED=true requires SQUAD_MCP_ENABLE_MEMORY=true " +
        "(the overflow channel decorates the shared-state memory store; WI-03).",
    );
  }
  if (memoryOverflowEnabled && storageAccount.length === 0) {
    throw new Error(
      "SQUAD_MCP_STORAGE_ACCOUNT is required when SQUAD_MCP_MEMORY_OVERFLOW_ENABLED=true " +
        "(the over-threshold memory payload is uploaded to a tenant-scoped Blob container; WI-03).",
    );
  }
  if (memoryOverflowEnabled && memoryOverflowContainer.length === 0) {
    throw new Error(
      "SQUAD_MCP_MEMORY_OVERFLOW_CONTAINER is required when SQUAD_MCP_MEMORY_OVERFLOW_ENABLED=true " +
        "(the Blob container holding the overflow payloads; WI-03).",
    );
  }

  return {
    audiences,
    allowedIssuers: splitList(env.SQUAD_MCP_ALLOWED_ISSUERS),
    allowedTenants: splitList(env.SQUAD_MCP_ALLOWED_TENANTS),
    allowedOrigins,
    allowedModelEndpoints,
    modelEndpoint,
    modelDeployment: (env.SQUAD_MCP_MODEL_DEPLOYMENT ?? "").trim(),
    modelApiVersion: (env.SQUAD_MCP_MODEL_API_VERSION ?? "2024-10-21").trim(),
    tenantConcurrency: numberOr(env.SQUAD_MCP_TENANT_CONCURRENCY, DEFAULT_TENANT_CONCURRENCY),
    tenantMonthlyCostCeilingUsd: numberOr(
      env.SQUAD_MCP_TENANT_COST_CEILING_USD,
      DEFAULT_TENANT_MONTHLY_COST_CEILING_USD,
    ),
    sessionIdleMs: numberOr(env.SQUAD_MCP_SESSION_IDLE_MS, DEFAULT_SESSION_IDLE_MS),
    remotePipelineEnabled,
    advisoryAutopilotEnabled,
    runStateDir,
    runStateBackend,
    storageAccount,
    runTableName,
    encryptionKeyBase64: (env.SQUAD_MCP_RUN_ENCRYPTION_KEY_B64 ?? "").trim(),
    workerEnabled,
    enableRenderPptx,
    renderBlobContainer: (env.SQUAD_MCP_RENDER_BLOB_CONTAINER ?? "renders").trim(),
    renderPythonPath,
    renderScriptsDir,
    renderBrandTemplatePath: (env.SQUAD_MCP_RENDER_BRAND_TEMPLATE_PATH ?? "").trim(),
    renderSasTtlMinutes: numberOr(env.SQUAD_MCP_RENDER_SAS_TTL_MINUTES, 60),
    enableMemory,
    memoryBackend,
    memoryTableName,
    memoryDir,
    memoryOverflowEnabled,
    memoryOverflowContainer,
    memoryOverflowThresholdBytes,
    memoryAutoEnabled,
    memoryDefaultProject,
    enableArtifacts,
    memoryGraphDriveId,
    memoryGraphRootPath,
    memoryGraphEndpoint,
    memoryGraphEncrypt,
    memoryTargets,
    memoryDefaultTarget,
    enableBusinessTools,
  };
}
