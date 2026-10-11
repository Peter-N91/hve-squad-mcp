import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { SquadArtifact, SquadArtifactStore } from "../src/engine/artifact-store.js";
import type { CopilotSessionConfig, CopilotSessionEvent } from "../src/engine/copilot/copilot-stage-executor.js";
import { installedUpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";
import { InMemoryCopilotSessionStateStore } from "../src/engine/copilot/session-state-store.js";
import {
  createUpstreamRuntime, executeRun, prepareUpstreamRoster, seedConfirmedUpstreamProject, upstreamStageHandoff,
  UPSTREAM_CORE_HELPERS, runUpstreamCoreHelper, refreshUpstreamRankedModel, readUpstreamContract, UPSTREAM_RUNTIME_EVIDENCE_MATRIX,
  UpstreamRuntimeBlockedError, type UpstreamContinuationCheckpoint, type UpstreamRuntimeOptions,
  validateUpstreamScribeRates,
} from "../src/engine/copilot/upstream-runtime.js";
import { StageInputRequired, type ResearchCheckpoint } from "../src/engine/research-runtime.js";
import {
  LocalSpecialists, LOCAL_CONVERTER_SHA256,
  type LocalBinaryArtifact, type LocalSpecialistCommandPort, type LocalSpecialistCapability,
} from "../src/engine/copilot/local-specialists.js";
import type { LocalSpecialistDownloadReference } from "../src/engine/copilot/upstream-runtime.js";
import { publishRunBillingProjection } from "../src/engine/copilot/run-billing-projection.js";
import { attributeCompletion } from "../src/engine/model-backend.js";
import { copilotUsageFor } from "../src/engine/copilot/copilot-usage.js";
import { UPSTREAM_SCRIPT_PIN } from "../src/engine/copilot/upstream-script-bridge.js";
import { selectUpstreamEconomyRoute, parseUpstreamRouting, type UpstreamRoutingSelection } from "../src/engine/copilot/upstream-coordinator.js";

const bundle = installedUpstreamBundle();
const models = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.6-sol"];
const ROOT = ".copilot-tracking/squad";
const hash = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
class Store implements SquadArtifactStore {
  files = new Map<string, SquadArtifact>();
  writes: string[] = [];
  counter = 0;
  conflictPath?: string;
  async get(tenantId: string, project: string, path: string) {
    assert.equal(tenantId, "tenant-a"); assert.equal(project, "project-a");
    return this.files.get(path);
  }
  async list(tenantId: string, project: string, prefix?: string) {
    assert.equal(tenantId, "tenant-a"); assert.equal(project, "project-a");
    return [...this.files.values()].filter(a => !prefix || a.path.startsWith(prefix))
      .map(a => ({ path: a.path, size: a.content.length, updatedAt: a.updatedAt }));
  }
  async put(tenantId: string, project: string, path: string, content: string, etag?: string) {
    assert.equal(tenantId, "tenant-a"); assert.equal(project, "project-a");
    const old = this.files.get(path);
    if (path === this.conflictPath || (etag !== undefined && (etag === "" ? !!old : old?.etag !== etag))) return { ok: false as const, conflict: true as const, current: old };
    const artifact = { tenantId, project, path, content, etag: `v${++this.counter}`, updatedAt: Date.now() };
    this.files.set(path, artifact); this.writes.push(path);
    return { ok: true as const, artifact };
  }
  async append(tenantId: string, project: string, path: string, content: string) {
    const r = await this.put(tenantId, project, path, (this.files.get(path)?.content ?? "") + content);
    assert.ok(r.ok); return r.artifact;
  }
}
function fixture(): { options: UpstreamRuntimeOptions; store: Store; checkpoints: UpstreamContinuationCheckpoint[] } {
  const store = new Store(), checkpoints: UpstreamContinuationCheckpoint[] = [];
  return {
    store, checkpoints,
    options: {
      enabled: true, bundle, store, tenantId: "tenant-a", project: "project-a", runId: "run-a",
      workspace: { id: "workspace-a", tenantId: "tenant-a", root: process.cwd(), resolve: relative => resolve(process.cwd(), relative), dispose: async () => undefined },
      client: { createSession: async () => { throw new Error("No session should be opened by factory probes."); } },
      sessionState: new InMemoryCopilotSessionStateStore(), coordinatorModel: "gpt-5.6-sol", modelIds: models, gitHubToken: "test-only-identity",
      date: "2026-10-10", confirmInitialization: async proposal => ({
        confirmed: true, profile: proposal.profile, economyAccepted: true, approvalChannel: "in-chat", naming: "skip", actor: "actual-user",
      }),
      requestHumanInput: async ({ question, operationId }) => { throw new StageInputRequired({ questionId: operationId, question, purpose: "confirmation" }, {} as ResearchCheckpoint); },
      continuation: { save: async checkpoint => { checkpoints.push(checkpoint); } },
      isActionablePipelineApproved: async () => false,
    },
  };
}

test("disabled and native projects do not select or mutate upstream schema", async () => {
  const f = fixture();
  f.options.enabled = false;
  assert.equal((await createUpstreamRuntime(f.options)).selection, "not-selected");
  assert.equal(f.store.writes.length, 0);
  f.options.enabled = true;
  await f.store.put("tenant-a", "project-a", `${ROOT}/state.json`, '{"schemaVersion":"native-v1"}');
  const before = f.store.writes.length;
  assert.deepEqual(await createUpstreamRuntime(f.options), { selection: "native", ownsLedger: false, reason: "existing-native-project" });
  assert.equal(f.store.writes.length, before);
});

for (const routing of [
  { mode: "ranked" }, { mode: "economy" }, { mode: "manual", model: "gpt-5.4" },
] satisfies UpstreamRoutingSelection[]) {
  test(`explicit ${routing.mode} routing persists the chosen mode and verified roster models`, async () => {
    const f = fixture();
    const proposal = prepareUpstreamRoster(bundle, "default", "2026-10-10", models, undefined, routing);
    const confirmation = {
      confirmed: true as const, profile: "default", routing, routingAccepted: true as const,
      approvalChannel: "in-chat" as const, naming: "skip" as const, actor: "actual-user",
    };
    await seedConfirmedUpstreamProject(f.options, bundle, proposal, confirmation, "2026-10-10T00:00:00Z");
    const binding = JSON.parse(f.store.files.get(`${ROOT}/runtime-binding.json`)!.content);
    assert.deepEqual(binding.routing, routing);
    assert.match(f.store.files.get(`${ROOT}/team.md`)!.content, new RegExp(`Model routing: ${routing.mode}`));
    if (routing.mode === "manual") assert.ok(proposal.teamMarkdown.split("\n").filter(line => /^\| (researcher|lead|developer|tester|scribe) \|/.test(line)).every(line => line.includes(`| ${routing.model} |`)));
    f.options.routing = { mode: routing.mode === "economy" ? "ranked" : "economy" };
    const reopened = await createUpstreamRuntime(f.options);
    assert.equal(reopened.selection, "upstream");
    if (reopened.selection === "upstream") assert.deepEqual(reopened.proposal.routing, routing, "Operator defaults cannot change the existing user's binding.");
  });
}

test("routing choices validate exact shape, inventory, floors and fit-first versus economy ordering", () => {
  const catalog = readUpstreamContract(bundle, ".github/skills/squad/references/model-catalog.md");
  const routing = readUpstreamContract(bundle, ".github/skills/squad/references/model-routing.md");
  const candidates = ["claude-sonnet-5", "claude-fable-5.1"];
  assert.equal(selectUpstreamEconomyRoute(catalog, routing, "developer", "default", candidates, { mode: "ranked" }).model, "claude-fable-5.1");
  assert.equal(selectUpstreamEconomyRoute(catalog, routing, "developer", "default", candidates, { mode: "economy" }).model, "claude-sonnet-5");
  assert.equal(selectUpstreamEconomyRoute(catalog, routing, "developer", "default", candidates, { mode: "manual", model: "claude-sonnet-5" }).rankedModel, "claude-sonnet-5");
  assert.throws(() => prepareUpstreamRoster(bundle, "default", "2026-10-10", models, undefined, { mode: "manual", model: "absent" }), /unavailable|verified available/);
  assert.throws(() => selectUpstreamEconomyRoute(catalog, routing, "developer", "extended", models, { mode: "manual", model: "gpt-5.4-mini" }), /unavailable|verified available/);
  for (const input of [{ mode: "off" }, { mode: "manual" }, { mode: "ranked", model: "gpt-5.4" }, { mode: "economy", extra: true }]) {
    assert.throws(() => parseUpstreamRouting(input));
  }
});

test("ranked/manual Scribe rates preserve the pinned cold seed, calibration and valid operator rows", () => {
  const source = readUpstreamContract(bundle, ".github/skills/squad/references/consumption-rates-template.md");
  const seed = /````markdown\r?\n([\s\S]*?)\r?\n````/.exec(source)![1] + "\n";
  validateUpstreamScribeRates(bundle, seed);
  validateUpstreamScribeRates(bundle, seed.replace("calibration_factor: 1.00", "calibration_factor: 1.25"));
  const operator = "| Operator model | `operator-model` | default | 1 | 0.1 | 0 | 2 | none (flat rate) | n/a | n/a | n/a | n/a | operator declared |";
  validateUpstreamScribeRates(bundle, seed.replace(/^(\| \(additional\).*)$/m, `${operator}\n$1`));
  assert.throws(() => validateUpstreamScribeRates(bundle, seed.replace("observations: 0", "observations: -1")), /calibration/);
  assert.throws(() => validateUpstreamScribeRates(bundle, seed.replace("## Dispatch-size estimator", "## Missing estimator")), /estimator/);
  assert.throws(() => validateUpstreamScribeRates(bundle, seed.split("\n").filter(line =>
    !line.startsWith("| GPT-5.4 nano")).join("\n")), /omit pinned template rows/);
});

test("unavailable proposed ranked models do not prevent the user choosing eligible manual routing", async () => {
  const f = fixture();
  f.options.modelIds = ["claude-opus-5"];
  f.options.coordinatorModel = "claude-opus-5";
  f.options.confirmInitialization = undefined;
  await assert.rejects(createUpstreamRuntime(f.options), (error: unknown) => error instanceof StageInputRequired);
  assert.ok(f.checkpoints[0].proposal.routingUnavailable?.length);
  assert.ok(f.checkpoints[0].proposal.availableManualModels?.includes("claude-opus-5"));
  assert.equal(f.store.writes.length, 0);
  f.options.confirmInitialization = async proposal => ({
    confirmed: true, profile: proposal.profile, naming: "skip", approvalChannel: "in-chat", actor: "actual-user",
    routingAccepted: true, routing: { mode: "manual", model: "claude-opus-5" },
  });
  const selected = await createUpstreamRuntime(f.options);
  assert.equal(selected.selection, "upstream");
  if (selected.selection === "upstream") {
    assert.deepEqual(selected.proposal.routing, { mode: "manual", model: "claude-opus-5" });
    assert.deepEqual(selected.proposal.routingUnavailable, []);
  }
});
test("Init requires real confirmation and persists a resumable exact initialization operation without writing state", async () => {
  const f = fixture();
  f.options.confirmInitialization = undefined;
  await assert.rejects(createUpstreamRuntime(f.options), (error: unknown) => error instanceof StageInputRequired);
  assert.equal(f.store.writes.length, 0);
  assert.equal(f.checkpoints[0].resumable, true);
  assert.equal(f.checkpoints[0].pendingOperation.kind, "initialization");
  assert.equal(f.checkpoints[0].completedStages.length, 0);
});

test("default roster and model picks come from complete upstream templates and exact deployed personas", () => {
  const proposal = prepareUpstreamRoster(bundle, "default", "2026-10-10", models);
  assert.deepEqual(proposal.roster.map(r => r.role), ["researcher", "lead", "developer", "tester", "scribe"]);
  assert.match(proposal.teamMarkdown, /Model routing: economy/);
  assert.match(proposal.teamMarkdown, /Code Review Walkback/);
  assert.match(proposal.teamMarkdown, /\| Model Tier \| Model \| Deliverable Root \|/);
  assert.match(proposal.routingMarkdown, /Routing/);
  assert.ok(proposal.roster.every(r => bundle.paths().includes(r.charterPath)));
  assert.throws(() => prepareUpstreamRoster(bundle, "imaginary", "2026-10-10", models), /not in the pinned/);
  assert.throws(() => prepareUpstreamRoster(bundle, "security", "2026-10-10", models), /explicit upstream deliverable scope/);
});

test("authentic schema 1.4 seed uses complete upstream state and non-atomic conflict receipts", async () => {
  const f = fixture(), proposal = prepareUpstreamRoster(bundle, "default", "2026-10-10", models);
  const confirmation = { confirmed: true as const, profile: "default", economyAccepted: true as const, approvalChannel: "in-chat" as const, naming: "skip" as const, actor: "actual-user" };
  const seeded = await seedConfirmedUpstreamProject(f.options, bundle, proposal, confirmation, "2026-10-10T00:00:00Z");
  assert.equal(seeded.atomic, false);
  const state = JSON.parse(f.store.files.get(`${ROOT}/state.json`)!.content);
  assert.equal(state.schemaVersion, "1.4");
  assert.equal(state.currentRun.costPreflight.decision, "not-requested");
  assert.equal(state.notify.approvalChannel, "in-chat");
  assert.equal(state.currentRun.sessionModel, f.options.coordinatorModel);
  const binding = JSON.parse(f.store.files.get(`${ROOT}/runtime-binding.json`)!.content);
  assert.equal(binding.commit, UPSTREAM_SCRIPT_PIN);
  assert.ok(f.store.files.get(`${ROOT}/consumption-rates.md`)!.content.includes("## Calibration"));
  assert.match(f.store.files.get(`${ROOT}/consumption.md`)!.content, /## Attribution/);
  assert.equal(seeded.committedPaths.at(-1), `${ROOT}/runtime-binding.json`);
  await assert.rejects(seedConfirmedUpstreamProject(f.options, bundle, proposal, confirmation, "2026-10-10T00:00:00Z"), /Project changed/);
  const failed = fixture();
  failed.store.conflictPath = `${ROOT}/routing.md`;
  await assert.rejects(seedConfirmedUpstreamProject(failed.options, bundle, proposal, confirmation, "2026-10-10T00:00:00Z"),
    (error: unknown) => error instanceof UpstreamRuntimeBlockedError && error.reason === "init_partial" && error.committedPaths.length > 0);
  assert.equal(failed.store.files.has(`${ROOT}/runtime-binding.json`), false);
});

test("incompletely initialized upstream projects without a checkpoint are not implicitly reseeded", async () => {
  const f = fixture();
  await f.store.put("tenant-a", "project-a", `${ROOT}/runtime-binding.json`, JSON.stringify({ runtime: "upstream", commit: bundle.identity.sourceCommit, schemaVersion: "1.4" }));
  await assert.rejects(createUpstreamRuntime(f.options), /incompletely initialized/);
});

interface Mirror { path: string; base64: string; sha256: string; updatedAt: number }
/**
 * Local test-only transport terminates the bridge's authenticated envelope, then runs the
 * unchanged pinned PowerShell script in a project-local isolated directory. It does not
 * certify the Linux transport; that boundary is separately tested by upstream-script-bridge.
 */
class LocalProcedurePort {
  data = new Map<string, Buffer>();
  trees = new Map<string, Mirror[]>();
  scripts: { name: string; args: Record<string, unknown> }[] = [];
  measurements = new Map<string, string>();
  cacheMeasurements = false;
  constructor(readonly root: string) {}
  async runServerCommand(command: string) {
    const source = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    const path = /\$(?:dataPath|path) = '([^']+)'/.exec(source)?.[1];
    assert.ok(path);
    if (source.includes("operation='chunk'")) {
      const chunk = Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(source)![1], "base64");
      this.data.set(path, Buffer.concat([this.data.get(path) ?? Buffer.alloc(0), chunk]));
      return { success: true, exitCode: 0, output: JSON.stringify({ ok: true, operation: "chunk", bytes: this.data.get(path)!.length }) };
    }
    if (source.includes("operation='cleanup'")) {
      this.data.delete(path);
      return { success: true, exitCode: 0, output: '{"ok":true,"operation":"cleanup"}' };
    }
    const p = JSON.parse(this.data.get(path)!.toString()) as { operation: string; workspace: string; files?: Mirror[]; script?: string; args?: Record<string, unknown>;
      billingLog?: { base64: string; sha256: string } };
    if (p.operation === "initialize") this.trees.set(p.workspace, p.files!);
    let output = "{}";
    if (p.operation === "run") {
      assert.ok(p.script && p.args);
      this.scripts.push({ name: p.script, args: p.args });
      const dir = join(this.root, p.workspace.split("/").at(-1)!);
      mkdirSync(dir, { recursive: true });
      const baseline = new Map(this.trees.get(p.workspace)!.map(f => [f.path, f]));
      const measurementKey = p.script === "Measure-SquadLedger" && this.cacheMeasurements
        ? JSON.stringify({ files: [...baseline.values()].map(file => [file.path, file.sha256]).sort(), args: p.args, log: p.billingLog }) : undefined;
      const cached = measurementKey && this.measurements.get(measurementKey);
      if (cached) {
        return { success: true, exitCode: 0, output: JSON.stringify({ ok: true, operation: p.operation,
          files: [...baseline.values()].map(file => ({ ...file, kind: "file" })), scriptExitCode: 0, scriptOutput: cached }) };
      }
      for (const f of baseline.values()) {
        const dest = join(dir, ...f.path.split("/"));
        mkdirSync(resolve(dest, ".."), { recursive: true });
        writeFileSync(dest, Buffer.from(f.base64, "base64"));
        utimesSync(dest, new Date(f.updatedAt), new Date(f.updatedAt));
      }
      const args = { ...p.args, SquadRoot: join(dir, ".copilot-tracking", "squad"),
        ...(p.script === "Get-SquadDispatchBrief" ? { RepoRoot: bundle.root } : {}),
        ...(p.billingLog ? { SessionLog: join(this.root, "billing-events.jsonl") } : {}),
      };
      if (p.billingLog) {
        const bytes = Buffer.from(p.billingLog.base64, "base64");
        assert.equal(hash(bytes), p.billingLog.sha256);
        writeFileSync(join(this.root, "billing-events.jsonl"), bytes);
      }
      const encodedArgs = Buffer.from(JSON.stringify(args)).toString("base64");
      const program = `$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}'))|ConvertFrom-Json -AsHashtable -DateKind String; Set-Location -LiteralPath '${dir.replaceAll("'", "''")}'; & '${join(bundle.root, ".github", "skills", "squad", "scripts", p.script + ".ps1").replaceAll("'", "''")}' @a; exit $LASTEXITCODE`;
      const child = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], { encoding: "utf8", timeout: 60000, maxBuffer: 2000000 });
      if (p.billingLog) rmSync(join(this.root, "billing-events.jsonl"));
      assert.equal(child.status, 0, `${p.script}: ${child.stderr}\n${child.stdout}`);
      output = child.stdout.trim();
      if (measurementKey) this.measurements.set(measurementKey, output);
      const files: Mirror[] = [];
      const walk = (directory: string, prefix: string) => {
        for (const name of readdirSync(directory)) {
          const full = join(directory, name), rel = prefix ? prefix + "/" + name : name;
          if (statSync(full).isDirectory()) walk(full, rel);
          else {
            const bytes = readFileSync(full), digest = hash(bytes), old = baseline.get(rel);
            files.push({ path: rel, base64: bytes.toString("base64"), sha256: digest,
              updatedAt: old?.sha256 === digest ? old.updatedAt : Math.floor(statSync(full).mtimeMs) });
          }
        }
      };
      walk(dir, "");
      this.trees.set(p.workspace, files);
    }
    return { success: true, exitCode: 0, output: JSON.stringify({ ok: true, operation: p.operation,
      files: this.trees.get(p.workspace)!.map(f => ({ ...f, kind: "file" })),
      ...(p.operation === "run" ? { scriptExitCode: 0, scriptOutput: output } : {}) }) };
  }
}
const pwshAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0;

