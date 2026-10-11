import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve, parse } from "node:path";
import { TextDecoder } from "node:util";
import { assertSafeArtifactPath, type SquadArtifact, type SquadArtifactStore } from "../artifact-store.js";
import type { CopilotServerCommandResult } from "./copilot-stage-executor.js";
import type { UpstreamBundle } from "./upstream-bundle.js";
import { buildRunBillingLog, type RunBillingSnapshot } from "./run-billing-log.js";
import type { CompletionUsageRecord } from "../model-backend.js";

export const UPSTREAM_SCRIPT_PIN = "a8d863a9715f0738f69711421b1897269911f68f";
const MANIFEST_HASH = "3906ba730277a741510306e03ab8095039f83e076f2cba14f2eeb943c7c98d41";
const SQUAD_ROOT = ".copilot-tracking/squad";
const MAX_FILE_BYTES = 256_000;
const MAX_TREE_BYTES = 8_000_000;
const MAX_FILES = 1000;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type UpstreamScriptName =
  | "Initialize-SquadConsumptionRates"
  | "Resolve-SquadModelRoute"
  | "Get-SquadDispatchBrief"
  | "Measure-SquadLedger"
  | "Write-SquadHandoff"
  | "Set-SquadCostPreflight";

/** Constructed by trusted server code, never forwarded from model tool arguments. Exact paths only. */
export interface UpstreamAllowedWritePolicy {
  readonly writes: readonly { readonly path: string; readonly mode: "replace" | "append" }[];
}

export type UpstreamScriptRequest =
  | { script: "Initialize-SquadConsumptionRates"; args: { mode: "off" | "ranked" | "economy" | "manual" } }
  | { script: "Resolve-SquadModelRoute"; args: { availableModels: string[]; sessionModel?: string; mode?: "ranked" | "economy" | "manual"; roles?: string[]; asOf?: string } }
  | { script: "Get-SquadDispatchBrief"; args: { sessionModel?: string } }
  | { script: "Measure-SquadLedger"; args: { check?: boolean; write?: boolean; expectedHistoryCounts?: Record<string, number> } }
  | { script: "Write-SquadHandoff"; args: { payload: Record<string, unknown> } }
  | { script: "Set-SquadCostPreflight"; args: { expectedUpdated: string; preflight: Record<string, unknown>; decisionText?: string } };

export interface UpstreamScriptExecutionPort {
  runServerCommand(command: string): Promise<CopilotServerCommandResult>;
}

export interface UpstreamScriptBridgeOptions {
  store: SquadArtifactStore;
  tenantId: string;
  project: string;
  runId: string;
  bundle: UpstreamBundle;
  port: UpstreamScriptExecutionPort;
  /**
   * Explicit server-owned filename translation only, never schema conversion.
   * MemoryBackedArtifactStore forbids spaces, whereas upstream history filenames use
   * roster names (e.g. "Squad Scribe.md"). Bind safe store paths to those exact names.
   */
  historyAliases?: readonly { readonly artifactPath: string; readonly upstreamName: string }[];
  /** Trusted read-only run projection only; never a model-selected path or session log. */
  billingRecords?: readonly CompletionUsageRecord[];
}

export interface UpstreamMirrorFile {
  readonly path: string;
  readonly base64: string;
  readonly sha256: string;
  readonly updatedAt: number;
}

export interface UpstreamScriptResult {
  readonly script: UpstreamScriptName;
  readonly output: string;
  readonly changedPaths: readonly string[];
  /** These scripts estimate from upstream schema, not the application's native production usage logs. */
  readonly accounting: "upstream-schema-estimates-only";
  execution?: "pinned-script" | "native-scribe";
  readonly runBilling?: RunBillingSnapshot;
}

/** A commit can fail after earlier CAS writes succeeded: committedPaths is the recovery receipt. */
export interface UpstreamBridgeDiagnostic {
  readonly identifier: string;
  readonly line: number;
  readonly phase: string;
}

export class UpstreamScriptBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly committedPaths: readonly string[] = [],
    readonly uncertainPaths: readonly string[] = [],
    readonly diagnostic?: UpstreamBridgeDiagnostic,
  ) {
    super(message, diagnostic ? { cause: new Error(`PowerShell ${diagnostic.identifier}; line ${diagnostic.line}; phase ${diagnostic.phase}`) } : undefined);
    this.name = "UpstreamScriptBridgeError";
  }
}

const DIAGNOSTIC_IDS = ["PropertyNotFoundStrict", "VariableIsUndefined", "MethodNotFound",
  "MethodInvocationException", "ParameterArgumentValidationError", "ParameterBindingException",
  "ItemNotFound", "PathNotFound", "UnauthorizedAccess", "RuntimeException", "Unclassified"] as const;
const DIAGNOSTIC_PHASES = ["transport", "manifest", "inventory", "initialize", "snapshot", "run", "chunk", "cleanup", "unknown"] as const;
function safeDiagnostic(value: unknown): UpstreamBridgeDiagnostic | undefined {
  if (!object(value) || !object(value.diagnostic)) return undefined;
  const d = value.diagnostic;
  if (typeof d.identifier !== "string" || !(DIAGNOSTIC_IDS as readonly string[]).includes(d.identifier) ||
      typeof d.phase !== "string" || !(DIAGNOSTIC_PHASES as readonly string[]).includes(d.phase) ||
      typeof d.line !== "number" || !Number.isSafeInteger(d.line) || d.line < 0 || d.line > 10000) return undefined;
  return { identifier: d.identifier, line: d.line, phase: d.phase };
}
function diagnosticFromOutput(output: unknown): UpstreamBridgeDiagnostic | undefined {
  if (typeof output !== "string" || output.length > 4096) return undefined;
  try { return safeDiagnostic(JSON.parse(output)); } catch { return undefined; }
}

