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

export interface OperatorConfig {
  /** Expected token audience — this resource server's identifier (SEC-1, RFC 8707). */
  audience: string;
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

/**
 * Build the operator config from a (typically `process.env`) record. Throws when
 * a hard-required value is missing or self-inconsistent so a misconfigured
 * deployment fails fast at boot rather than at first call.
 */
export function loadOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const audience = (env.SQUAD_MCP_AUDIENCE ?? "").trim();
  if (audience.length === 0) {
    throw new Error("SQUAD_MCP_AUDIENCE is required (the resource-server token audience; SEC-1).");
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

  return {
    audience,
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
  };
}