test("run-scoped billing/value preserves project history and excludes earlier accepted deliverables", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), port = new LocalProcedurePort(scratch);
  port.cacheMeasurements = true;
  try {
    const proposal = prepareUpstreamRoster(bundle, "default", "2026-10-10", models);
    await seedConfirmedUpstreamProject(f.options, bundle, proposal, {
      confirmed: true, profile: "default", naming: "skip", economyAccepted: true, approvalChannel: "in-chat", actor: "subject",
    }, "2026-10-10T00:00:00Z");
    const consumption = JSON.stringify({ model: "gpt-5.3-codex", model_source: "dispatch-reported", priced_as: "gpt-5.3-codex",
      model_tier: "default", internal_turns: 1, input_tokens: 10, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 2, basis: "estimated" });
    const entry = (id: string, turn: number, deliverable: string, outcome: string) =>
      `### 2026-10-10T12:00:00Z ${id}\n\n* Turn: ${turn}\n* Request: ${outcome}\n* Deliverable: ${deliverable}\n* Outcome: ${outcome}\n\n#### Consumption\n\n\`\`\`json\n${consumption}\n\`\`\`\n`;
    const ownerPath = `${ROOT}/history/Squad-Implementor.md`, reviewerPath = `${ROOT}/history/Squad-Reviewer.md`;
    const owner = "# History: Squad Implementor\n\n" + entry("prior-owner", 1, "docs/old.md", "Produced docs/old.md.") +
      entry("current-owner", 2, "docs/new.md", "Produced docs/new.md.");
    const reviewer = "# History: Squad Reviewer\n\n" + entry("prior-review", 1, "docs/old-review.md", "Pass: docs/old.md.") +
      entry("current-review", 3, "docs/new-review.md", "Pass: docs/new.md.");
    await f.store.put("tenant-a", "project-a", ownerPath, owner);
    await f.store.put("tenant-a", "project-a", reviewerPath, reviewer);
    const records = [1_000_000_000, 2_000_000_000].map((nano, index) => attributeCompletion({
      eventId: `usage-${index}`, attempt: 1, outcome: "completed", backendId: "copilot-sdk",
      usage: copilotUsageFor({ copilotUsage: { totalNanoAiu: nano } }),
    }, { runId: "run-a", stage: "Squad Coordinator", actor: "Squad Coordinator" }));
    const options = { store: f.store, port, bundle, tenantId: "tenant-a", project: "project-a", runId: "run-a",
      historyAliases: [{ artifactPath: ownerPath, upstreamName: "Squad Implementor" }, { artifactPath: reviewerPath, upstreamName: "Squad Reviewer" }] };
    const ids = new Set(["current-owner", "current-review"]);
    const first = await publishRunBillingProjection(options, records, ids);
    assert.equal(first.accepted, 1);
    assert.equal(first.deliverablesProduced, 1);
    assert.equal(first.hostBilledCreditsPerAccepted, 3, "three credits / one run-scoped accepted deliverable, not two project-wide");
    await f.store.put("tenant-a", "project-a", "docs/new.md", "Exact produced report.");
    await f.store.put("tenant-a", "project-a", "docs/new-review.md", "Independently reviewed exact report.");
    const verification = { verdict: "Pass" as const, reviewerStageId: "current-review", ownerStageId: "current-owner",
      reviewReceipt: { path: "docs/new-review.md", sha256: hash("Independently reviewed exact report.") },
      readHashes: [{ path: "docs/new.md", sha256: hash("Exact produced report.") },
        { path: "input/request.md", sha256: hash("Stage-local request is not persisted project content.") }],
      findings: [], approvedActionablePipeline: false };
    const stoppedReview = reviewer.replaceAll("Pass: docs/new.md.", "stop");
    await f.store.put("tenant-a", "project-a", reviewerPath, stoppedReview);
    const verified = await publishRunBillingProjection(options, records, ids, verification);
    assert.equal(verified.accepted, 1, "trusted exact-hash Pass, not provider stop, supplies final value");
    assert.equal(f.store.files.get(reviewerPath)!.content, stoppedReview, "trusted view does not rewrite persisted Outcome");
    const rejected = await publishRunBillingProjection(options, records, ids, { ...verification, verdict: "Fail" });
    assert.equal(rejected.accepted, 0);
    assert.equal(rejected.rejected, 1);
    assert.equal(rejected.hostBilledCreditsPerAccepted, null);
    await assert.rejects(publishRunBillingProjection(options, records, ids, {
      ...verification, readHashes: [{ path: "docs/new.md", sha256: "0".repeat(64) }],
    }), /proof changed/);
    await f.store.put("tenant-a", "project-a", reviewerPath, reviewer);
    const partial = await publishRunBillingProjection(options, [
      records[0], { ...records[1], usage: copilotUsageFor({ inputTokens: 5, outputTokens: 2 }) },
    ], ids);
    assert.equal(partial.billingStatus, "incomplete");
    assert.equal(partial.knownCreditsSubtotal, 1);
    assert.equal(partial.hostBilledCredits, null);
    assert.equal(partial.hostBilledCreditsPerAccepted, null);
    const zero = await publishRunBillingProjection(options, [{
      ...records[0], usage: copilotUsageFor({ copilotUsage: { totalNanoAiu: 0 } }),
    }], ids);
    assert.equal(zero.hostBilledCreditsPerAccepted, 0);
    assert.equal(f.store.files.get(ownerPath)!.content, owner);
    assert.equal(f.store.files.get(reviewerPath)!.content, reviewer);
    const ledger = f.store.files.get(`${ROOT}/consumption.md`)!.content;
    assert.equal((ledger.match(/^## Run-scoped SDK billing & value$/gm) ?? []).length, 1);
    assert.ok(!ledger.includes("events.jsonl"));
    const receiptPath = `${ROOT}/runtime-billing/run-a.json`;
    assert.equal(JSON.parse(f.store.files.get(receiptPath)!.content).accepted, 1);
    await assert.rejects(publishRunBillingProjection(options, records, new Set(["nonexistent-stage"])), /unpersisted history ID/);
    f.store.conflictPath = receiptPath;
    await assert.rejects(publishRunBillingProjection(options, records, ids), /CAS conflicted/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

/** Test-only Linux command transport exercising the real LocalSpecialists protocol. */
class LocalTestPort implements LocalSpecialistCommandPort {
  calls: { source: string; payload: Record<string, unknown> }[] = [];
  inputChunks: Buffer[] = [];
  output = Buffer.alloc(0);
  async runServerCommand(command: string) {
    assert.match(command, /^pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    const source = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(source)![1];
    const p = JSON.parse(Buffer.from(encoded, "base64").toString()) as Record<string, unknown>;
    this.calls.push({ source, payload: p });
    let receipt: Record<string, unknown>;
    if ("probes" in p) receipt = { ok: true, linux: true, markdown: true,
      probes: (p.probes as { id: string }[]).map(probe => ({ id: probe.id, present: true })) };
    else if ("base64" in p) {
      assert.equal(p.offset, Buffer.concat(this.inputChunks).length);
      this.inputChunks.push(Buffer.from(String(p.base64), "base64"));
      receipt = { ok: true, phase: "write", offset: Buffer.concat(this.inputChunks).length };
    } else if ("operation" in p) {
      assert.equal(p.inputSha256, hash(Buffer.concat(this.inputChunks)));
      this.output = p.operation === "markdown-to-docx" ? Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.alloc(120, 7)]) :
        Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(48123, 17)]);
      receipt = { ok: true, phase: "execute", operation: p.operation, inputSha256: p.inputSha256, sha256: hash(this.output),
        byteLength: this.output.length, exitCode: 0, converterSha256: p.operation === "markdown-to-docx" ? LOCAL_CONVERTER_SHA256 : null };
    } else if ("total" in p) receipt = { ok: true, phase: "read", offset: p.offset,
      base64: this.output.subarray(Number(p.offset), Number(p.offset) + 24000).toString("base64") };
    else if (source.includes("phase='cleanup'")) receipt = { ok: true, phase: "cleanup" };
    else { this.inputChunks = []; receipt = { ok: true, phase: "init" }; }
    return { success: true, exitCode: 0, output: JSON.stringify(receipt) };
  }
}

function installLiveClient(f: ReturnType<typeof fixture>, port: LocalProcedurePort,
  pause: "none" | "coordinator" | "child" | "capability" | "core" | "escalation" | "local" | "local-invalid-reference" = "none",
  specialistPort?: LocalSpecialistCommandPort) {
  const configs: CopilotSessionConfig[] = [];
  let ownerStageId = "", ownerPath = "";
  const seen = { disconnected: false, resumes: [] as string[], createdChildren: [] as string[], answered: [] as string[] };
  const humanQuestion = "Approve only the scoped report publication?";
  const humanReason = "Project-specific publication confirmation, not cloud/tracker admission.";
  let nativePrimary = "";
  let correctionExecuted = false;
  const open = async (config: CopilotSessionConfig, resumeId?: string) => {
      configs.push(config);
      const coordinator = config.sessionId.startsWith("upstream-");
      const helper = config.sessionId.startsWith("core-");
      if (coordinator) seen.disconnected = false;
      if (resumeId) { assert.equal(resumeId, config.sessionId); seen.resumes.push(resumeId); }
      else if (!coordinator && !helper) seen.createdChildren.push(config.sessionId);
      const listeners = new Set<(event: CopilotSessionEvent) => void>();
      const emit = (event: CopilotSessionEvent) => { for (const listener of listeners) listener(event); };
      const call = async (name: string, args: unknown, success = true) => {
        const tool = config.tools.find(t => t.name === name);
        assert.ok(tool, name);
        const result = await tool.handler(args);
        assert.equal(result.resultType, success ? "success" : "failure", result.textResultForLlm);
        return result.textResultForLlm;
      };
      return {
        on(listener: (event: CopilotSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        async sendAndWait(input: { prompt: string }) {
          await config.fileSystem.writeFile(`/sessions/${config.sessionId}/events.jsonl`, '{"type":"durable-session-marker"}\n');
          emit({ type: "assistant.usage", data: { model: config.model, inputTokens: 100, outputTokens: 40, cacheReadTokens: 10,
            copilotUsage: { totalNanoAiu: 100_000_000 } } });
          if (helper) {
            assert.equal(config.customAgents?.length ?? 0, 0);
            assert.ok(config.availableTools.every(t => t.startsWith("custom:")));
            const delegated = JSON.parse(input.prompt);
            const sources = [];
            for (const source of delegated.sources) sources.push(JSON.parse(await call("read_source", source)));
            if (delegated.kind === "research-lane") {
              assert.match(config.systemMessage.content, /calling agent reads the sources/i);
              await assert.rejects(config.fileSystem.writeFile("/workspace/" + delegated.outputPath, "worker writes"), /outside|scope|EACCES/);
              await call("finish_research_lane", {
                status: "Complete", summary: "Located candidate material for the bounded question.",
                sources: sources.map(s => ({ receiptId: s.receiptId, location: s.target, description: "Actual located source.",
                  relevance: "This source addresses the bounded question.", exactMaterial: s.content.slice(0, 100) })),
                gaps: "None", stopReason: "Sources covered.",
              });
            } else {
              assert.match(config.systemMessage.content, /RPI Plan Critique/);
              await call("read_source", { kind: "project", target: delegated.parentPath });
              await call("submit_plan_critique", { content: "# Independent Plan Critique\n\nExecution: Complete\nVerdict: Pass\n\nThe exact supplied plan and mandatory research evidence were read independently.\n" });
              await call("finish_plan_critique", { status: "Complete", reviewOutcome: "Pass" });
            }
          } else if (coordinator) {
            if (resumeId && pause === "coordinator") {
              const response = JSON.parse(await call("request_human_input", { question: humanQuestion, reason: humanReason }));
              seen.answered.push(response.answer);
            }
            for (const name of ["Initialize-SquadConsumptionRates", "Resolve-SquadModelRoute", "Get-SquadDispatchBrief"]) await call("invoke_upstream_procedure", { name });
            if (pause === "core") {
              await call("delegate_role_stage", { role: "researcher", agent: "Squad Researcher", task: "Execute the original research skill with a complete three-wave cycle and independently verified sources.", purpose: "work" });
              await call("delegate_role_stage", { role: "lead", agent: "Squad Lead", task: "Author the original RPI plan and obtain an independent standard critique.", purpose: "work" });
            }
            if (pause === "capability") {
              await call("delegate_role_stage", { role: "developer", agent: "Squad Implementor", task: "Required skill validation needs a trusted script.", purpose: "work" }, false);
              return { data: { content: "blocked capability" } };
            }
            if (pause === "child" && !resumeId) {
              await call("delegate_role_stage", { role: "developer", agent: "Squad Implementor", task: "Write a bounded project findings report, no live action.", purpose: "work" }, false);
              return { data: { content: "held" } };
            }
            const first = JSON.parse(await call("delegate_role_stage", { role: "developer", agent: "Squad Implementor", task: "Write a bounded project findings report, no live action.", purpose: "work" }));
            ownerStageId = first.stageId; ownerPath = first.artifacts[0].path;
            await call("delegate_role_stage", { role: "tester", agent: "Squad Reviewer", task: "Independently review the final report.", purpose: "review", reviewsStageId: ownerStageId });
            await call("invoke_upstream_procedure", { name: "Measure-SquadLedger" });
            if (pause === "escalation") {
              await call("finish_upstream_run", { outcome: "accepted", summary: "Must not accept failed review.", gaps: [], reportPaths: [ownerPath] }, false);
              const corrected = JSON.parse(await call("delegate_role_stage", {
                role: "developer", agent: "Squad Implementor", task: "Correct the original report against its independent Fail finding only.",
                purpose: "correction", correctsStageId: ownerStageId,
              }));
              correctionExecuted = true;
              ownerStageId = corrected.stageId; ownerPath = corrected.artifacts[0].path;
              await call("delegate_role_stage", { role: "tester", agent: "Squad Reviewer", task: "Rereview the final original-owner corrected report.", purpose: "review", reviewsStageId: ownerStageId });
              await call("invoke_upstream_procedure", { name: "Measure-SquadLedger" });
            }
            if (pause === "coordinator" && !resumeId) {
              await call("request_human_input", { question: humanQuestion, reason: humanReason }, false);
              return { data: { content: "held" } };
            }
            await call("finish_upstream_run", { outcome: "accepted", summary: "Stored independent report.", gaps: [], reportPaths: [ownerPath] });
            // Provider usage can arrive after the terminal tool. The actual RPC session
            // remains alive until these observed tokens have a scripted Scribe receipt.
            emit({ type: "assistant.usage", data: { model: config.model, inputTokens: 9, outputTokens: 3,
              copilotUsage: { totalNanoAiu: 10_000_000 } } });
          } else {
            assert.equal(config.customAgents?.length ?? 0, 0);
            assert.ok(!config.availableTools.includes("builtin:task"));
            assert.ok(!config.availableTools.includes("builtin:bash"));
            assert.match(config.systemMessage.content, /Original upstream role skill/);
            if (pause === "capability") {
              await call("request_skill_capability", { kind: "trusted-skill-script", resource: ".github/skills/rpi/required-script.ps1" }, false);
              return { data: { content: "required skill script unavailable" } };
            }
            if (pause === "core" && config.tools.some(t => t.name === "delegate_research_lane")) {
              await call("finish_stage", { status: "complete", readiness: "ready", summary: "Cannot inline research.", evidenceIds: [] }, false);
              await call("submit_artifact", { content: "# RPI Research\n\n## Scope and Questions\nLocate the actual documented feature.\n\n## Research Record\nCycle 1; three waves required.\n" });
              const evidenceIds: string[] = [];
              for (const wave of ["Wider", "Deeper", "Contrarian"]) {
                const lane = JSON.parse(await call("delegate_research_lane", {
                  cycle: 1, wave, laneId: wave.toLowerCase(), laneType: "internal",
                  questions: ["What source actually documents the feature?"], criteria: "Read actual bytes; report exact material.",
                  scope: "The supplied source only.", nonGoals: "No code or live resource changes.",
                  posture: "focused", sources: [{ kind: "project", target: "docs/input.md" }],
                }));
                for (const source of lane.sources) {
                  const verified = JSON.parse(await call("verify_research_source", { laneArtifactPath: lane.laneArtifactPath, receiptId: source.receiptId }));
                  assert.equal(verified.independentlyVerified, true);
                  const evidenceId = /receipt (E\d+)/.exec(verified.evidenceContext)?.[1];
                  assert.ok(evidenceId); evidenceIds.push(evidenceId);
                }
              }
              await call("submit_artifact", { content: `# RPI Research\n\n## Research Record\nCycle 1 completed Wider, Deeper, Contrarian.\n\n## Verified Findings\nC1: The document states the feature. ${evidenceIds.join(" ")}\n\n## Planning Readiness\nready\n` });
              await call("finish_stage", { status: "complete", readiness: "ready", summary: "Three real named lanes were independently verified.", evidenceIds });
              return { data: { content: "Research complete." } };
            }
            if (pause === "core" && config.tools.some(t => t.name === "request_plan_critique")) {
              await call("submit_artifact", { content: "# RPI Plan\n\n## User Decisions and Requirements\nProduce a bounded advisory text report.\n\n## Planning Readiness and Next Step\nReady within the stated boundary.\n\n## Critique Disposition\n* Execution: started\n\n## Phase Checklist\n### [ ] P01: Evidence-grounded report\n#### [ ] P01-T01: Write the report from actual source evidence; no live changes.\n" });
              await call("finish_stage", { status: "complete", readiness: "ready", summary: "Cannot skip critique.", evidenceIds: [] }, false);
              const critique = JSON.parse(await call("request_plan_critique", {
                requirements: "The report must be evidence-grounded, advisory and text-only.", scope: "The supplied plan and research.",
                nonGoals: "No external research, cloud or tracker operations.", decisions: "User requests advisory report only.",
                dependencies: "Actual completed research stage.", sources: [{ kind: "project", target: "docs/input.md" }],
              }));
              assert.equal(critique.agent, "Squad Challenger");
              assert.equal(critique.verdict, "Pass");
              assert.ok(critique.finalizedPlanSha256);
              await call("finish_stage", { status: "complete", readiness: "ready", summary: "Actual independent critique passed; disposition recorded.", evidenceIds: [] });
              return { data: { content: "Plan complete." } };
            }
            if (pause === "core" && config.tools.some(t => t.name === "record_plan_progress")) {
              const content = await config.fileSystem.readFile("/workspace/docs/input.md");
              const post = await config.hooks.onPostToolUse({ toolName: "view", toolArgs: { path: "/workspace/docs/input.md" },
                sessionId: config.sessionId, toolResult: { resultType: "success", textResultForLlm: content } });
              const evidenceId = /receipt (E\d+)/.exec(post?.additionalContext ?? "")?.[1];
              assert.ok(evidenceId);
              await call("submit_artifact", { content: `# RPI Changes\n\n## Completed P01-T01\nProduced the bounded advisory report from actual source evidence. Validation: document content read; no source-code execution or live resource change. ${evidenceId}\n` });
              await call("record_plan_progress", { taskId: "P01-T01", evidenceIds: ["fabricated"] }, false);
              const progress = JSON.parse(await call("record_plan_progress", { taskId: "P01-T01", evidenceIds: [evidenceId] }));
              assert.equal(progress.completed, true);
              await call("finish_stage", { status: "complete", readiness: "ready", summary: "Bounded text report and exact task progress recorded.", evidenceIds: [evidenceId] });
              return { data: { content: "Implementation complete." } };
            }
            const review = config.systemMessage.content.includes("Squad Reviewer");
            if (!review && pause === "local-invalid-reference") {
              const primary = /server publishes that output at ([^\s]+)\./.exec(config.systemMessage.content)![1];
              const outputPath = primary.slice(0, primary.lastIndexOf("/") + 1) + "report.docx";
              const result = JSON.parse(await call("execute_local_specialist", { operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath }, false));
              assert.equal(result.code, "local_download_reference");
              assert.equal(result.committed, true);
              assert.equal(result.completed, false);
              return { data: { content: "Unsafe publication refused; do not fabricate completion." } };
            }
            if (!review && pause === "local") {
              const capabilities = JSON.parse(await call("list_local_capabilities", {})) as { capabilities: LocalSpecialistCapability[] };
              assert.equal(capabilities.capabilities.find(c => c.id === "authenticated-per-user-bindings")?.status, "auth-deferred");
              assert.equal(capabilities.capabilities.find(c => c.id === "windows-desktop-automation")?.status, "windows-unsupported");
              const primary = /server publishes that output at ([^\s]+)\./.exec(config.systemMessage.content)![1];
              const prefix = primary.slice(0, primary.lastIndexOf("/") + 1);
              const before = (specialistPort as LocalTestPort).calls.length;
              await call("execute_local_specialist", { operation: "run-python", inputPath: "docs/input.md", outputPath: prefix + "bad.docx" }, false);
              await call("execute_local_specialist", { operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath: "outputs/outside.docx" }, false);
              await call("execute_local_specialist", { operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath: prefix + "new.docx", command: "arbitrary shell" }, false);
              await call("execute_local_specialist", { operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath: primary }, false);
              await call("execute_local_specialist", { operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath: prefix + "existing.docx" }, false);
              assert.equal((specialistPort as LocalTestPort).calls.length, before, "invalid requests never reach trusted commands");
              assert.equal((await config.hooks.onPreToolUse({ toolName: "execute_local_specialist", toolArgs: {}, sessionId: "unattributed-worker" }))?.permissionDecision, "deny");
              assert.equal((await config.hooks.onPreToolUse({ toolName: "execute_local_specialist", toolArgs: {}, sessionId: config.sessionId }))?.permissionDecision, "allow");
              const docx = JSON.parse(await call("execute_local_specialist", { operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath: prefix + "report.docx" }));
              const png = JSON.parse(await call("execute_local_specialist", { operation: "graphviz-to-png", inputPath: "docs/diagram.dot", outputPath: prefix + "diagram.png" }));
              assert.equal(docx.stageComplete, false);
              assert.equal(png.stageComplete, false);
              await call("get_local_artifact_reference", { path: prefix + "not-recorded.docx" }, false);
              for (const conversion of [docx, png]) {
                const publication = JSON.parse(await call("get_local_artifact_reference", { path: conversion.receipt.outputPath }));
                assert.equal(publication.sha256, conversion.receipt.sha256);
                assert.equal(publication.binaryReviewAccepted, false);
                assert.equal(publication.stageComplete, false);
                conversion.download = { metadataPath: publication.metadataPath, downloadUrl: publication.downloadUrl, expiresAt: publication.expiresAt };
                conversion.transientDownload = publication.transientDownload;
                conversion.doNotPersistDownloadUrl = publication.doNotPersistDownloadUrl;
              }
              assert.equal((await config.hooks.onPreToolUse({ toolName: "get_local_artifact_reference", toolArgs: {}, sessionId: "unattributed-worker" }))?.permissionDecision, "deny");
              if (docx.download) {
                assert.equal(docx.transientDownload, true);
                assert.equal(docx.doNotPersistDownloadUrl, true);
                assert.match(docx.download.downloadUrl, /^https:\/\/capsulestore\.blob\.core\.windows\.net\//);
                await config.fileSystem.appendFile(`/sessions/${config.sessionId}/events.jsonl`,
                  JSON.stringify({ transientToolReply: [docx.download, png.download] }) + "\n");
              }
              await call("execute_local_specialist", { operation: "graphviz-to-png", inputPath: "docs/diagram.dot", outputPath: prefix + "diagram.png" }, false);
              await call("submit_artifact", { content: `# Actual Text Report\n\nDOCX: ${docx.receipt.outputPath}; SHA-256 ${docx.receipt.sha256}.\nPNG: ${png.receipt.outputPath}; SHA-256 ${png.receipt.sha256}.\nThe two binary results were stored by the trusted parent sink; this Markdown report remains the primary artifact.\n${docx.download ? `Do not persist this transient URL: ${docx.download.downloadUrl}\n` : ""}` });
              await call("finish_stage", { status: "complete", readiness: "ready", summary: `Text report plus trusted binary receipts stored.${png.download ? " Transient URL: " + png.download.downloadUrl : ""}`, evidenceIds: [] });
              return { data: { content: "Local conversion report completed." } };
            }
            if (!review && pause === "child" && !resumeId) {
              const receipt = await call("submit_artifact", { content: "# Partial Findings\n\nAwaiting exact publication confirmation.\n" });
              nativePrimary = /Saved ([^\s]+)/.exec(receipt)![1];
              await call("request_human_input", { question: humanQuestion, reason: humanReason }, false);
              return { data: { content: "held" } };
            }
            if (!review && pause === "child" && resumeId) {
              const response = JSON.parse(await call("request_human_input", { question: humanQuestion, reason: humanReason }));
              seen.answered.push(response.answer);
              await config.fileSystem.readFile("/workspace/" + nativePrimary);
            }
            let evidence = "";
            if (review) {
              if (pause === "local") {
                const report = f.store.files.get(ownerPath)!.content;
                const binaryPath = /DOCX: ([^;]+);/.exec(report)![1];
                await call("get_local_artifact_reference", { path: binaryPath }, false);
              }
              const content = await config.fileSystem.readFile("/workspace/" + ownerPath);
              const post = await config.hooks.onPostToolUse({ toolName: "view", toolArgs: { path: "/workspace/" + ownerPath },
                sessionId: config.sessionId, toolResult: { resultType: "success", textResultForLlm: content } });
              evidence = /receipt (E\d+)/.exec(post?.additionalContext ?? "")?.[1] ?? "";
              assert.ok(evidence);
            }
            await call("submit_artifact", { content: evidence ? `# Independent Review\n\nVerdict: ${pause === "escalation" && !correctionExecuted ? "Fail" : "Pass"}\n\nRead exact report. ${evidence}\n` : "# Project Findings\n\nActual bounded report, no cloud/tracker approval implied.\n" });
            await call("finish_stage", { status: "complete", readiness: "ready", summary: "Bounded artifact stored.", evidenceIds: evidence ? [evidence] : [] });
          }
          return { data: { content: "completed" } };
        },
        async abort() {},
        async disconnect() { if (coordinator) seen.disconnected = true; },
        runServerCommand: coordinator ? async (command: string) => {
          assert.equal(seen.disconnected, false, "trusted RPC remains alive for final usage flush");
          return port.runServerCommand(command);
        } : specialistPort ? (command: string) => specialistPort.runServerCommand(command) : undefined,
      };
  };
  f.options.client = {
    createSession: config => open(config),
    resumeSession: (sessionId, config) => open(config, sessionId),
  };
  return { configs, seen, ownerPath: () => ownerPath, ownerStageId: () => ownerStageId };
}

test("final runtime billing projection includes post-finish coordinator charges and exact run acceptance", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), port = new LocalProcedurePort(scratch);
  const records: import("../src/engine/model-backend.js").CompletionUsageRecord[] = [];
  f.options.onCompletion = async record => { records.push({ ...record, runId: f.options.runId }); };
  f.options.readCompletionUsage = async () => structuredClone(records);
  f.options.maxProcedureCalls = 100;
  f.options.deadlineMs = 300000;
  installLiveClient(f, port);
  try {
    const outcome = await executeRun(f.options, "Produce and independently review a bounded advisory report.");
    assert.equal(outcome.status, "complete", outcome.status === "failed" ? outcome.detail : outcome.status);
    if (outcome.status !== "complete") throw new Error("complete");
    const billing = outcome.result.metadata.runBilling!;
    assert.equal(billing.billingStatus, "complete");
    assert.ok(Math.abs(billing.hostBilledCredits! - 0.31) < 1e-12,
      "owner, reviewer, initial coordinator and post-finish coordinator charges counted once");
    assert.equal(billing.completionCount, 4);
    assert.equal(billing.historyEntryIds.length, 2);
    assert.equal(billing.accepted, 1);
    assert.equal(billing.hostBilledCreditsPerAccepted, billing.hostBilledCredits);
    assert.equal(billing.verifiedReview?.verdict, "Pass");
    const persisted = JSON.parse(f.store.files.get(`${ROOT}/runtime-billing/run-a.json`)!.content);
    assert.equal(persisted.sourceSha256, billing.sourceSha256);
    assert.equal(persisted.eventsJsonl, undefined);
    const ledger = f.store.files.get(`${ROOT}/consumption.md`)!.content;
    assert.equal((ledger.match(/^## Run-scoped SDK billing & value$/gm) ?? []).length, 1);
    assert.match(ledger, /## Unit Economics \(value\)/);
    assert.equal(ledger.includes("session.usage_checkpoint"), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

for (const routing of [
  { mode: "ranked" }, { mode: "economy" }, { mode: "manual", model: "gpt-5.4" },
] satisfies UpstreamRoutingSelection[]) {
  test(`real upstream scripts and executor preserve user-selected ${routing.mode} routing through final review`, { skip: !pwshAvailable }, async () => {
    const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
    mkdirSync(scratch);
    const f = fixture(), port = new LocalProcedurePort(scratch);
    port.cacheMeasurements = true;
    f.options.confirmInitialization = async proposal => ({
      confirmed: true, profile: proposal.profile, routing, routingAccepted: true,
      naming: "skip", approvalChannel: "in-chat", actor: "actual-user",
    });
    const live = installLiveClient(f, port);
    try {
      const outcome = await executeRun(f.options, "Produce a bounded report with independent review.");
      assert.equal(outcome.status, "complete", outcome.status === "failed" ? outcome.detail : outcome.status);
      if (outcome.status !== "complete") throw new Error("complete");
      assert.equal(outcome.result.metadata.routing, routing.mode);
      for (const script of port.scripts.filter(script =>
        ["Initialize-SquadConsumptionRates", "Resolve-SquadModelRoute"].includes(script.name))) {
        assert.equal(script.args.Mode, routing.mode);
      }
      assert.equal(port.scripts.filter(script => script.name === "Initialize-SquadConsumptionRates").length,
        routing.mode === "economy" ? 1 : 0, "The pinned seeder refuses other modes; never pretend it ran.");
      assert.ok(outcome.result.metadata.events.some(event => event.procedure === "Initialize-SquadConsumptionRates" &&
        event.execution === (routing.mode === "economy" ? "pinned-script" : "native-scribe")));
      if (routing.mode !== "economy") {
        assert.ok(port.scripts.every(script => !["Get-SquadDispatchBrief", "Write-SquadHandoff", "Set-SquadCostPreflight"].includes(script.name)));
      }
      for (const trace of [...f.store.files.values()].filter(file => file.path.endsWith(".sources.json"))) {
        const source = JSON.parse(trace.content);
        assert.equal(source.routing, routing.mode);
        assert.ok(source.modelRoute.model);
        if (routing.mode === "manual") assert.equal(source.modelRoute.model, routing.model);
      }
      if (routing.mode === "manual") assert.ok(live.configs.every(config => config.model === routing.model));
      assert.ok(live.configs.every(config => !config.availableTools.some(tool =>
        ["builtin:bash", "builtin:glob", "builtin:grep", "builtin:web_fetch"].includes(tool))));
      assert.equal(outcome.result.metadata.verification.verdict, "Pass");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
test("Init held response resumes into real executor/scripts without replaying initialization confirmation", { skip: !pwshAvailable }, async t => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const port = new LocalProcedurePort(scratch), f = fixture();
  const live = installLiveClient(f, port);
  try {
    f.options.initialRequest = "Create a bounded report and independently review it.";
    f.options.confirmInitialization = undefined;
    await assert.rejects(createUpstreamRuntime(f.options), (error: unknown) => error instanceof StageInputRequired);
    const held = f.checkpoints.at(-1)!;
    assert.equal(held.resumable, true);
    const claimed = new Set<string>();
    f.options.continuation.checkpoint = held;
    f.options.continuation.response = { operationId: held.pendingOperation.operationId, responseId: "init-response", answer: "Proceed with exactly the stated Init settings.", respondedBy: "actual-user", respondedAt: Date.now(),
      initialization: { confirmed: true, profile: "default", economyAccepted: true, naming: "skip", approvalChannel: "in-chat", actor: "actual-user" } };
    f.options.continuation.acceptResponse = async id => { if (claimed.has(id)) return false; claimed.add(id); return true; };
    f.options.confirmInitialization = async () => { throw new Error("Confirmation callback must not replay."); };
    const completed = await executeRun(f.options, "Create a bounded report and independently review it.");
    assert.equal(completed.status, "complete", completed.status === "failed" ? completed.detail : completed.status);
    if (completed.status !== "complete") throw new Error("complete");
    const result = completed.result;
    assert.equal(result.metadata.ownsLedger, true);
    assert.equal(result.metadata.outcome, "accepted");
    assert.equal(live.seen.disconnected, true);
    assert.equal(result.stages.length, 2);
    assert.equal(result.metadata.verification.readHashes[0].path, live.ownerPath());
    const history = f.store.files.get(`${ROOT}/history/Squad-Implementor.md`)!.content;
    assert.match(history, /# History: Squad Implementor/);
    assert.ok(history.includes(live.ownerStageId()));
    assert.match(history, /"model_source": "dispatch-reported"/);
    assert.match(history, /"input_tokens": 90/);
    assert.match(history, /#### Consumption/);
    const scribe = f.store.files.get(`${ROOT}/history/Squad-Scribe.md`)!.content;
    assert.match(scribe, /#### Consumption — Orchestration/);
    assert.match(scribe, /"input_tokens": 9/);
    const handoffs = port.scripts.filter(p => p.name === "Write-SquadHandoff");
    assert.equal(handoffs.length, 3);
    const firstPayload = JSON.parse(handoffs[0].args.PayloadJson as string);
    assert.deepEqual(Object.keys(firstPayload), ["runId", "handoff", "historyRecords", "orchestration", "stateAdvance"]);
    assert.equal(firstPayload.stateAdvance.sessionModel, f.options.coordinatorModel);
    assert.equal(firstPayload.historyRecords[0].consumption.input_tokens, 90);
    assert.equal(result.usage?.estimatedCostUsd, undefined);
    assert.equal(f.store.writes.some(p => /history\/(?:squad-implementor|runs\/)/.test(p)), false);
    assert.ok(live.configs[0].availableTools.every(name => name.startsWith("custom:")));
    assert.equal(f.checkpoints.some(c => c.phase === "accepted" && c.acceptedAnswers[0]?.responseId === "init-response"), true);
    const writes = f.store.writes.length;
    await assert.rejects(createUpstreamRuntime(f.options), /already consumed|lease conflicted|already executed/);
    assert.equal(f.store.writes.length, writes);
    const priorState = JSON.parse(f.store.files.get(`${ROOT}/state.json`)!.content);
    const priorRoster = f.store.files.get(`${ROOT}/team.md`)!;
    const priorBinding = f.store.files.get(`${ROOT}/runtime-binding.json`)!;
    f.options.runId = "run-b";
    f.options.date = "2026-10-11";
    f.options.continuation = { save: async checkpoint => { f.checkpoints.push(checkpoint); } };
    const next = await executeRun(f.options, "Second independent report on the same upstream project.");
    assert.equal(next.status, "complete", next.status === "failed" ? next.detail : next.status);
    if (next.status !== "complete") throw new Error("second complete");
    assert.equal(f.store.files.get(`${ROOT}/team.md`)!.etag, priorRoster.etag, "existing roster is not reseeded");
    assert.equal(f.store.files.get(`${ROOT}/runtime-binding.json`)!.etag, priorBinding.etag, "existing schema binding is unchanged");
    assert.ok(JSON.parse(f.store.files.get(`${ROOT}/state.json`)!.content).turn > priorState.turn, "state advances rather than resetting");
    const combinedHistory = f.store.files.get(`${ROOT}/history/Squad-Implementor.md`)!.content;
    assert.equal((combinedHistory.match(/^### /gm) ?? []).length, 2);
    assert.equal(JSON.parse(f.store.files.get(`${ROOT}/runtime-turns/run-a.json`)!.content).status, "complete");
    assert.equal(JSON.parse(f.store.files.get(`${ROOT}/runtime-turns/run-b.json`)!.content).status, "complete");
    const after = f.store.writes.length;
    const duplicate = await executeRun(f.options, "Second independent report on the same upstream project.");
    assert.equal(duplicate.status, "failed");
    if (duplicate.status === "failed") assert.equal(duplicate.reason, "turn_already_executed");
    assert.equal(f.store.writes.length, after);
    t.diagnostic(`Executed ${port.scripts.length} genuine pinned scripts via isolated PowerShell; Linux RPC transport remains independently tested.`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("handoff payload supplies all required upstream fields rather than native history records", () => {
  const payload = upstreamStageHandoff(undefined, { runId: "r", project: "project-a", model: "gpt-5.4", availableModels: models, stages: [], signal: new AbortController().signal }, {
    model: "gpt-5.4", model_source: "dispatch-reported", priced_as: "gpt-5.4", model_tier: "default",
    internal_turns: 1, input_tokens: 10, cached_tokens: 2, cache_write_tokens: 0, output_tokens: 4, basis: "estimated",
  });
  assert.equal(payload.script, "Write-SquadHandoff");
  assert.deepEqual(payload.args.payload.stateAdvance, { activeRoles: [], sessionModel: "gpt-5.4" });
});

for (const pause of ["coordinator", "child"] as const) {
  test(`${pause} human hold resumes exact SDK operation without duplicating completed stages or history transactions`, { skip: !pwshAvailable }, async t => {
    const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
    mkdirSync(scratch);
    const port = new LocalProcedurePort(scratch), f = fixture();
    const live = installLiveClient(f, port, pause);
    const originalRequest = "Create a bounded report and independently review it.";
    try {
      const initial = await createUpstreamRuntime(f.options);
      assert.equal(initial.selection, "upstream");
      if (initial.selection !== "upstream") throw new Error("selection");
      await assert.rejects(initial.run(originalRequest), (error: unknown) => error instanceof StageInputRequired);
      const held = f.checkpoints.at(-1)!;
      assert.equal(held.resumable, true);
      assert.equal(held.pendingOperation.kind, pause === "child" ? "child-human" : "coordinator-human");
      assert.equal(held.request, originalRequest);
      assert.ok(held.sessionId);
      assert.ok(held.coordinator?.pendingTool);
      assert.equal(held.completedStages.length, pause === "child" ? 0 : 2);
      if (pause === "child") {
        assert.ok(held.pendingStage?.stageId);
        assert.ok(held.childSessionId);
        assert.equal(held.childUsage?.inputTokens, 100);
        assert.equal(held.coordinator?.pendingStageObservedAttempts, 1);
      } else {
        assert.equal(held.historyTransactions.length, 2);
        assert.ok(held.storageReceipts.some(r => r.path.endsWith(".sources.json")));
        assert.equal(held.coordinator?.completedDelegations.length, 2);
      }
      const resumedPort = f.options.client.resumeSession;
      f.options.continuation.checkpoint = held;
      f.options.client.resumeSession = undefined;
      await assert.rejects(createUpstreamRuntime(f.options), /SDK state is missing/);
      f.options.client.resumeSession = resumedPort;
      if (pause === "coordinator") {
        const receipt = held.storageReceipts.find(r => r.path === live.ownerPath())!;
        const original = f.store.files.get(receipt.path)!;
        f.store.files.set(receipt.path, { ...original, content: original.content + "Modified after review.\n" });
        await assert.rejects(createUpstreamRuntime(f.options), /changed after the hold/);
        f.store.files.set(receipt.path, original);
      }
      const consumed = new Set<string>();
      f.options.continuation.acceptResponse = async checkpointId => {
        if (consumed.has(checkpointId)) return false;
        consumed.add(checkpointId);
        return true;
      };
      f.options.continuation.response = {
        operationId: held.pendingOperation.operationId, responseId: `${pause}-response`,
        answer: "Publish only the scoped report; no cloud or tracker changes approved.",
        respondedBy: "actual-user", respondedAt: Date.now(),
      };
      f.options.confirmInitialization = async () => { throw new Error("Init must not be repeated."); };
      f.options.requestHumanInput = async () => { throw new Error("The exact accepted question must not be asked again."); };
      const resumed = await createUpstreamRuntime(f.options);
      assert.equal(resumed.selection, "upstream");
      if (resumed.selection !== "upstream") throw new Error("selection");
      const result = await resumed.run(originalRequest);
      assert.equal(result.metadata.outcome, "accepted");
      assert.equal(result.stages.length, 2);
      assert.deepEqual(live.seen.answered, [f.options.continuation.response.answer]);
      assert.equal(live.seen.createdChildren.length, 2, "only one original owner and one original reviewer");
      assert.equal(live.seen.resumes.length, pause === "child" ? 2 : 1);
      assert.equal(live.seen.resumes[0], held.sessionId);
      if (pause === "child") {
        assert.equal(live.seen.resumes[1], held.childSessionId);
        assert.equal(result.stages[0].request.stageId, held.pendingStage!.stageId);
        assert.equal(result.stages[0].result.usage?.inputTokens, 200, "observed pre-hold and resumed invocation usage preserved");
      } else {
        assert.deepEqual(result.stages.map(s => s.request.stageId), held.completedStages.map(s => s.request.stageId));
      }
      const ownerHistory = f.store.files.get(`${ROOT}/history/Squad-Implementor.md`)!.content;
      const reviewHistory = f.store.files.get(`${ROOT}/history/Squad-Reviewer.md`)!.content;
      assert.equal((ownerHistory.match(/^### /gm) ?? []).length, 1);
      assert.equal((reviewHistory.match(/^### /gm) ?? []).length, 1);
      assert.equal(port.scripts.filter(p => p.name === "Initialize-SquadConsumptionRates").length, 1);
      assert.equal(f.checkpoints.some(c => c.phase === "accepted" && c.acceptedAnswers.at(-1)?.responseId === `${pause}-response`), true);
      assert.equal(result.metadata.verification.readHashes.some(r => r.path === live.ownerPath()), true);
      assert.equal(result.usage?.estimatedCostUsd, undefined);
      const before = f.store.writes.length;
      await assert.rejects(createUpstreamRuntime(f.options), /changed after the hold|already consumed|already executed/);
      assert.equal(f.store.writes.length, before);
      t.diagnostic(`${pause}: reused coordinator ${held.sessionId}; ${port.scripts.length} actual pinned script invocations, no duplicate role history.`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}

test("held Init answers require exact operation identity and an atomic response-consumption seam", async () => {
  const f = fixture();
  f.options.confirmInitialization = undefined;
  await assert.rejects(createUpstreamRuntime(f.options), (error: unknown) => error instanceof StageInputRequired);
  const held = f.checkpoints.at(-1)!;
  f.options.continuation.checkpoint = held;
  f.options.continuation.response = { operationId: "wrong-operation", responseId: "r", answer: "yes", respondedBy: "user", respondedAt: Date.now() };
  await assert.rejects(createUpstreamRuntime(f.options), /exact held operation/);
  f.options.continuation.response.operationId = held.pendingOperation.operationId;
  await assert.rejects(createUpstreamRuntime(f.options), /Atomic held-run response consumption/);
  assert.equal(f.store.writes.length, 0);
});

test("executeRun returns real bounded native, held and failed statuses for parent worker wiring", async () => {
  const native = fixture();
  await native.store.put("tenant-a", "project-a", `${ROOT}/state.json`, '{"schemaVersion":"native"}');
  const nativeWrites = native.store.writes.length;
  assert.deepEqual(await executeRun(native.options, "Preserve existing native project."), {
    status: "native", ownsLedger: false, reason: "existing-native-project",
  });
  assert.equal(native.store.writes.length, nativeWrites);
  const disabled = fixture(); disabled.options.enabled = false;
  assert.equal((await executeRun(disabled.options, "Disabled upstream run.")).status, "not-selected");
  const f = fixture();
  f.options.confirmInitialization = undefined;
  const request = "Original user project goal.";
  const held = await executeRun(f.options, request);
  assert.equal(held.status, "held");
  if (held.status !== "held") throw new Error("held");
  assert.equal(held.resumable, true);
  assert.equal(held.checkpoint.request, request);
  assert.equal(held.input.questionId, held.checkpoint.pendingOperation.operationId);
  assert.equal(f.store.writes.length, 0, "no synthetic Init acceptance");
  f.options.continuation.checkpoint = held.checkpoint;
  f.options.continuation.response = { operationId: "wrong-op", responseId: "r", answer: "yes", respondedBy: "user", respondedAt: Date.now() };
  const refused = await executeRun(f.options, request);
  assert.equal(refused.status, "failed");
  if (refused.status !== "failed") throw new Error("failed");
  assert.equal(refused.reason, "continuation_response");
  assert.equal(refused.stages.length, 0);
  const broken = fixture(); broken.options.confirmInitialization = undefined;
  broken.options.continuation.save = async () => { throw new Error("Durable storage unavailable."); };
  assert.equal((await executeRun(broken.options, request)).status, "failed");
});

test("core RPI prerequisites use exact upstream helper identities, not generic delegation or automatic critique skip", () => {
  assert.equal(UPSTREAM_CORE_HELPERS.researcher.agent, "RPI Researcher");
  assert.equal(UPSTREAM_CORE_HELPERS.researcher.readOnly, true, "actual pinned worker forbids writes; server records suggestions");
  assert.equal(UPSTREAM_CORE_HELPERS.lead.agent, "Squad Challenger");
  assert.equal(UPSTREAM_CORE_HELPERS.lead.defaultCritique, "standard");
  assert.ok(UPSTREAM_RUNTIME_EVIDENCE_MATRIX.some(e => e.surface === "core RPI research/planning" && !e.live));
});

test("required unavailable child skill script halts rather than retrying shell or fabricating completion", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), port = new LocalProcedurePort(scratch);
  const live = installLiveClient(f, port, "capability");
  try {
    const result = await executeRun(f.options, "Run a required unavailable skill script.");
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("failed");
    assert.match(result.detail, /capability is not wired/);
    assert.equal(result.stages.length, 0);
    assert.equal(live.seen.createdChildren.length, 1);
    assert.equal(port.scripts.some(p => p.name === "Write-SquadHandoff"), false, "no successful role history was fabricated");
    assert.equal(live.configs.some(c => c.availableTools.includes("builtin:bash")), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("actual fixed RPI Researcher SDK helper is read-only, validates lane contract and returns only read-source suggestions", async () => {
  const f = fixture(), parentPath = ".copilot-tracking/research/2026-10-10/parent-research.md";
  await f.store.put("tenant-a", "project-a", parentPath, "# Primary Research\nScope: actual supplied evidence.");
  await f.store.put("tenant-a", "project-a", "docs/input.md", "Exact documented contract: refresh weekly.");
  let calls = 0, turns = 0;
  const client: UpstreamRuntimeOptions["client"] = {
    async createSession(config) {
      calls++;
      assert.match(config.systemMessage.content, /name: RPI Researcher/);
      assert.match(config.systemMessage.content, /Do not create, edit, move, or delete/);
      assert.ok(config.availableTools.every(t => t.startsWith("custom:")));
      assert.equal(config.onPermissionRequest({ kind: "shell" }).kind, "reject");
      assert.equal((await config.hooks.onPreToolUse({ toolName: "task", toolArgs: {}, sessionId: config.sessionId }))?.permissionDecision, "deny");
      let listener: ((event: CopilotSessionEvent) => void) | undefined;
      return {
        on(handler) { listener = handler; return () => undefined; },
        async sendAndWait(input) {
          if (++turns === 1) {
            listener?.({ type: "assistant.usage", data: { model: config.model, inputTokens: 1, outputTokens: 1 } });
            return { data: { content: "Prose without a structured finish is not an accepted result." } };
          }
          assert.match(input.prompt, /No finish_research_lane receipt was accepted/);
          listener?.({ type: "assistant.usage", data: { model: config.model, inputTokens: 20, outputTokens: 10 } });
          const read = config.tools.find(t => t.name === "read_source")!;
          assert.equal((await read.handler({ kind: "project", target: "docs/not-permitted.md" })).resultType, "failure");
          const result = await read.handler({ kind: "project", target: "docs/input.md" });
          assert.equal(result.resultType, "success");
          const source = JSON.parse(result.textResultForLlm);
          const finish = config.tools.find(t => t.name === "finish_research_lane")!;
          const returnContract = {
            status: "Complete", summary: "One bounded source gathered.",
            sources: [{ receiptId: source.receiptId, location: "docs/input.md", description: "Actual source bytes.",
              relevance: "Documents the requested contract.", exactMaterial: "Fabricated material." }],
            gaps: "None", stopReason: "Source covered.",
          };
          assert.equal((await finish.handler(returnContract)).resultType, "failure", "verbatim material must be present in the actual source");
          returnContract.sources[0].exactMaterial = "refresh weekly";
          assert.equal((await finish.handler(returnContract)).resultType, "success");
          return { data: { content: "No file edits by the actual read-only worker." } };
        },
        async abort() {}, async disconnect() {},
      };
    },
  };
  const request = {
    kind: "research-lane" as const, helperId: "lane-one", parentPath, parentSha256: hash(f.store.files.get(parentPath)!.content),
    outputPath: ".copilot-tracking/research/2026-10-10/subagents/lane-one.md", cycle: 1, wave: "Wider" as const,
    laneType: "internal" as const, posture: "focused", laneId: "one", task: "Locate the documented refresh contract.",
    requirements: "Exact source material with pointers.", scope: "Only docs/input.md.", nonGoals: "No conclusions or edits.",
    sources: [{ kind: "project" as const, target: "docs/input.md" }],
  };
  const options = {
    client, bundle, store: f.store, sessionState: f.options.sessionState, tenantId: "tenant-a", project: "project-a", runId: "run-a",
    model: "gpt-5.4", maxModelCalls: 3, deadlineAt: Date.now() + 30000, signal: new AbortController().signal,
  };
  await assert.rejects(runUpstreamCoreHelper(options, { ...request, parentSha256: "0".repeat(64) }), /actual parent primary/);
  await assert.rejects(runUpstreamCoreHelper(options, { ...request, outputPath: "docs/lane-one.md" }), /exact server-derived/);
  assert.equal(calls, 0, "invalid lane inputs never open a model session");
  const result = await runUpstreamCoreHelper(options, request);
  assert.equal(result.receipt.agent, "RPI Researcher");
  assert.equal(result.receipt.status, "Complete");
  assert.equal(result.sources[0].sha256, hash("Exact documented contract: refresh weekly."));
  assert.match(f.store.files.get(request.outputPath)!.content, /Unverified Source Suggestions/);
  assert.match(f.store.files.get(request.outputPath)!.content, /calling Researcher must independently/);
  assert.equal(turns, 2, "missing finish is continued in the same session, without replaying reads or inventing acceptance");
  assert.equal(calls, 1);
  assert.equal(result.receipt.usage?.inputTokens, 21);
  assert.equal(result.receipt.usage?.estimatedCostUsd, undefined);
});

test("actual pinned Squad Challenger plan critique must independently read the entire supplied boundary and cannot edit the plan", async () => {
  const f = fixture(), parentPath = ".copilot-tracking/plans/2026-10-10/plan.md";
  const plan = "# Plan\nP01-T01: produce an advisory report.\n".padEnd(5999, "x") +
    "\uD83D\uDE00" + "Required plan detail.\n".repeat(1200);
  await f.store.put("tenant-a", "project-a", parentPath, plan);
  await f.store.put("tenant-a", "project-a", "docs/input.md", "The source demonstrates the requirement.");
  let sawMissingBoundary = false;
  const client: UpstreamRuntimeOptions["client"] = {
    async createSession(config) {
      assert.match(config.systemMessage.content, /name: Squad Challenger/);
      assert.match(config.systemMessage.content, /# RPI Plan Critique/);
      let listener: ((event: CopilotSessionEvent) => void) | undefined;
      return {
        on(handler) { listener = handler; return () => undefined; },
        async sendAndWait() {
          listener?.({ type: "assistant.usage", data: { model: config.model, inputTokens: 30, outputTokens: 11 } });
          await assert.rejects(config.fileSystem.writeFile("/workspace/" + parentPath, "Plan changed by critique"), /scope|EACCES/);
          const read = config.tools.find(t => t.name === "read_source")!;
          const first = JSON.parse((await read.handler({ kind: "project", target: parentPath })).textResultForLlm);
          assert.equal(first.content.length, 5999);
          assert.equal(first.fullyRead, false);
          assert.equal((await read.handler({ kind: "project", target: parentPath, offset: 6000 })).resultType, "failure");
          assert.equal((await read.handler({ kind: "project", target: parentPath, offset: 5999, maxCharacters: 1 })).resultType, "failure");
          await config.tools.find(t => t.name === "submit_plan_critique")!.handler({ content: "# Independent Critique\nExecution: Complete\nVerdict: Pass\n" });
          const finish = config.tools.find(t => t.name === "finish_plan_critique")!;
          sawMissingBoundary = (await finish.handler({ status: "Complete", reviewOutcome: "Pass" })).resultType === "failure";
          await config.tools.find(t => t.name === "read_source")!.handler({ kind: "project", target: "docs/input.md" });
          assert.equal((await finish.handler({ status: "Complete", reviewOutcome: "Pass" })).resultType, "failure",
            "A preview of every source is not full critique coverage.");
          let offset = first.nextOffset;
          let reconstructed = first.content;
          while (offset < plan.length) {
            const part = JSON.parse((await read.handler({ kind: "project", target: parentPath, offset })).textResultForLlm);
            assert.equal(part.sha256, hash(plan));
            assert.ok(part.content.length <= 6000);
            reconstructed += part.content;
            offset = part.nextOffset;
          }
          assert.equal(reconstructed, plan);
          assert.equal((await finish.handler({ status: "Complete", reviewOutcome: "Pass" })).resultType, "success");
          return { data: { content: "Critique completed." } };
        },
        async abort() {}, async disconnect() {},
      };
    },
  };
  const result = await runUpstreamCoreHelper({
    client, bundle, store: f.store, sessionState: f.options.sessionState, tenantId: "tenant-a", project: "project-a", runId: "run-a",
    model: "gpt-5.4", maxModelCalls: 3, deadlineAt: Date.now() + 30000, signal: new AbortController().signal,
  }, {
    kind: "plan-critique", helperId: "critique-one", parentPath, parentSha256: hash(plan),
    outputPath: ".copilot-tracking/reviews/2026-10-10/critique-one.md", depth: "standard",
    task: "Assess the exact plan.", requirements: "Evidence-grounded advisory report.", scope: "Supplied boundary only.",
    nonGoals: "Do not write the plan or search outside the supplied inputs.", decisions: "Advisory only.",
    dependencies: "Documented source.", sources: [{ kind: "project", target: "docs/input.md" }],
  });
  assert.equal(sawMissingBoundary, true);
  assert.equal(result.receipt.verdict, "Pass");
  assert.equal(f.store.files.get(parentPath)!.content, plan);
  assert.ok(result.receipt.readHashes.some(r => r.path === parentPath && r.sha256 === hash(plan)));
});

test("Scribe-owned ranked Model-cell refresh preserves every other roster byte and detects CAS conflicts", async () => {
  const f = fixture(), available = [...models, "claude-fable-5.1"];
  f.options.modelIds = available;
  const proposal = prepareUpstreamRoster(bundle, "default", "2026-10-10", available);
  const teamPath = `${ROOT}/team.md`;
  await f.store.put("tenant-a", "project-a", teamPath, proposal.teamMarkdown);
  await f.store.put("tenant-a", "project-a", `${ROOT}/decisions.md`, "# Existing Decisions\n");
  const developer = proposal.roster.find(r => r.role === "developer")!;
  const catalog = readUpstreamContract(bundle, ".github/skills/squad/references/model-catalog.md");
  const routing = readUpstreamContract(bundle, ".github/skills/squad/references/model-routing.md");
  const { selectUpstreamEconomyRoute } = await import("../src/engine/copilot/upstream-coordinator.js");
  const pick = selectUpstreamEconomyRoute(catalog, routing, developer.role, developer.floor, available);
  assert.notEqual(pick.model, pick.rankedModel);
  const result = await refreshUpstreamRankedModel(f.options, bundle, { role: developer.role, agent: developer.agent, model: pick.rankedModel });
  assert.equal(result.owner, "Squad Scribe");
  assert.equal(result.atomic, false);
  const updated = f.store.files.get(teamPath)!.content;
  const originalRow = proposal.teamMarkdown.split("\n").find(l => /^\| developer \|/.test(l))!;
  const changedRow = updated.split("\n").find(l => /^\| developer \|/.test(l))!;
  assert.equal(updated.replace(changedRow, originalRow), proposal.teamMarkdown, "all other roster bytes preserved");
  assert.match(f.store.files.get(`${ROOT}/decisions.md`)!.content, /Owner: Squad Scribe/);
  const writes = f.store.writes.length;
  await refreshUpstreamRankedModel(f.options, bundle, { role: developer.role, agent: developer.agent, model: pick.rankedModel });
  assert.equal(f.store.writes.length, writes, "repeated same refresh is idempotent");
  f.store.conflictPath = teamPath;
  await assert.rejects(refreshUpstreamRankedModel(f.options, bundle, { role: developer.role, agent: developer.agent, model: pick.model, route: "economy" }), /CAS lost/);
  assert.equal(f.store.files.get(teamPath)!.content, updated);
  await assert.rejects(refreshUpstreamRankedModel(f.options, bundle, { role: developer.role, agent: "generic-task", model: pick.model }), /Exact original roster/);
});

test("genuine core Researcher and Lead paths execute named SDK helpers, independent source verification and actual scripted histories", { skip: !pwshAvailable }, async t => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), port = new LocalProcedurePort(scratch);
  const completions: import("../src/engine/model-backend.js").CompletionUsageRecord[] = [];
  f.options.onCompletion = async record => { completions.push({ ...record, runId: f.options.runId }); };
  await f.store.put("tenant-a", "project-a", "docs/input.md", "# Actual Source\nThe documented feature is refreshed weekly.\n");
  const live = installLiveClient(f, port, "core");
  try {
    const result = await executeRun(f.options, "Research, plan and implement a bounded advisory report from the supplied document.");
    assert.equal(result.status, "complete", result.status === "failed" ? result.detail : result.status);
    if (result.status !== "complete") throw new Error("complete");
    assert.deepEqual(result.result.stages.map(s => s.request.role), ["researcher", "lead", "developer", "tester"]);
    assert.deepEqual(result.result.metadata.coreHelpers?.map(h => h.agent), ["RPI Researcher", "RPI Researcher", "RPI Researcher", "Squad Challenger"]);
    assert.equal(live.configs.filter(c => c.sessionId.startsWith("core-")).length, 4);
    const research = f.store.files.get(`${ROOT}/history/Squad-Researcher.md`)!.content;
    const lead = f.store.files.get(`${ROOT}/history/Squad-Lead.md`)!.content;
    assert.equal((research.match(/^#### Consumption$/gm) ?? []).length, 4, "parent and three actual worker invocations attributed separately");
    assert.equal((lead.match(/^#### Consumption$/gm) ?? []).length, 2, "parent and actual independent critique both recorded");
    assert.match(research, /Fixed named RPI Researcher/);
    assert.match(lead, /Fixed named Squad Challenger/);
    const plan = result.result.stages.find(s => s.request.role === "lead")!.artifacts[0].path;
    assert.match(f.store.files.get(plan)!.content, /Execution: Complete/);
    assert.match(f.store.files.get(plan)!.content, /fixed named Squad Challenger/);
    assert.match(f.store.files.get(plan)!.content, /#### \[x\] P01-T01/);
    assert.match(f.store.files.get(plan)!.content, /### \[x\] P01/);
    assert.equal(result.result.stages.find(s => s.request.role === "developer")!.retainedUpdates?.[0].path, plan);
    assert.equal(result.result.metadata.verification.verdict, "Pass");
    assert.equal(result.result.usage?.estimatedCostUsd, undefined);
    assert.equal(result.result.usage?.billingStatus, "complete");
    assert.ok(Math.abs(result.result.usage!.hostBilledCredits! - 0.91) < 1e-12,
      "four parents, four fixed helpers, and two coordinator completions counted exactly once");
    assert.equal(completions.filter(record => record.actor === "RPI Researcher").length, 3);
    assert.equal(completions.filter(record => record.actor === "Squad Challenger").length, 1);
    assert.equal(completions.filter(record => record.actor === "Squad Coordinator").length, 2,
      "final provider usage after finish is retained");
    t.diagnostic("Actual fixed-name SDK handlers, immutable charters/skills, real project retrieval/hash checks and unchanged PowerShell handoff scripts executed; no live-model quality certification.");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("actual upstream Fail triggers Scribe-ranked exact original-owner correction and protected rereview, never accepted Fail", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), port = new LocalProcedurePort(scratch);
  f.options.modelIds = [...models, "claude-fable-5.1"];
  installLiveClient(f, port, "escalation");
  try {
    const result = await executeRun(f.options, "Produce a bounded advisory report; correct any failed review once.");
    assert.equal(result.status, "complete", result.status === "failed" ? result.detail : result.status);
    if (result.status !== "complete") throw new Error("complete");
    const stages = result.result.stages;
    assert.equal(stages.length, 4);
    assert.equal(stages[2].request.role, stages[0].request.role);
    assert.equal(stages[2].request.agent, stages[0].request.agent);
    assert.equal(stages[2].request.model, stages[0].request.rankedModel);
    assert.notEqual(stages[2].request.model, stages[0].request.model);
    assert.equal(stages[3].request.model, stages[1].request.model);
    assert.equal(result.result.metadata.verification.verdict, "Pass");
    assert.match(f.store.files.get(`${ROOT}/decisions.md`)!.content, /Economy Ranked Escalation/);
    assert.match(f.store.files.get(`${ROOT}/decisions.md`)!.content, /Owner: Squad Scribe/);
    assert.equal((f.store.files.get(`${ROOT}/history/Squad-Implementor.md`)!.content.match(/^### /gm) ?? []).length, 2);
    const table = f.store.files.get(`${ROOT}/team.md`)!.content;
    assert.ok(table.split("\n").some(l => l.startsWith("| developer |") && l.includes(stages[2].request.model)));
    assert.equal(result.result.usage?.estimatedCostUsd, undefined);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("local specialist tools are present by default and explicitly unavailable without a trusted factory", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), accountingPort = new LocalProcedurePort(scratch);
  await f.store.put("tenant-a", "project-a", "docs/input.md", "# Actual stored local input\n");
  const live = installLiveClient(f, accountingPort);
  const original = f.options.client.createSession;
  let observed = false;
  f.options.client.createSession = async config => {
    const session = await original(config);
    if (!config.sessionId.startsWith("upstream-")) {
      const send = session.sendAndWait.bind(session);
      session.sendAndWait = async (input, timeoutMs) => {
        const list = config.tools.find(t => t.name === "list_local_capabilities")!;
        const result = await list.handler({});
        assert.equal(result.resultType, "success");
        const caps = JSON.parse(result.textResultForLlm) as { reason: string; capabilities: LocalSpecialistCapability[] };
        assert.equal(caps.reason, "local-specialist-factory-unavailable");
        assert.ok(caps.capabilities.filter(c => c.id.endsWith("docx") || c.id.endsWith("png")).every(c => !c.callable && c.status === "unavailable"));
        assert.equal(caps.capabilities.find(c => c.id === "authenticated-per-user-bindings")?.status, "auth-deferred");
        assert.equal(caps.capabilities.find(c => c.id === "windows-desktop-automation")?.status, "windows-unsupported");
        assert.ok(config.availableTools.includes("custom:execute_local_specialist"));
        assert.ok(config.availableTools.includes("custom:get_local_artifact_reference"));
        const write = config.tools.find(t => t.name === "write_stage_text_artifact")!;
        const digest = config.tools.find(t => t.name === "hash_project_artifact")!;
        const digestResult = await digest.handler({ path: "docs/input.md" });
        assert.equal(digestResult.resultType, "success");
        assert.equal(JSON.parse(digestResult.textResultForLlm).sha256, hash("# Actual stored local input\n"));
        assert.equal(JSON.parse(digestResult.textResultForLlm).bytes, Buffer.byteLength("# Actual stored local input\n"));
        assert.equal((await digest.handler({ path: "docs/absent.md" })).resultType, "failure");
        assert.equal((await digest.handler({ path: "../../secret.md" })).resultType, "failure");
        const root = /canonical root ([^\s]+)\./.exec(write.description)![1];
        const written = await write.handler({ path: root + "diagram.dot", content: "digraph G { Browser -> MCP -> Sandbox; }" });
        assert.equal(written.resultType, "success");
        assert.equal(f.store.files.get(root + "diagram.dot")?.content, "digraph G { Browser -> MCP -> Sandbox; }");
        assert.equal((await write.handler({ path: root + "diagram.dot", content: "replacement" })).resultType, "failure",
          "Existing text needs its actual CAS ETag.");
        for (const path of ["docs/report.md", ROOT + "/state.json", root + "code.py", root + "report.md.sources.json"]) {
          assert.equal((await write.handler({ path, content: "outside scope" })).resultType, "failure");
        }
        const unavailableReference = await config.tools.find(t => t.name === "get_local_artifact_reference")!.handler({ path: "outputs/unrecorded.docx" });
        assert.equal(unavailableReference.resultType, "failure");
        const primary = /server publishes that output at ([^\s]+)\./.exec(config.systemMessage.content)![1];
        const outputPath = primary.slice(0, primary.lastIndexOf("/") + 1) + "unavailable.docx";
        const execution = await config.tools.find(t => t.name === "execute_local_specialist")!.handler({
          operation: "markdown-to-docx", inputPath: "docs/input.md", outputPath,
        });
        assert.equal(execution.resultType, "failure");
        assert.equal(JSON.parse(execution.textResultForLlm).code, "local_unavailable");
        assert.equal(f.store.files.has(outputPath), false);
        assert.equal((await config.hooks.onPreToolUse({ toolName: "list_local_capabilities", toolArgs: {}, sessionId: "unknown-delegate" }))?.permissionDecision, "deny");
        observed = true;
        return send(input, timeoutMs);
      };
    }
    return session;
  };
  try {
    const outcome = await executeRun(f.options, "Produce a safe text-only report; do not invent local binary outputs.");
    assert.equal(outcome.status, "complete", outcome.status === "failed" ? outcome.detail : outcome.status);
    assert.equal(observed, true);
    assert.equal(live.configs.some(c => c.availableTools.includes("builtin:bash")), false);
    if (outcome.status === "complete") assert.deepEqual(outcome.result.metadata.localSpecialists, []);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("real LocalSpecialists capsule binding executes only scoped DOCX/PNG operations, commits binary bytes via sink and records exact text-source traces", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), accountingPort = new LocalProcedurePort(scratch), localPort = new LocalTestPort();
  const binary: LocalBinaryArtifact[] = [];
  const links = new Map<string, LocalSpecialistDownloadReference>();
  const referenceRequests: string[] = [];
  const factoryStages: string[] = [];
  await f.store.put("tenant-a", "project-a", "docs/input.md", "# Actual Markdown\n\nA real stored project input.\n");
  await f.store.put("tenant-a", "project-a", "docs/diagram.dot", 'digraph G { a -> b; a [label="Actual project source"]; }');
  f.options.localSpecialistFactory = async context => {
    assert.equal(context.signal, context.request.signal);
    assert.equal(context.request.agent, "Squad Implementor");
    assert.equal(context.request.role, "developer");
    factoryStages.push(context.request.stageId);
    const prefix = context.request.writeScope.prefixes[0] + context.request.stageId + "/";
    await f.store.put("tenant-a", "project-a", prefix + "existing.docx", "Existing artifact must not be overwritten by a converter.");
    const runner = new LocalSpecialists({
      port: context.port, readTextArtifact: context.readTextArtifact,
      writeBinaryArtifact: async (artifact, receipt, control) => {
        assert.equal(control?.signal, context.signal);
        assert.equal(context.signal.aborted, false);
        assert.equal(hash(artifact.bytes), artifact.sha256);
        assert.equal(artifact.sha256, receipt.sha256);
        assert.equal(artifact.path, receipt.outputPath);
        assert.equal(artifact.bytes.length, receipt.byteLength);
        assert.ok(context.request.writeScope.prefixes.some(p => artifact.path.startsWith(p)));
        assert.equal(binary.some(old => old.path === artifact.path), false, "trusted sink is create-only");
        binary.push({ ...artifact, bytes: new Uint8Array(artifact.bytes) });
        const metadataPath = artifact.path + ".artifact.json";
        const blobPath = `specialists/tenant-a/project-a/run-a/${context.request.stageId}/${artifact.path.split("/").at(-1)}`;
        const expiresAt = new Date(Date.now() + 900000).toISOString();
        const query = new URLSearchParams({ sp: "r", sr: "b", se: expiresAt, sig: `local-sas-${receipt.operation}-must-not-persist` });
        const downloadUrl = "https://capsulestore.blob.core.windows.net/artifacts/" + blobPath + "?" + query;
        links.set(artifact.path, { metadataPath, downloadUrl, expiresAt });
        await f.store.put("tenant-a", "project-a", metadataPath, JSON.stringify({
          kind: "local-specialist-artifact", path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes.byteLength,
          mediaType: artifact.mediaType, blobPath, operation: receipt.operation, inputSha256: receipt.inputSha256,
        }));
      },
    });
    return runner;
  };
  f.options.getLocalArtifactReference = async (path, context) => {
    referenceRequests.push(path);
    assert.equal(context.request.role, "developer");
    assert.equal(context.signal, context.request.signal);
    const receipt = binary.find(a => a.path === path)!;
    assert.ok(receipt);
    return { ...links.get(path)!, sha256: receipt.sha256 };
  };
  const live = installLiveClient(f, accountingPort, "local", localPort);
  try {
    const outcome = await executeRun(f.options, "Produce a Markdown report plus scoped DOCX and diagram PNG derivatives.");
    assert.equal(outcome.status, "complete", outcome.status === "failed" ? outcome.detail : outcome.status);
    if (outcome.status !== "complete") throw new Error("complete");
    assert.equal(factoryStages.length, 1, "one server-bound adapter per acting stage");
    assert.equal(referenceRequests.length, 2, "unrecorded and cross-stage requests never reach the trusted signer");
    assert.equal(binary.length, 2);
    assert.deepEqual(binary.map(a => a.mediaType), ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "image/png"]);
    const owner = outcome.result.stages.find(s => s.request.role === "developer")!;
    const trace = outcome.result.metadata.localSpecialists!;
    assert.equal(trace.length, 1);
    assert.equal(trace[0].stageId, owner.request.stageId);
    assert.equal(trace[0].role, "developer");
    assert.equal(trace[0].agent, "Squad Implementor");
    assert.equal(trace[0].receipts.length, 2);
    assert.equal(owner.result.localSpecialists?.length, 2);
    assert.equal(outcome.result.localDownloadReferences?.length, 2);
    const sources = JSON.parse(f.store.files.get(owner.artifacts[0].path + ".sources.json")!.content);
    assert.deepEqual(sources.localSpecialists, trace[0].receipts);
    for (const receipt of trace[0].receipts) {
      assert.equal(receipt.inputSha256, hash(f.store.files.get(receipt.inputPath)!.content));
      const actual = binary.find(a => a.path === receipt.outputPath)!;
      assert.equal(receipt.sha256, hash(actual.bytes));
      assert.equal(f.store.files.has(receipt.outputPath), false, "binary is never fabricated as a text artifact");
      assert.equal(owner.artifacts.some(a => a.path === receipt.outputPath), false, "binary receipt cannot replace the primary text report");
      assert.ok(f.store.files.get(owner.artifacts[0].path)!.content.includes(receipt.sha256));
      assert.equal(receipt.reference?.metadataPath, receipt.outputPath + ".artifact.json");
    }
    assert.equal(localPort.calls.filter(c => "operation" in c.payload).length, 2);
    assert.ok(localPort.calls.every(c => !Object.hasOwn(c.payload, "command")));
    assert.equal(outcome.result.metadata.verification.verdict, "Pass");
    assert.equal(outcome.result.usage?.estimatedCostUsd, undefined);
    for (const link of links.values()) {
      assert.ok(outcome.result.localDownloadReferences?.some(reference => reference.downloadUrl === link.downloadUrl));
      for (const artifact of f.store.files.values()) {
        assert.equal(artifact.content.includes(link.downloadUrl), false, "transient SAS must not enter a text artifact/source/manifest");
        assert.equal(artifact.content.includes("local-sas-"), false);
      }
      assert.equal(outcome.result.text.includes(link.downloadUrl), false);
      assert.equal(JSON.stringify(outcome.result.metadata).includes(link.downloadUrl), false);
      assert.equal(JSON.stringify(outcome.result.stages).includes(link.downloadUrl), false);
    }
    for (const config of live.configs) {
      const key = { tenantId: "tenant-a", project: "project-a", sessionId: config.sessionId };
      for (const path of await f.options.sessionState.list(key)) {
        const content = await f.options.sessionState.read(key, path) ?? "";
        for (const link of links.values()) assert.equal(content.includes(link.downloadUrl), false, "durable SDK session logs must not persist SAS URLs");
        assert.equal(content.includes("local-sas-"), false);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("local publication refuses externally signed URLs even after binary commit and never accepts a fabricated text report", { skip: !pwshAvailable }, async () => {
  const scratch = join(process.cwd(), ".upstream-runtime-tests-" + randomUUID());
  mkdirSync(scratch);
  const f = fixture(), accountingPort = new LocalProcedurePort(scratch), localPort = new LocalTestPort();
  let reference: LocalSpecialistDownloadReference | undefined;
  await f.store.put("tenant-a", "project-a", "docs/input.md", "# Actual Markdown\n");
  f.options.localSpecialistFactory = context => ({
    runner: new LocalSpecialists({
      port: context.port, readTextArtifact: context.readTextArtifact,
      writeBinaryArtifact: async (artifact, receipt) => {
        const blobPath = `specialists/tenant-a/project-a/run-a/${context.request.stageId}/report.docx`;
        const metadataPath = artifact.path + ".artifact.json", expiresAt = new Date(Date.now() + 900000).toISOString();
        await f.store.put("tenant-a", "project-a", metadataPath, JSON.stringify({
          kind: "local-specialist-artifact", path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes.length,
          mediaType: artifact.mediaType, blobPath, operation: receipt.operation, inputSha256: receipt.inputSha256,
        }));
        reference = { metadataPath, expiresAt,
          downloadUrl: `https://untrusted.example/artifacts/${blobPath}?sp=r&sr=b&se=${encodeURIComponent(expiresAt)}&sig=must-not-publish-this-secret` };
      },
    }),
    referenceFor: () => reference,
  });
  installLiveClient(f, accountingPort, "local-invalid-reference", localPort);
  try {
    const result = await executeRun(f.options, "Produce a scoped report, never approve arbitrary signed URLs.");
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("failed");
    assert.match(result.detail, /Only an exact, unexpired, read-only Azure blob reference/);
    assert.equal(result.stages.length, 0);
    assert.equal(accountingPort.scripts.some(p => p.name === "Write-SquadHandoff"), false);
    for (const artifact of f.store.files.values()) assert.equal(artifact.content.includes("must-not-publish-this-secret"), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