function fail(code: string, message: string): never { throw new UpstreamScriptBridgeError(code, message); }
function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function closed(value: unknown, allowed: readonly string[], required: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail("invalid_contract", "Unknown or missing structured fields.");
  }
}
function artifactPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !/^(?:\.copilot-tracking|docs|outputs)\/[^\\:*?"<>|\x00-\x1f]+$/.test(path) ||
      path.split("/").some(part => !part || part === "." || part === "..") ||
      !/\.(?:md|json|txt|csv|ya?ml|dot)$/i.test(path) ||
      /(?:^|\/)(?:\.env|credentials?|secrets?|tokens?|id_rsa)(?:[./_-]|$)/i.test(path)) {
    fail("unsafe_path", "Only canonical project text-artifact paths may cross the bridge.");
  }
}
function safeText(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_FILE_BYTES || decoder.decode(bytes) !== text || text.includes("\0")) {
    fail("unsafe_text", "Artifact is oversized, non-UTF-8, or contains NUL.");
  }
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})|(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|authorization)\s*[:=]\s*["']?(?!<|redacted\b|\*{3})[A-Za-z0-9+/._=-]{12,}/i.test(text)) {
    fail("secret_detected", "Secret-like content cannot cross the workspace bridge.");
  }
  return bytes;
}
function localRegular(path: string, verifiedDirectories: Set<string>): void {
  const full = resolve(path);
  const file = lstatSync(full);
  if (file.isSymbolicLink()) fail("bundle_integrity", "The verified upstream bundle must not contain symlinks.");
  if (!file.isFile()) fail("bundle_integrity", "Upstream resources must be regular files.");
  let current = resolve(full, "..");
  for (;;) {
    if (verifiedDirectories.has(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail("bundle_integrity", "The verified upstream bundle must not contain symlinks.");
    if (!stat.isDirectory()) fail("bundle_integrity", "Upstream resource parents must be directories.");
    verifiedDirectories.add(current);
    const parent = resolve(current, "..");
    if (current === parse(current).root || parent === current) break;
    current = parent;
  }
}

interface Envelope { ok: true; operation: string; files: unknown[]; scriptExitCode?: number; scriptOutput?: string }

/**
 * Separate server-owned staging tree. No store write occurs until all output and CAS baselines pass.
 * This is not a multi-file transaction: absent-file creation has no CAS primitive in SquadArtifactStore.
 * A successful create is read-back checked; a racing create cannot be made atomic with this interface.
 * Do not mount this private directory into model-accessible filesystem tools.
 */
export class UpstreamScriptBridge {
  readonly serverRunId = randomUUID();
  readonly workspacePath = `/workspace/.hve-upstream/${this.serverRunId}`;
  private readonly baseline = new Map<string, SquadArtifact>();
  private tree = new Map<string, UpstreamMirrorFile>();
  private readonly writes = new Map<string, "replace" | "append">();
  private readonly aliases = new Map<string, string>();
  private readonly reverseAliases = new Map<string, string>();
  private phase: "new" | "ready" | "committed" | "blocked" = "new";
  private busy = false;

  constructor(private readonly options: UpstreamScriptBridgeOptions) {
    if (!options.tenantId || !options.project || !options.runId || !options.port?.runServerCommand) {
      fail("invalid_contract", "Tenant, project, run, and command port are required.");
    }
    for (const alias of options.historyAliases ?? []) {
      closed(alias, ["artifactPath", "upstreamName"], ["artifactPath", "upstreamName"]);
      artifactPath(alias.artifactPath);
      assertSafeArtifactPath(alias.artifactPath);
      if (!/^\.copilot-tracking\/squad\/history\/[^/]+\.md$/.test(alias.artifactPath) ||
          typeof alias.upstreamName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,150}$/.test(alias.upstreamName) ||
          alias.upstreamName.includes("..") || alias.upstreamName.endsWith(".")) fail("invalid_alias", "History aliases require an exact safe store path and upstream roster name.");
      const target = `${SQUAD_ROOT}/history/${alias.upstreamName}.md`;
      if (this.aliases.has(alias.artifactPath) || this.reverseAliases.has(target)) fail("invalid_alias", "History aliases must be one-to-one.");
      this.aliases.set(alias.artifactPath, target);
      this.reverseAliases.set(target, alias.artifactPath);
    }
    if ([...this.aliases].some(([source, target]) => source !== target && this.aliases.has(target))) {
      fail("invalid_alias", "History aliases may not shadow one another.");
    }
    if (options.bundle.identity.sourceCommit !== UPSTREAM_SCRIPT_PIN) fail("bundle_integrity", "Only the pinned upstream bundle may execute.");
    const manifestPath = join(options.bundle.root, "manifest.json");
    const verifiedDirectories = new Set<string>();
    localRegular(manifestPath, verifiedDirectories);
    if (hash(readFileSync(manifestPath)) !== MANIFEST_HASH) fail("bundle_integrity", "Pinned upstream manifest mismatch.");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: { path: string; sha256: string; bytes: number }[]; manifestSha256: string;
    };
    const bundleFiles = [...manifest.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
      { path: "manifest.json", sha256: MANIFEST_HASH, bytes: readFileSync(manifestPath).length },
      { path: "apm.yml", sha256: manifest.manifestSha256, bytes: readFileSync(join(options.bundle.root, "apm.yml")).length }];
    for (const file of bundleFiles) {
      const full = join(options.bundle.root, ...file.path.split("/"));
      localRegular(full, verifiedDirectories);
      const bytes = readFileSync(full);
      if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) fail("bundle_integrity", "Upstream resource changed after verification.");
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) fail("bridge_busy", "Concurrent bridge operations are refused.");
    this.busy = true;
    try { return await action(); }
    catch (error) {
      this.phase = "blocked";
      if (error instanceof UpstreamScriptBridgeError) throw error;
      throw new UpstreamScriptBridgeError("bridge_failed", "Workspace bridge operation failed; no further operations are permitted.");
    } finally { this.busy = false; }
  }

  async initializeMirror(): Promise<{ workspacePath: string; files: readonly UpstreamMirrorFile[] }> {
    return this.exclusive(async () => {
      if (this.phase !== "new") fail("invalid_phase", "A mirror may be initialized only once.");
      const { store, tenantId, project } = this.options;
      const listing = await store.list(tenantId, project);
      const files: UpstreamMirrorFile[] = [];
      for (const entry of listing) {
        artifactPath(entry.path);
        assertSafeArtifactPath(entry.path);
        if (this.baseline.has(entry.path)) fail("invalid_contract", "Duplicate artifact listing.");
        const artifact = await store.get(tenantId, project, entry.path);
        if (!artifact || artifact.path !== entry.path || artifact.tenantId !== tenantId || artifact.project !== project ||
            !artifact.etag || artifact.updatedAt !== entry.updatedAt) fail("mirror_conflict", "Artifact listing changed during initialization.");
        const bytes = safeText(artifact.content);
        if (!Number.isSafeInteger(artifact.updatedAt) || artifact.updatedAt < 0) fail("invalid_contract", "Invalid artifact timestamp.");
        this.baseline.set(entry.path, { ...artifact });
        files.push({ path: this.mirrorPath(entry.path), base64: bytes.toString("base64"), sha256: hash(bytes), updatedAt: artifact.updatedAt });
      }
      this.validateTree(files);
      this.tree = this.validateTree((await this.command("initialize", { files })).files, true);
      this.assertSameTree(new Map(files.map(file => [file.path, file])), this.tree, true);
      this.phase = "ready";
      return { workspacePath: this.workspacePath, files: [...this.tree.values()] };
    });
  }

  async runScript(request: UpstreamScriptRequest, allowedWritePolicy?: UpstreamAllowedWritePolicy): Promise<UpstreamScriptResult> {
    return this.exclusive(async () => {
      this.ready();
      closed(request, ["script", "args"], ["script", "args"]);
      const policy = this.policy(request.script, allowedWritePolicy,
        request.script === "Measure-SquadLedger" && request.args.write === true);
      const args = this.arguments(request);
      const runBilling = this.options.billingRecords === undefined ? undefined :
        buildRunBillingLog(this.options.runId, this.options.billingRecords);
      if (runBilling && (request.script !== "Measure-SquadLedger" || request.args.check === true || request.args.write === true)) {
        fail("invalid_billing_scope", "SDK billing logs are only available to a read-only run-scoped measurement.");
      }
      const before = this.validateTree((await this.command("snapshot", {})).files, true);
      this.assertSameTree(this.tree, before, true);
      const response = await this.command("run", { script: request.script, args,
        ...(runBilling ? { billingLog: { base64: Buffer.from(runBilling.eventsJsonl).toString("base64"),
          sha256: hash(Buffer.from(runBilling.eventsJsonl)) } } : {}),
      });
      if (response.scriptExitCode !== 0 || typeof response.scriptOutput !== "string" || !response.scriptOutput.trim()) fail("script_failed", "Pinned script failed or omitted its explicit output/exit status.");
      safeText(response.scriptOutput);
      if (request.script === "Measure-SquadLedger" && request.args.check === true) {
        if (response.scriptOutput.trim() !== "Measure-SquadLedger -Check: PASS") {
          fail("invalid_response", "Pinned ledger check did not return its exact successful check receipt.");
        }
      } else if (request.script === "Measure-SquadLedger" && request.args.write === true) {
        if (!response.scriptOutput.startsWith("Measure-SquadLedger -Write: rewrote ")) {
          fail("invalid_response", "Pinned ledger writer did not return its exact successful receipt.");
        }
      } else if (request.script === "Resolve-SquadModelRoute" || request.script === "Measure-SquadLedger") {
        let structured: unknown;
        try { structured = JSON.parse(response.scriptOutput); } catch { fail("invalid_response", "Pinned JSON-mode script returned non-JSON output."); }
        if (!object(structured) && !Array.isArray(structured)) fail("invalid_response", "Pinned JSON-mode script returned no structured result.");
      }
      const after = this.validateTree(response.files, true);
      const changed = this.diff(before, after, policy);
      if (request.script === "Write-SquadHandoff" || request.script === "Set-SquadCostPreflight" ||
          request.script === "Measure-SquadLedger" && request.args.write === true) this.requireUpstreamAccounting(after);
      this.tree = after;
      for (const path of changed) this.writes.set(path, policy.get(path)!);
      return { script: request.script, execution: "pinned-script", output: response.scriptOutput, changedPaths: changed.map(path => this.storePath(path)), accounting: "upstream-schema-estimates-only",
        ...(runBilling ? { runBilling } : {}) };
    });
  }

  async commitAllowedChanges(): Promise<{ committedPaths: readonly string[]; atomic: false }> {
    return this.exclusive(async () => {
      this.ready();
      const finalTree = this.validateTree((await this.command("snapshot", {})).files, true);
      this.assertSameTree(this.tree, finalTree, true);
      const original = new Map([...this.baseline].map(([path, artifact]) => {
        const bytes = safeText(artifact.content);
        const mirrored = this.mirrorPath(path);
        return [mirrored, { path: mirrored, base64: bytes.toString("base64"), sha256: hash(bytes), updatedAt: artifact.updatedAt }];
      }));
      const changed = this.diff(original, finalTree, this.writes).sort();
      const { store, tenantId, project } = this.options;
      const currentListing = await store.list(tenantId, project);
      if (currentListing.length !== this.baseline.size || currentListing.some(entry => !this.baseline.has(entry.path))) {
        fail("commit_conflict", "Project membership changed; no staged writes were committed.");
      }
      // Preflight the entire mirrored tree, not just files that scripts touched.
      for (const [path, old] of this.baseline) {
        const current = await store.get(tenantId, project, path);
        if (!current || current.etag !== old.etag || current.content !== old.content || current.updatedAt !== old.updatedAt) {
          fail("commit_conflict", "Project baseline changed; no staged writes were committed.");
        }
      }
      for (const path of changed) {
        const target = this.storePath(path);
        if (!this.baseline.has(target) && await store.get(tenantId, project, target)) fail("commit_conflict", "A staged new path now exists; no writes were committed.");
      }
      const committed: string[] = [];
      for (const path of changed) {
        const target = this.storePath(path);
        const old = this.baseline.get(target);
        const content = decoder.decode(Buffer.from(finalTree.get(path)!.base64, "base64"));
        // Check new paths again immediately before the unavoidably non-atomic create.
        if (!old) {
          let exists;
          try { exists = await store.get(tenantId, project, target); }
          catch { throw new UpstreamScriptBridgeError("commit_failed", "New path pre-create check failed; earlier writes remain committed.", committed); }
          if (exists) throw new UpstreamScriptBridgeError("commit_conflict", "New path creation raced; earlier writes may have committed.", committed);
        }
        let result: unknown;
        try { result = await store.put(tenantId, project, target, content, old?.etag); }
        catch {
          throw new UpstreamScriptBridgeError("commit_failed", "Store write failed; inspect uncertainPaths before retrying.", committed, [target]);
        }
        if (object(result) && result.ok === false && result.conflict === true) {
          throw new UpstreamScriptBridgeError("commit_conflict", "CAS conflict; earlier writes remain committed.", committed);
        }
        if (!object(result) || result.ok !== true || !object(result.artifact) || result.artifact.content !== content ||
            typeof result.artifact.etag !== "string" || !result.artifact.etag || result.artifact.path !== target ||
            result.artifact.tenantId !== tenantId || result.artifact.project !== project) {
          throw new UpstreamScriptBridgeError("commit_failed", "Store returned an invalid or altered write receipt.", committed, [target]);
        }
        committed.push(target);
        let saved;
        try { saved = await store.get(tenantId, project, target); }
        catch { throw new UpstreamScriptBridgeError("commit_failed", "Committed write could not be verified.", committed, [target]); }
        if (!saved || saved.content !== content || saved.etag !== result.artifact.etag) {
          throw new UpstreamScriptBridgeError("commit_conflict", "Committed write raced during verification.", committed, [target]);
        }
      }
      this.phase = "committed";
      return { committedPaths: committed, atomic: false };
    });
  }

  private ready(): void {
    if (this.phase !== "ready") fail("invalid_phase", "Bridge is not initialized, is blocked, or has already committed.");
  }

  private mirrorPath(path: string): string { return this.aliases.get(path) ?? path; }
  private storePath(path: string): string {
    const target = this.reverseAliases.get(path) ?? path;
    try { assertSafeArtifactPath(target); }
    catch { fail("unsupported_store_path", "Upstream roster filenames require explicit safe historyAliases for this artifact store."); }
    return target;
  }

  private policy(script: string, policy?: UpstreamAllowedWritePolicy, ledgerWrite = false): Map<string, "replace" | "append"> {
    const result = new Map<string, "replace" | "append">();
    if (script === "Measure-SquadLedger" && ledgerWrite) {
      if (!policy) fail("policy_required", "Ledger writes require exact state and consumption replacement policy.");
      closed(policy, ["writes"], ["writes"]);
      if (!Array.isArray(policy.writes) || policy.writes.length !== 2) {
        fail("invalid_policy", "Ledger writes require exactly two declared replacements.");
      }
      for (const entry of policy.writes) {
        closed(entry, ["path", "mode"], ["path", "mode"]);
        artifactPath(entry.path);
        if (entry.mode !== "replace" || ![`${SQUAD_ROOT}/state.json`, `${SQUAD_ROOT}/consumption.md`].includes(entry.path) ||
            result.has(entry.path)) fail("invalid_policy", "Ledger write policy cannot expand beyond derived totals.");
        result.set(entry.path, "replace");
      }
      return result;
    }
    if (script === "Initialize-SquadConsumptionRates") {
      if (policy) fail("invalid_policy", "Rate seeding has a fixed server-owned write path.");
      result.set(`${SQUAD_ROOT}/consumption-rates.md`, "replace");
      return result;
    }
    if (script === "Resolve-SquadModelRoute" || script === "Get-SquadDispatchBrief" || script === "Measure-SquadLedger") {
      if (policy) fail("invalid_policy", "Read-only scripts cannot receive write policies.");
      return result;
    }
    if (script !== "Write-SquadHandoff" && script !== "Set-SquadCostPreflight") fail("script_not_allowed", "Script is not allowlisted.");
    if (!policy) fail("policy_required", "Mutating scripts require a trusted caller-provided exact write policy.");
    closed(policy, ["writes"], ["writes"]);
    if (!Array.isArray(policy.writes) || !policy.writes.length) fail("invalid_policy", "Write policy must explicitly name eligible paths.");
    for (const write of policy.writes) {
      closed(write, ["path", "mode"], ["path", "mode"]);
      artifactPath(write.path);
      assertSafeArtifactPath(write.path);
      const append = write.path === `${SQUAD_ROOT}/decisions.md` ||
        (script === "Write-SquadHandoff" && /^\.copilot-tracking\/squad\/history\/[^/]+\.md$/.test(write.path));
      const replace = write.path === `${SQUAD_ROOT}/state.json` || (script === "Write-SquadHandoff" &&
        [`${SQUAD_ROOT}/consumption.md`, `${SQUAD_ROOT}/consumption-rates.md`].includes(write.path));
      if ((!append && !replace) || write.mode !== (append ? "append" : "replace") || result.has(this.mirrorPath(write.path))) {
        fail("invalid_policy", "Write policy expands beyond the pinned script's output contract.");
      }
      result.set(this.mirrorPath(write.path), append ? "append" : "replace");
    }
    return result;
  }

  private arguments(request: UpstreamScriptRequest): Record<string, unknown> {
    const a: unknown = request.args;
    switch (request.script) {
      case "Initialize-SquadConsumptionRates":
        closed(a, ["mode"], ["mode"]);
        if (!["off", "ranked", "economy", "manual"].includes(String(a.mode))) fail("invalid_args", "Invalid routing mode.");
        return { Mode: a.mode };
      case "Resolve-SquadModelRoute":
        closed(a, ["availableModels", "sessionModel", "mode", "roles", "asOf"], ["availableModels"]);
        this.strings(a.availableModels);
        if (a.roles !== undefined) this.strings(a.roles);
        if (a.sessionModel !== undefined) this.string(a.sessionModel);
        if (a.mode !== undefined && !["ranked", "economy", "manual"].includes(String(a.mode))) fail("invalid_args", "Invalid routing mode.");
        if (a.asOf !== undefined && (typeof a.asOf !== "string" || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(a.asOf) || !Number.isFinite(Date.parse(a.asOf)))) fail("invalid_args", "AsOf must be an ISO UTC timestamp.");
        return Object.fromEntries(Object.entries({ AvailableModels: a.availableModels, SessionModel: a.sessionModel, Mode: a.mode, Role: a.roles, AsOf: a.asOf, Format: "json" }).filter(([, value]) => value !== undefined));
      case "Get-SquadDispatchBrief":
        closed(a, ["sessionModel"], []);
        if (a.sessionModel !== undefined) this.string(a.sessionModel);
        return a.sessionModel === undefined ? {} : { SessionModel: a.sessionModel };
      case "Measure-SquadLedger":
        closed(a, ["check", "write", "expectedHistoryCounts"], []);
        if (a.check !== undefined && typeof a.check !== "boolean") fail("invalid_args", "Check must be boolean.");
        if (a.write !== undefined && typeof a.write !== "boolean") fail("invalid_args", "Write must be boolean.");
        if (a.check === true && a.write === true) fail("invalid_args", "Ledger writing and checking must be separate operations.");
        if (a.expectedHistoryCounts !== undefined && (!object(a.expectedHistoryCounts) ||
            !Object.keys(a.expectedHistoryCounts).length || Object.keys(a.expectedHistoryCounts).length > 100 ||
            Object.entries(a.expectedHistoryCounts).some(([agent, count]) =>
              !/^[A-Za-z][A-Za-z0-9 ._-]{0,150}$/.test(agent) || agent.includes("..") ||
              !Number.isSafeInteger(count) || Number(count) < 0))) {
          fail("invalid_args", "Expected history counts must be an exact bounded trusted agent/count map.");
        }
        this.requireUpstreamAccounting();
        return { Format: "json", ...(a.check === true ? { Check: true } : {}), ...(a.write === true ? { Write: true } : {}),
          ...(a.expectedHistoryCounts !== undefined ? { ExpectedHistoryCounts: a.expectedHistoryCounts } : {}) };
      case "Write-SquadHandoff": {
        closed(a, ["payload"], ["payload"]);
        if (!object(a.payload) || a.payload.runId !== this.options.runId || !Array.isArray(a.payload.historyRecords)) {
          fail("invalid_args", "Handoff requires this run's ID and genuine upstream historyRecords.");
        }
        this.requireUpstreamAccounting();
        for (const record of a.payload.historyRecords) {
          if (!object(record)) fail("invalid_args", "History record must be an object.");
          this.string(record.agent);
          if (/[\\/:]|\.\./.test(record.agent)) fail("unsafe_path", "Agent cannot select a filesystem path.");
          artifactPath(record.deliverable);
          if (!this.tree.has(record.deliverable)) fail("invalid_args", "Deliverable must be an existing mirrored artifact.");
        }
        safeText(JSON.stringify(a.payload));
        return { PayloadJson: JSON.stringify(a.payload), SessionLog: "", LockTimeoutSeconds: 30 };
      }
      case "Set-SquadCostPreflight":
        closed(a, ["expectedUpdated", "preflight", "decisionText"], ["expectedUpdated", "preflight"]);
        if (typeof a.expectedUpdated !== "string" || !object(a.preflight)) fail("invalid_args", "Preflight requires structured JSON and exact expected update.");
        if (a.preflight.decision === "not-requested" ? a.decisionText !== undefined :
            typeof a.decisionText !== "string" || !a.decisionText.trim()) {
          fail("invalid_args", "A not-requested preflight must omit decision text; other decisions require an explicit entry.");
        }
        this.requireUpstreamAccounting();
        safeText(JSON.stringify(a));
        return { ExpectedUpdated: a.expectedUpdated, PreflightJson: JSON.stringify(a.preflight),
          ...(a.decisionText !== undefined ? { DecisionText: a.decisionText } : {}) };
    }
  }

  private string(value: unknown): asserts value is string {
    if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) fail("invalid_args", "Expected a bounded scalar string.");
    safeText(value);
  }
  private strings(value: unknown): void {
    if (!Array.isArray(value) || value.length > 100) fail("invalid_args", "Expected a bounded string array.");
    for (const entry of value) this.string(entry);
  }

  private requireUpstreamAccounting(tree = this.tree): void {
    const state = tree.get(`${SQUAD_ROOT}/state.json`);
    let parsed: unknown;
    try { parsed = state && JSON.parse(decoder.decode(Buffer.from(state.base64, "base64"))); }
    catch { fail("incompatible_schema", "Upstream state is not valid JSON."); }
    if (!object(parsed) || parsed.schemaVersion !== "1.4" || !object(parsed.currentRun) ||
        !Array.isArray(parsed.activeRoles) || !Array.isArray(parsed.openEscalations) ||
        !Number.isInteger(parsed.turn) || typeof parsed.updated !== "string") {
      fail("incompatible_schema", "Native project logs are not upstream schema 1.4; accounting is refused.");
    }
    for (const [path, file] of tree) {
      if (!path.startsWith(`${SQUAD_ROOT}/history/`)) continue;
      const text = decoder.decode(Buffer.from(file.base64, "base64"));
      const name = path.slice(`${SQUAD_ROOT}/history/`.length, -3);
      const header = `# History: ${name}`;
      let body = text.replace(/^\uFEFF/, "");
      // The pinned Get-HistoryHeader emits this closed, three-line frontmatter.
      // Do not treat arbitrary YAML/native metadata as evidence of upstream compatibility.
      if (body.startsWith("---")) {
        const frontmatter = /^---\r?\ndescription: "Append-only dispatch history for a single squad agent"\r?\n---\r?\n\r?\n/.exec(body.slice(0, 512));
        if (!frontmatter) fail("incompatible_schema", "History frontmatter is not the pinned upstream header.");
        body = body.slice(frontmatter[0].length);
      }
      if (text.trim() && !body.startsWith(header + "\n") &&
          !body.startsWith(header + "\r\n") && body.trim() !== header) {
        fail("incompatible_schema", "History does not carry the upstream roster-name header.");
      }
      const entries = body.split(/^### /m).slice(1);
      if (text.trim() && !entries.length && body.trim() !== header) fail("incompatible_schema", "History lacks upstream dispatch-entry headings.");
      for (const entry of entries) {
        const match = /^#### Consumption(?: — Orchestration)?\r?\n\s*```json\r?\n([\s\S]*?)\r?\n```/m.exec(entry);
        let usage: unknown;
        try { usage = match && JSON.parse(match[1]); } catch { fail("incompatible_schema", "Malformed upstream consumption block."); }
        if (!object(usage) || ["model", "model_source", "model_tier", "basis"].some(key => typeof usage[key] !== "string") ||
            ["internal_turns", "input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens"].some(key =>
              typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0)) {
          fail("incompatible_schema", "History is not upstream consumption schema; no production FinOps inference is permitted.");
        }
      }
    }
  }

  private validateTree(files: unknown[], requireKind = false): Map<string, UpstreamMirrorFile> {
    if (!Array.isArray(files) || files.length > MAX_FILES) fail("unsafe_tree", "Missing or oversized mirror listing.");
    const tree = new Map<string, UpstreamMirrorFile>();
    let total = 0;
    for (const entry of files) {
      closed(entry, ["path", "base64", "sha256", "updatedAt", "kind"], ["path", "base64", "sha256", "updatedAt"]);
      artifactPath(entry.path);
      if ((requireKind || entry.kind !== undefined) && entry.kind !== "file") fail("unsafe_tree", "Missing file type, symlinks, and special files are forbidden.");
      if (tree.has(entry.path) || typeof entry.base64 !== "string" || entry.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
          typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          typeof entry.updatedAt !== "number" || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0) fail("unsafe_tree", "Invalid mirror file metadata.");
      const bytes = Buffer.from(entry.base64, "base64");
      if (bytes.toString("base64") !== entry.base64 || hash(bytes) !== entry.sha256) fail("unsafe_tree", "Mirror encoding or hash mismatch.");
      let text: string;
      try { text = decoder.decode(bytes); } catch { fail("unsafe_text", "Non-UTF-8 mirror output."); }
      safeText(text);
      total += bytes.length;
      if (total > MAX_TREE_BYTES) fail("unsafe_tree", "Mirrored project exceeds total byte budget.");
      tree.set(entry.path, { path: entry.path, base64: entry.base64, sha256: entry.sha256, updatedAt: entry.updatedAt });
    }
    return tree;
  }

  private assertSameTree(a: Map<string, UpstreamMirrorFile>, b: Map<string, UpstreamMirrorFile>, timestamps: boolean): void {
    if (a.size !== b.size || [...a].some(([path, file]) => file.base64 !== b.get(path)?.base64 ||
        (timestamps && file.updatedAt !== b.get(path)?.updatedAt))) fail("mirror_changed", "Private mirror changed outside a validated script invocation.");
  }

  private diff(before: Map<string, UpstreamMirrorFile>, after: Map<string, UpstreamMirrorFile>, policy: Map<string, "replace" | "append">): string[] {
    for (const path of before.keys()) if (!after.has(path)) fail("unsafe_diff", "Upstream script deleted a mirrored input.");
    const changed: string[] = [];
    for (const [path, file] of after) {
      const old = before.get(path);
      if (old?.base64 === file.base64 && old.updatedAt === file.updatedAt) continue;
      if (!policy.has(path)) fail("unsafe_diff", "Upstream output is outside the caller's exact allowed-write policy.");
      if (policy.get(path) === "append" && old && !Buffer.from(file.base64, "base64").subarray(0, Buffer.from(old.base64, "base64").length).equals(Buffer.from(old.base64, "base64"))) {
        fail("append_only", "Upstream output rewrote an append-only history or decision prefix.");
      }
      changed.push(path);
    }
    return changed;
  }

  private async command(operation: "initialize" | "snapshot" | "run", extra: Record<string, unknown>): Promise<Envelope> {
    const payload = Buffer.from(JSON.stringify({
      operation, workspace: this.workspacePath, ...extra,
    }), "utf8");
    const dataPath = `/workspace/.hve-upstream/.transport-${randomUUID()}.json`;
    let primaryFailure: unknown;
    try {
      // 12KiB bytes become <=16KiB base64; even UTF-16 EncodedCommand stays below
      // Linux's per-argument limit. Neither the inventory nor large script args go in argv.
      for (let offset = 0; offset < payload.length; offset += 12288) {
        const chunk = payload.subarray(offset, offset + 12288).toString("base64");
        const source = CHUNK_PROGRAM.replaceAll("__DATA_PATH__", dataPath)
          .replaceAll("__OFFSET__", String(offset)).replace("__CHUNK__", chunk);
        let receipt: unknown;
        try { receipt = JSON.parse(await this.execute(source)); }
        catch (error) { throw new UpstreamScriptBridgeError("transport_uncertain", "Chunk execution or acknowledgement failed; private transport state is uncertain.", [], [dataPath], error instanceof UpstreamScriptBridgeError ? error.diagnostic : undefined); }
        if (!object(receipt) || receipt.ok !== true || receipt.operation !== "chunk" ||
            receipt.bytes !== Math.min(offset + 12288, payload.length)) {
          throw new UpstreamScriptBridgeError("transport_uncertain", "Chunk acknowledgement did not match its exact byte offset.", [], [dataPath], safeDiagnostic(receipt));
        }
      }
      let result: string;
      try {
        result = await this.execute(SERVER_PROGRAM.replaceAll("__DATA_PATH__", dataPath)
          .replace("__DATA_HASH__", hash(payload)).replace("__DATA_BYTES__", String(payload.length))
          .replace("__MANIFEST_HASH__", MANIFEST_HASH));
      } catch (error) {
        throw new UpstreamScriptBridgeError("transport_uncertain", "Server execution failed; mirror execution state is uncertain.", [], [this.workspacePath, dataPath], error instanceof UpstreamScriptBridgeError ? error.diagnostic : undefined);
      }
      let envelope: unknown;
      try { envelope = JSON.parse(result); } catch { fail("invalid_response", "Server command did not emit a machine JSON envelope."); }
      if (object(envelope) && envelope.operation === "response") {
        closed(envelope, ["ok", "operation", "bytes", "sha256"], ["ok", "operation", "bytes", "sha256"]);
        if (envelope.ok !== true || !Number.isSafeInteger(envelope.bytes) ||
            Number(envelope.bytes) < 1 || Number(envelope.bytes) > 12_000_000 ||
            typeof envelope.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(envelope.sha256)) fail("invalid_response", "Invalid bounded response transport receipt.");
        const chunks: Buffer[] = [];
        for (let offset = 0; offset < Number(envelope.bytes); offset += 12288) {
          const part: unknown = JSON.parse(await this.execute(RESPONSE_PROGRAM.replaceAll("__DATA_PATH__", dataPath)
            .replaceAll("__OFFSET__", String(offset)).replaceAll("__COUNT__", String(Math.min(12288, Number(envelope.bytes) - offset)))));
          closed(part, ["ok", "operation", "offset", "base64"], ["ok", "operation", "offset", "base64"]);
          if (part.ok !== true || part.operation !== "response-chunk" || part.offset !== offset ||
              typeof part.base64 !== "string" || part.base64.length > 16384) fail("invalid_response", "Invalid response chunk acknowledgement.");
          const bytes = Buffer.from(part.base64, "base64");
          if (bytes.toString("base64") !== part.base64 || bytes.length !== Math.min(12288, Number(envelope.bytes) - offset)) fail("invalid_response", "Response chunk encoding or length mismatch.");
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== envelope.bytes || hash(bytes) !== envelope.sha256) fail("invalid_response", "Response transport integrity mismatch.");
        try { envelope = JSON.parse(decoder.decode(bytes)); } catch { fail("invalid_response", "Response transport did not contain valid UTF-8 JSON."); }
      }
      if (object(envelope) && envelope.ok === false) throw new UpstreamScriptBridgeError("server_rejected", "Server bridge rejected the operation.", [], [], safeDiagnostic(envelope));
      closed(envelope, ["ok", "operation", "files", "scriptExitCode", "scriptOutput"], ["ok", "operation", "files"]);
      if (envelope.ok !== true || envelope.operation !== operation || !Array.isArray(envelope.files)) fail("invalid_response", "Server bridge reported failure or an incomplete response.");
      return envelope as unknown as Envelope;
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
        const receipt: unknown = JSON.parse(await this.execute(CLEANUP_PROGRAM.replaceAll("__DATA_PATH__", dataPath)));
        if (!object(receipt) || receipt.ok !== true || receipt.operation !== "cleanup") {
          throw new UpstreamScriptBridgeError("cleanup_failed", "Missing cleanup acknowledgement.", [], [], safeDiagnostic(receipt));
        }
      } catch (cleanupError) {
        const prior = primaryFailure instanceof UpstreamScriptBridgeError ? primaryFailure : undefined;
        throw new UpstreamScriptBridgeError("transport_uncertain",
          `Private transport cleanup could not be verified${prior ? ` after ${prior.code}` : ""}; do not retry automatically.`,
          prior?.committedPaths ?? [], [...new Set([...(prior?.uncertainPaths ?? []), dataPath])],
          prior?.diagnostic ?? (cleanupError instanceof UpstreamScriptBridgeError ? cleanupError.diagnostic : undefined));
      }
    }
  }

  private async execute(script: string): Promise<string> {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    // No command, path, environment value, or script source comes from the model.
    const command = `/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent /usr/bin/pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
    if (Buffer.byteLength(command) >= 65536) fail("transport_limit", "Server command exceeds the bounded Linux transport limit.");
    let result;
    try { result = await this.options.port.runServerCommand(command); }
    catch (error) {
      // execFile-style ports can throw with stdout/stderr. Never retain the raw error,
      // command, stderr, exception message or payload as a cause.
      const diagnostic = object(error) ? diagnosticFromOutput(error.stdout) : undefined;
      throw new UpstreamScriptBridgeError("transport_failed", "Server command port threw; raw output withheld.", [], [], diagnostic);
    }
    if (result.success !== true || result.exitCode !== 0 || typeof result.output !== "string" || result.output.length > 12_000_000) {
      throw new UpstreamScriptBridgeError("transport_failed", "Server command did not explicitly succeed.", [], [], diagnosticFromOutput(result.output));
    }
    return result.output;
  }
}

const DIAGNOSTIC_PROGRAM = String.raw`
$phase = 'unknown'
function SafeDiagnostic($record) {
  $id = ([string]$record.FullyQualifiedErrorId).Split(',')[0]
  if ($id -notin @('PropertyNotFoundStrict','VariableIsUndefined','MethodNotFound','MethodInvocationException','ParameterArgumentValidationError','ParameterBindingException','ItemNotFound','PathNotFound','UnauthorizedAccess','RuntimeException')) {
    $id = if ($record.Exception -is [System.Management.Automation.RuntimeException]) { 'RuntimeException' } else { 'Unclassified' }
  }
  $line = [int]$record.InvocationInfo.ScriptLineNumber
  if ($line -lt 0 -or $line -gt 10000) { $line = 0 }
  return @{identifier=$id; line=$line; phase=$phase}
}
`;
const TRANSPORT_GUARD = DIAGNOSTIC_PROGRAM + String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$path = '__DATA_PATH__'
if ($path -notmatch '^/workspace/\.hve-upstream/\.transport-[a-f0-9-]{36}\.json$') { throw 'Unsafe transport path' }
function CheckDirectory($dir) {
  $item = Get-Item -LiteralPath $dir -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe transport directory' }
}
function CheckFile {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe transport file' }
  & /usr/bin/test '-f' $path
  if ($LASTEXITCODE -ne 0) { throw 'Nonregular transport file' }
}
`;
const CHUNK_PROGRAM = TRANSPORT_GUARD + String.raw`
try {
  $phase = 'chunk'
  CheckDirectory '/'
  CheckDirectory '/workspace'
  if (-not (Test-Path -LiteralPath '/workspace/.hve-upstream')) { $null = [IO.Directory]::CreateDirectory('/workspace/.hve-upstream') }
  CheckDirectory '/workspace/.hve-upstream'
  & /usr/bin/chmod '700' '/workspace/.hve-upstream'
  if ($LASTEXITCODE -ne 0) { throw 'Directory chmod failed' }
  $bytes = [Convert]::FromBase64String('__CHUNK__')
  if ($bytes.Length -gt 12288) { throw 'Oversized transport chunk' }
  $options = [IO.FileStreamOptions]::new()
  $options.Access = [IO.FileAccess]::Write
  $options.Share = [IO.FileShare]::None
  if (__OFFSET__ -eq 0) {
    $options.Mode = [IO.FileMode]::CreateNew
    $options.UnixCreateMode = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite
  } else {
    CheckFile
    $options.Mode = [IO.FileMode]::Open
  }
  $stream = [IO.FileStream]::new($path, $options)
  try {
    if ($stream.Length -ne __OFFSET__) { throw 'Transport offset mismatch' }
    $stream.Position = __OFFSET__
    $stream.Write($bytes,0,$bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  & /usr/bin/chmod '600' $path
  if ($LASTEXITCODE -ne 0) { throw 'File chmod failed' }
  @{ok=$true; operation='chunk'; bytes=(__OFFSET__ + $bytes.Length)} | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ok=$false; operation='chunk'; diagnostic=(SafeDiagnostic $_)} | ConvertTo-Json -Compress
  exit 1
}
`;
const CLEANUP_PROGRAM = TRANSPORT_GUARD + String.raw`
try {
  $phase = 'cleanup'
  CheckDirectory '/'
  CheckDirectory '/workspace'
  if (Test-Path -LiteralPath '/workspace/.hve-upstream') {
    CheckDirectory '/workspace/.hve-upstream'
    if (Test-Path -LiteralPath $path) { CheckFile; [IO.File]::Delete($path) }
    $responsePath = $path + '.response'
    if (Test-Path -LiteralPath $responsePath) {
      $originalPath = $path
      $path = $responsePath
      CheckFile
      [IO.File]::Delete($path)
      $path = $originalPath
    }
    $runtime = $path + '.runtime'
    if (Test-Path -LiteralPath $runtime) {
      CheckDirectory $runtime
      $queue = [Collections.Generic.Queue[string]]::new()
      $queue.Enqueue($runtime)
      while ($queue.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $queue.Dequeue() -Force) {
          if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe runtime cleanup' }
          if ($item.PSIsContainer) { $queue.Enqueue($item.FullName) }
        }
      }
      [IO.Directory]::Delete($runtime,$true)
      if (Test-Path -LiteralPath $runtime) { throw 'Runtime cleanup failed' }
    }
  }
  if (Test-Path -LiteralPath $path) { throw 'Transport cleanup failed' }
  @{ok=$true; operation='cleanup'} | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ok=$false; operation='cleanup'; diagnostic=(SafeDiagnostic $_)} | ConvertTo-Json -Compress
  exit 1
}
`;

const RESPONSE_PROGRAM = TRANSPORT_GUARD + String.raw`
try {
  $phase = 'transport'
  CheckDirectory '/'
  CheckDirectory '/workspace'
  CheckDirectory '/workspace/.hve-upstream'
  $path = $path + '.response'
  CheckFile
  $stream = [IO.File]::OpenRead($path)
  try {
    if ($stream.Length -gt 12000000 -or __OFFSET__ + __COUNT__ -gt $stream.Length) { throw 'Response bounds mismatch' }
    $stream.Position = __OFFSET__
    $bytes = [byte[]]::new(__COUNT__)
    $stream.ReadExactly($bytes)
  } finally { $stream.Dispose() }
  @{ok=$true;operation='response-chunk';offset=__OFFSET__;base64=[Convert]::ToBase64String($bytes)} | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ok=$false;operation='response-chunk';diagnostic=(SafeDiagnostic $_)} | ConvertTo-Json -Compress
  exit 1
}
`;

// Runs only in the isolated Linux server workspace. Every file exchange is base64 + SHA-256.
// Child processes are necessary: genuine upstream scripts use `exit`, which must not terminate
// the envelope-producing parent. No Invoke-Expression, user commands, or inherited credentials.
const SERVER_PROGRAM = DIAGNOSTIC_PROGRAM + String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$dataPath = '__DATA_PATH__'
$p = @{ operation = 'unknown' }
function Regular($path, $directory = $false) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $directory) { throw 'Unsafe file type' }
  if (-not $directory) {
    & /usr/bin/test '-f' $path
    if ($LASTEXITCODE -ne 0) { throw 'Not a regular file' }
  }
  $parent = [IO.Path]::GetDirectoryName($item.FullName)
  while ($parent) {
    $dir = Get-Item -LiteralPath $parent -Force
    if (($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Symlink ancestor' }
    $parent = [IO.Path]::GetDirectoryName($parent)
  }
}
function FileHash($path) {
  $stream = [IO.File]::OpenRead($path)
  try { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
  finally { $stream.Dispose() }
}
function Snapshot {
  Regular $p.workspace $true
  $result = [Collections.Generic.List[object]]::new()
  $queue = [Collections.Generic.Queue[string]]::new()
  $queue.Enqueue($p.workspace)
  $total = 0L
  while ($queue.Count) {
    $dir = $queue.Dequeue()
    foreach ($item in Get-ChildItem -LiteralPath $dir -Force) {
      Regular $item.FullName $item.PSIsContainer
      $rel = [IO.Path]::GetRelativePath($p.workspace, $item.FullName).Replace('\','/')
      if ($rel -notmatch '^(?:\.copilot-tracking|docs|outputs)(?:/|$)' -or $rel -match '(^|/)\.\.(/|$)') { throw 'Outside mirrored roots' }
      if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
      if ($item.Length -gt 256000 -or $result.Count -ge 1000) { throw 'Oversized tree' }
      $bytes = [IO.File]::ReadAllBytes($item.FullName)
      $null = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
      $total += $bytes.Length
      if ($total -gt 8000000) { throw 'Oversized tree' }
      $result.Add(@{path=$rel; kind='file'; base64=[Convert]::ToBase64String($bytes); sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant(); updatedAt=[DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds()})
    }
  }
  return ,@($result.ToArray())
}
try {
  $phase = 'transport'
  Regular $dataPath
  $data = [IO.File]::ReadAllBytes($dataPath)
  if ($data.Length -ne __DATA_BYTES__ -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($data)).ToLowerInvariant() -ne '__DATA_HASH__') { throw 'Transport integrity mismatch' }
  $p = [Text.UTF8Encoding]::new($false,$true).GetString($data) | ConvertFrom-Json -AsHashtable -DateKind String
  if ($p.workspace -notmatch '^/workspace/\.hve-upstream/[a-f0-9-]{36}$') { throw 'Bad workspace' }
  $phase = 'manifest'
  $manifestPath = '/opt/hve-upstream/manifest.json'
  Regular $manifestPath
  if ((FileHash $manifestPath) -ne '__MANIFEST_HASH__') { throw 'Manifest integrity mismatch' }
  $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json -AsHashtable -DateKind String
  if ($manifest.sourceCommit -ne 'a8d863a9715f0738f69711421b1897269911f68f') { throw 'Wrong pin' }
  Regular '/opt/hve-upstream/apm.yml'
  if ((FileHash '/opt/hve-upstream/apm.yml') -ne $manifest.manifestSha256) { throw 'APM integrity mismatch' }
  $phase = 'inventory'
  foreach ($file in $manifest.files) {
    $path = '/opt/hve-upstream/' + $file.path
    Regular $path
    $info = Get-Item -LiteralPath $path -Force
    if ($info.Length -ne $file.bytes -or (FileHash $path) -ne $file.sha256) { throw 'Bundle integrity mismatch' }
  }
  $response = @{ok=$true; operation=$p.operation}
  if ($p.operation -eq 'initialize') {
    $phase = 'initialize'
    Regular '/workspace' $true
    if (Test-Path -LiteralPath '/workspace/.hve-upstream') { Regular '/workspace/.hve-upstream' $true }
    else { $null = [IO.Directory]::CreateDirectory('/workspace/.hve-upstream') }
    if (Test-Path -LiteralPath $p.workspace) { throw 'Workspace already exists' }
    $null = [IO.Directory]::CreateDirectory($p.workspace)
    foreach ($file in $p.files) {
      if ($file.path -notmatch '^(?:\.copilot-tracking|docs|outputs)/[^\\:]+$' -or $file.path -match '(^|/)\.\.?(/|$)') { throw 'Unsafe mirror path' }
      $dest = $p.workspace + '/' + $file.path
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
      $bytes = [Convert]::FromBase64String($file.base64)
      if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -ne $file.sha256) { throw 'Mirror hash mismatch' }
      [IO.File]::WriteAllBytes($dest, $bytes)
      [IO.File]::SetLastWriteTimeUtc($dest, [DateTimeOffset]::FromUnixTimeMilliseconds($file.updatedAt).UtcDateTime)
    }
  } elseif ($p.operation -eq 'run') {
    $phase = 'run'
    $null = Snapshot
    if ($p.script -notin @('Initialize-SquadConsumptionRates','Resolve-SquadModelRoute','Get-SquadDispatchBrief','Measure-SquadLedger','Write-SquadHandoff','Set-SquadCostPreflight')) { throw 'Unknown script' }
    $child = '$ErrorActionPreference = ''Stop''; $WarningPreference = ''Stop''; Set-StrictMode -Version Latest; $global:LASTEXITCODE = 0; $p = [IO.File]::ReadAllText(''{0}'') | ConvertFrom-Json -AsHashtable -DateKind String; Set-Location -LiteralPath $p.workspace; $a = $p.args; $a.SquadRoot = $p.workspace + ''/.copilot-tracking/squad''; if ($p.ContainsKey(''billingLog'')) {{ $a.SessionLog = ''{0}.runtime/events.jsonl'' }}; if ($p.script -eq ''Get-SquadDispatchBrief'') {{ $a.RepoRoot = ''/opt/hve-upstream'' }}; & ''/opt/hve-upstream/.github/skills/squad/scripts/{1}.ps1'' @a 6>&1; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; exit 0' -f $dataPath,$p.script
    $start = [Diagnostics.ProcessStartInfo]::new('/usr/bin/pwsh')
    $runtime = $dataPath + '.runtime'
    if (Test-Path -LiteralPath $runtime) { throw 'Runtime directory already exists' }
    $null = [IO.Directory]::CreateDirectory($runtime)
    Regular $runtime $true
    & /usr/bin/chmod '700' $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Runtime chmod failed' }
    if ($p.ContainsKey('billingLog')) {
      if ($p.script -ne 'Measure-SquadLedger' -or $p.args.ContainsKey('SessionLog')) { throw 'Invalid billing-log scope' }
      $billingBytes = [Convert]::FromBase64String($p.billingLog.base64)
      if ($billingBytes.Length -gt 256000 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($billingBytes)).ToLowerInvariant() -ne $p.billingLog.sha256) { throw 'Billing-log integrity mismatch' }
      $null = [Text.UTF8Encoding]::new($false,$true).GetString($billingBytes)
      [IO.File]::WriteAllBytes($runtime + '/events.jsonl',$billingBytes)
      & /usr/bin/chmod '600' ($runtime + '/events.jsonl')
      if ($LASTEXITCODE -ne 0) { throw 'Billing-log chmod failed' }
    }
    foreach ($dir in @('cache','dotnet')) {
      $null = [IO.Directory]::CreateDirectory($runtime + '/' + $dir)
      & /usr/bin/chmod '700' ($runtime + '/' + $dir)
      if ($LASTEXITCODE -ne 0) { throw 'Runtime child chmod failed' }
    }
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = $runtime
    $start.Environment.Clear()
    $start.Environment['PATH'] = '/usr/bin:/bin'
    $start.Environment['HOME'] = $runtime
    $start.Environment['XDG_CACHE_HOME'] = $runtime + '/cache'
    $start.Environment['DOTNET_CLI_HOME'] = $runtime + '/dotnet'
    foreach ($arg in @('-NoLogo','-NoProfile','-NonInteractive','-InputFormat','Text','-OutputFormat','Text','-EncodedCommand',[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child)))) { $start.ArgumentList.Add($arg) }
    $proc = [Diagnostics.Process]::Start($start)
    $stdout = $proc.StandardOutput.ReadToEndAsync()
    $stderr = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(120000)) { $proc.Kill($true); throw 'Script timeout' }
    $out = $stdout.GetAwaiter().GetResult()
    $err = $stderr.GetAwaiter().GetResult()
    if ($proc.ExitCode -ne 0 -or $err.Length -ne 0) { throw 'Script rejected invocation' }
    $response.scriptExitCode = $proc.ExitCode
    $response.scriptOutput = $out
    $proc.Dispose()
  } elseif ($p.operation -ne 'snapshot') { throw 'Unknown operation' }
  $phase = 'snapshot'
  $response.files = Snapshot
  $responseBytes = [Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Depth 100 -Compress))
  if ($responseBytes.Length -gt 12000000) { throw 'Response exceeds transport bound' }
  $responseOptions = [IO.FileStreamOptions]::new()
  $responseOptions.Mode = [IO.FileMode]::CreateNew
  $responseOptions.Access = [IO.FileAccess]::Write
  $responseOptions.UnixCreateMode = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite
  $responseStream = [IO.FileStream]::new($dataPath + '.response',$responseOptions)
  try { $responseStream.Write($responseBytes); $responseStream.Flush($true) }
  finally { $responseStream.Dispose() }
  @{ok=$true;operation='response';bytes=$responseBytes.Length;sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($responseBytes)).ToLowerInvariant()} | ConvertTo-Json -Compress
  exit 0
} catch {
  @{ok=$false; operation=$p.operation; diagnostic=(SafeDiagnostic $_)} | ConvertTo-Json -Compress
  exit 1
}
`;
