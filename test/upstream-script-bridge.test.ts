import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { SquadArtifact, SquadArtifactStore, SquadArtifactWriteResult } from "../src/engine/artifact-store.js";
import { UpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";
import {
  UpstreamScriptBridge, UpstreamScriptBridgeError, UPSTREAM_SCRIPT_PIN,
  type UpstreamAllowedWritePolicy, type UpstreamMirrorFile, type UpstreamScriptExecutionPort,
  type UpstreamScriptRequest,
} from "../src/engine/copilot/upstream-script-bridge.js";
import { attributeCompletion } from "../src/engine/model-backend.js";
import { copilotUsageFor } from "../src/engine/copilot/copilot-usage.js";

const bundleRoot = join(process.cwd(), "host", "upstream-runtime");
const bundle = new UpstreamBundle(bundleRoot);
const ROOT = ".copilot-tracking/squad";
const RATES = `${ROOT}/consumption-rates.md`;
const STATE = `${ROOT}/state.json`;
const DECISIONS = `${ROOT}/decisions.md`;
const HISTORY = `${ROOT}/history/squad-researcher.md`;
const MIRROR_HISTORY = `${ROOT}/history/Squad Researcher.md`;
const DOC = "docs/input.md";
const state = JSON.stringify({
  schemaVersion: "1.4", updated: "2026-10-10T00:00:00Z", turn: 0, mode: "advisory",
  activeRoles: [], openEscalations: [], currentRun: {}, notify: {},
});
const policy: UpstreamAllowedWritePolicy = { writes: [
  { path: STATE, mode: "replace" }, { path: DECISIONS, mode: "append" }, { path: HISTORY, mode: "append" },
] };
const handoff: UpstreamScriptRequest = {
  script: "Write-SquadHandoff", args: { payload: { runId: "run-a", historyRecords: [], stateAdvance: { activeRoles: [] } } },
};
const seed: UpstreamScriptRequest = { script: "Initialize-SquadConsumptionRates", args: { mode: "economy" } };

function file(path: string, content: string, updatedAt = 1000): UpstreamMirrorFile {
  const bytes = Buffer.from(content);
  return { path, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), updatedAt };
}
class Store implements SquadArtifactStore {
  files = new Map<string, SquadArtifact>();
  puts: { tenant: string; project: string; path: string; etag?: string }[] = [];
  counter = 0;
  conflictAt?: string;
  throwAt?: string;
  constructor(initial: Record<string, string> = { [DOC]: "source", [STATE]: state, [DECISIONS]: "# Decisions\n" }) {
    for (const [path, content] of Object.entries(initial)) this.external(path, content);
  }
  external(path: string, content: string): void {
    this.files.set(path, { tenantId: "tenant-a", project: "project-a", path, content, etag: `v${++this.counter}`, updatedAt: this.counter * 1000 });
  }
  async get(tenant: string, project: string, path: string): Promise<SquadArtifact | undefined> {
    assert.equal(tenant, "tenant-a"); assert.equal(project, "project-a");
    return this.files.get(path);
  }
  async list(tenant: string, project: string): Promise<{ path: string; size: number; updatedAt: number }[]> {
    assert.equal(tenant, "tenant-a"); assert.equal(project, "project-a");
    return [...this.files.values()].map(a => ({ path: a.path, size: a.content.length, updatedAt: a.updatedAt }));
  }
  async put(tenant: string, project: string, path: string, content: string, expectedEtag?: string): Promise<SquadArtifactWriteResult> {
    this.puts.push({ tenant, project, path, etag: expectedEtag });
    if (path === this.throwAt) throw new Error("backend disconnected");
    if (path === this.conflictAt || (expectedEtag && this.files.get(path)?.etag !== expectedEtag)) {
      return { ok: false, conflict: true, current: this.files.get(path) };
    }
    this.external(path, content);
    return { ok: true, artifact: this.files.get(path)! };
  }
  async append(): Promise<SquadArtifact> { throw new Error("Bridge must use exact CAS, never store.append"); }
}
interface Payload {
  operation: "initialize" | "snapshot" | "run";
  workspace: string;
  script?: string;
  args?: Record<string, unknown>;
  files?: UpstreamMirrorFile[];
  billingLog?: { base64: string; sha256: string };
}
function decodeCommand(command: string): string {
  assert.match(command, /^\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/nonexistent \/usr\/bin\/pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const source = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  return source;
}
class Port implements UpstreamScriptExecutionPort {
  tree = new Map<string, UpstreamMirrorFile>();
  commands: { source: string; payload: Payload }[] = [];
  onRun: (p: Payload) => void = () => {};
  corrupt?: (response: Record<string, unknown>) => void;
  transport: { success: boolean; exitCode?: number | null } = { success: true, exitCode: 0 };
  rawCommands: string[] = [];
  data = new Map<string, Buffer>();
  chunkFailure?: number;
  badChunkReceipt = false;
  cleanupFailure = false;
  chunkCount = 0;
  serverFailure?: { output: string; throws?: boolean };
  chunkedResponses = false;
  responses = new Map<string, Buffer>();
  badResponseHash = false;
  async runServerCommand(command: string) {
    this.rawCommands.push(command);
    const source = decodeCommand(command);
    const path = /\$(?:dataPath|path) = '([^']+)'/.exec(source)?.[1];
    assert.ok(path);
    assert.match(path, /^\/workspace\/\.hve-upstream\/\.transport-[a-f0-9-]{36}\.json$/);
    if (source.includes("operation='response-chunk'")) {
      const bytes = this.responses.get(path)!;
      const offset = Number(/\$stream.Position = (\d+)/.exec(source)![1]);
      const count = Number(/\$bytes = \[byte\[\]\]::new\((\d+)\)/.exec(source)![1]);
      assert.ok(count <= 12288);
      return { success: true, exitCode: 0, output: JSON.stringify({
        ok: true, operation: "response-chunk", offset, base64: bytes.subarray(offset, offset + count).toString("base64"),
      }) };
    }
    if (source.includes("operation='chunk'")) {
      assert.match(source, /UnixCreateMode/);
      assert.match(source, /chmod '600' \$path/);
      assert.match(source, /chmod '700' '\/workspace\/\.hve-upstream'/);
      assert.match(source, /FileMode\]::CreateNew/);
      const chunk = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(source)![1];
      assert.ok(chunk.length <= 16384);
      const offset = Number(/if \((\d+) -eq 0\)/.exec(source)![1]);
      const previous = this.data.get(path);
      if (offset === 0) assert.equal(previous, undefined);
      assert.equal(previous?.length ?? 0, offset);
      this.data.set(path, Buffer.concat([previous ?? Buffer.alloc(0), Buffer.from(chunk, "base64")]));
      this.chunkCount++;
      if (this.chunkFailure === this.chunkCount) return { success: false, exitCode: 1, output: "{}" };
      return { ...this.transport, output: JSON.stringify({ ok: true, operation: "chunk", bytes: this.data.get(path)!.length + (this.badChunkReceipt ? 1 : 0) }) };
    }
    if (source.includes("operation='cleanup'")) {
      if (this.cleanupFailure) return { success: false, exitCode: 1, output: "{}" };
      this.data.delete(path);
      this.responses.delete(path);
      return { success: true, exitCode: 0, output: '{"ok":true,"operation":"cleanup"}' };
    }
    const bytes = this.data.get(path);
    assert.ok(bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), /-ne '([a-f0-9]{64})'\) \{ throw 'Transport integrity/.exec(source)![1]);
    const decoded = { source, payload: JSON.parse(bytes.toString()) as Payload };
    this.commands.push(decoded);
    if (this.serverFailure) {
      if (this.serverFailure.throws) throw Object.assign(new Error("SECRET raw port error"), { stdout: this.serverFailure.output, stderr: "SECRET stderr" });
      return { success: false, exitCode: 1, output: this.serverFailure.output };
    }
    const p = decoded.payload;
    assert.match(p.workspace, /^\/workspace\/\.hve-upstream\/[a-f0-9-]{36}$/);
    assert.ok(!Object.hasOwn(p, "bundleFiles"));
    assert.match(source, /foreach \(\$file in \$manifest\.files\)/);
    if (p.operation === "initialize") this.tree = new Map(p.files!.map(f => [f.path, f]));
    if (p.operation === "run") this.onRun(p);
    const response: Record<string, unknown> = {
      ok: true, operation: p.operation, files: [...this.tree.values()].map(f => ({ ...f, kind: "file" })),
      ...(p.operation === "run" ? { scriptExitCode: 0, scriptOutput: "{}" } : {}),
    };
    this.corrupt?.(response);
    if (this.chunkedResponses) {
      const bytes = Buffer.from(JSON.stringify(response));
      this.responses.set(path, bytes);
      return { ...this.transport, output: JSON.stringify({ ok: true, operation: "response", bytes: bytes.length,
        sha256: this.badResponseHash ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") }) };
    }
    return { ...this.transport, output: JSON.stringify(response) };
  }

}

test("large response snapshots are read in bounded chunks with exact hashes and verified cleanup", async () => {
    const f = fixture({ [DOC]: "large source\n".repeat(15000), [STATE]: state, [DECISIONS]: "# Decisions\n" });
    f.port.chunkedResponses = true;
    const result = await f.bridge.initializeMirror();
    assert.equal(Buffer.from(result.files.find(x => x.path === DOC)!.base64, "base64").toString(), "large source\n".repeat(15000));
    assert.equal(f.port.responses.size, 0);
    assert.ok(f.port.rawCommands.filter(c => decodeCommand(c).includes("operation='response-chunk'")).length > 10);
    const bad = fixture();
    bad.port.chunkedResponses = true;
    bad.port.badResponseHash = true;
    await rejectsCode(bad.bridge.initializeMirror(), "invalid_response");
    assert.equal(bad.store.puts.length, 0);
    assert.equal(bad.port.responses.size, 0);
});
function fixture(initial?: Record<string, string>) {
  const store = new Store(initial);
  const port = new Port();
  const bridge = new UpstreamScriptBridge({ store, port, bundle, tenantId: "tenant-a", project: "project-a", runId: "run-a",
    historyAliases: [{ artifactPath: HISTORY, upstreamName: "Squad Researcher" }],
  });
  return { store, port, bridge };
}
function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => error instanceof UpstreamScriptBridgeError && error.code === code);
}

test("mode-independent ledger writing requires exact derived-file policy and validates native receipts", async () => {
  const f = fixture();
  f.port.onRun = payload => {
    assert.equal(payload.args?.Write, true);
    f.port.tree.set(`${ROOT}/consumption.md`, file(`${ROOT}/consumption.md`, "# Derived ledger\n"));
    const current = JSON.parse(Buffer.from(f.port.tree.get(STATE)!.base64, "base64").toString());
    current.currentRun.estCostUsd = 1;
    current.currentRun.estCreditsTotal = 100;
    f.port.tree.set(STATE, file(STATE, JSON.stringify(current)));
  };
  f.port.corrupt = response => {
    if (response.operation === "run") response.scriptOutput = "Measure-SquadLedger -Write: rewrote the derived consumption sections and state totals.";
  };
  await f.bridge.initializeMirror();
  const result = await f.bridge.runScript({ script: "Measure-SquadLedger", args: { write: true } }, {
    writes: [{ path: STATE, mode: "replace" }, { path: `${ROOT}/consumption.md`, mode: "replace" }],
  });
  assert.equal(result.execution, "pinned-script");
  assert.deepEqual([...result.changedPaths].sort(), [`${ROOT}/consumption.md`, STATE].sort());
  assert.equal(f.store.puts.length, 0, "No live write before validated commit.");
  await f.bridge.commitAllowedChanges();
  assert.equal(JSON.parse(f.store.files.get(STATE)!.content).currentRun.estCostUsd, 1);
});

test("ledger writes cannot expand into history or combine writer and checker flags", async () => {
  for (const fault of ["missing-policy", "history-policy", "write-and-check"] as const) {
    const f = fixture();
    await f.bridge.initializeMirror();
    const policy: UpstreamAllowedWritePolicy = { writes: [
      { path: STATE, mode: "replace" },
      { path: fault === "history-policy" ? HISTORY : `${ROOT}/consumption.md`, mode: "replace" },
    ] };
    await assert.rejects(f.bridge.runScript({
      script: "Measure-SquadLedger", args: { write: true, ...(fault === "write-and-check" ? { check: true } : {}) },
    }, fault === "missing-policy" ? undefined : policy),
    (error: unknown) => error instanceof UpstreamScriptBridgeError);
    assert.equal(f.store.puts.length, 0);
  }
});

test("isolated mirror contains only this tenant/project's artifacts with byte hashes and timestamps", async () => {
  const { bridge, port, store } = fixture();
  const mirror = await bridge.initializeMirror();
  assert.equal(store.puts.length, 0);
  assert.equal(mirror.workspacePath, bridge.workspacePath);
  for (const f of mirror.files) {
    assert.equal(f.updatedAt, store.files.get(f.path)!.updatedAt);
    assert.equal(Buffer.from(f.base64, "base64").toString(), store.files.get(f.path)!.content);
  }
  assert.equal(port.commands[0].payload.files!.length, 3);
  assert.ok(!JSON.stringify(port.commands[0].payload).includes("tenant-a"));
  assert.equal(port.data.size, 0);
});

test("near-limit 7.9MB tree uses <=16KiB base64 chunks and every command stays below 64KiB", async t => {
  const initial = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`docs/large-${i}.md`, "x".repeat(255000)]));
  const { bridge, port, store } = fixture(initial);
  const mirrored = await bridge.initializeMirror();
  assert.equal(mirrored.files.length, 31);
  assert.ok(port.chunkCount > 800);
  const maximum = Math.max(...port.rawCommands.map(command => Buffer.byteLength(command)));
  t.diagnostic(`Maximum measured command: ${maximum} bytes; ${port.chunkCount} chunks; mirrored ${31 * 255000} bytes.`);
  assert.ok(maximum < 65536, `Measured maximum command bytes: ${maximum}`);
  assert.equal(port.data.size, 0);
  assert.equal(store.puts.length, 0);
  assert.equal(Buffer.from(port.tree.get("docs/large-30.md")!.base64, "base64").length, 255000);
});

test("chunk failure, mismatched offset receipt, and cleanup failure report uncertain transport without live writes", async () => {
  for (const mode of ["chunk", "receipt", "cleanup"] as const) {
    const { bridge, port, store } = fixture({ [DOC]: "x".repeat(255000) });
    if (mode === "chunk") port.chunkFailure = 2;
    if (mode === "receipt") port.badChunkReceipt = true;
    if (mode === "cleanup") port.cleanupFailure = true;
    await assert.rejects(bridge.initializeMirror(), (e: unknown) => {
      assert.ok(e instanceof UpstreamScriptBridgeError);
      assert.equal(e.code, "transport_uncertain");
      assert.ok(e.uncertainPaths.some(path => /^\/workspace\/\.hve-upstream\/\.transport-/.test(path)));
      return true;
    });

    assert.equal(store.puts.length, 0);
    assert.equal(port.data.size, mode === "cleanup" ? 1 : 0);
    assert.match(decodeCommand(port.rawCommands.at(-1)!), /operation='cleanup'/);
    await rejectsCode(bridge.commitAllowedChanges(), "invalid_phase");
  }
});

test("safe PowerShell identifier, phase, and line survive failed result and thrown port without retaining raw messages", async () => {
      for (const throws of [false, true]) {
        const { bridge, port } = fixture();
        port.serverFailure = { throws, output: JSON.stringify({
          ok: false, operation: "initialize",
          diagnostic: { identifier: "PropertyNotFoundStrict", line: 94, phase: "snapshot", message: "SECRET payload" },
          error: "SECRET exception",
        }) };
        await assert.rejects(bridge.initializeMirror(), (e: unknown) => {
          assert.ok(e instanceof UpstreamScriptBridgeError);
          assert.equal(e.code, "transport_uncertain");
          assert.deepEqual(e.diagnostic, { identifier: "PropertyNotFoundStrict", line: 94, phase: "snapshot" });
          assert.ok(e.cause instanceof Error);
          assert.match(e.cause.message, /PropertyNotFoundStrict; line 94; phase snapshot/);
          assert.ok(!JSON.stringify(e).includes("SECRET"));
          assert.equal(port.data.size, 0);
          return true;
        });
      }
    });

    test("untrusted PowerShell identifier/phase cannot export arbitrary content", async () => {
      const { bridge, port } = fixture();
      port.serverFailure = { output: JSON.stringify({ ok: false, diagnostic: {
        identifier: "SECRET-message-as-FullyQualifiedErrorId", line: 10, phase: "inventory",
      } }) };
      await assert.rejects(bridge.initializeMirror(), (e: unknown) => {
        assert.ok(e instanceof UpstreamScriptBridgeError);
        assert.equal(e.diagnostic, undefined);
        assert.equal(e.cause, undefined);
        assert.ok(!JSON.stringify(e).includes("SECRET"));
        return true;
      });
    });

test("initial rates seed writes only to mirror until explicit validated commit", async () => {
  const { bridge, port, store } = fixture();
  await bridge.initializeMirror();
  port.onRun = p => {
    assert.equal(p.script, seed.script);
    assert.deepEqual(p.args, { Mode: "economy" });
    port.tree.set(RATES, file(RATES, "# Pinned rates\n"));
  };
  const result = await bridge.runScript(seed);
  assert.deepEqual(result.changedPaths, [RATES]);
  assert.equal(result.accounting, "upstream-schema-estimates-only");
  assert.equal(store.files.has(RATES), false);
  assert.deepEqual(await bridge.commitAllowedChanges(), { committedPaths: [RATES], atomic: false });
  assert.equal(store.puts[0].etag, undefined);
  await rejectsCode(bridge.commitAllowedChanges(), "invalid_phase");
});

test("read-only routing accepts scalar/array JSON args without shell interpolation", async () => {
  const { bridge, port, store } = fixture();
  await bridge.initializeMirror();
  await bridge.runScript({ script: "Resolve-SquadModelRoute", args: {
    availableModels: ["gpt-5-mini"], sessionModel: "$(touch /outside); 'quoted'", roles: ["Squad Researcher"],
  } });
  const command = port.commands.find(c => c.payload.operation === "run")!;
  assert.equal(command.payload.args!.SessionModel, "$(touch /outside); 'quoted'");
  assert.ok(!command.source.includes("touch /outside"));
  assert.equal(store.puts.length, 0);
  assert.deepEqual((await bridge.commitAllowedChanges()).committedPaths, []);
});

test("read-only script modifying a file is blocked", async () => {
  const { bridge, port, store } = fixture();
  await bridge.initializeMirror();
  port.onRun = () => port.tree.set(DOC, file(DOC, "modified"));
  await rejectsCode(bridge.runScript({ script: "Get-SquadDispatchBrief", args: {} }), "unsafe_diff");
  await rejectsCode(bridge.commitAllowedChanges(), "invalid_phase");
  assert.equal(store.puts.length, 0);
});

test("seed rejects deletions, unrelated output, and timestamp-only tampering", async () => {
  for (const mutate of [
    (p: Port) => p.tree.delete(DOC),
    (p: Port) => p.tree.set("outputs/unapproved.md", file("outputs/unapproved.md", "new")),
    (p: Port) => p.tree.set(DOC, { ...p.tree.get(DOC)!, updatedAt: 99999 }),
  ]) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    port.onRun = () => { mutate(port); };
    await rejectsCode(bridge.runScript(seed), "unsafe_diff");
    assert.equal(store.puts.length, 0);
  }
});

test("mutators require explicit server policy; policy cannot expand to docs, wildcard, or rewrite histories", async () => {
  for (const supplied of [
    undefined,
    { writes: [{ path: DOC, mode: "replace" }] },
    { writes: [{ path: `${ROOT}/history/*.md`, mode: "append" }] },
    { writes: [{ path: HISTORY, mode: "replace" }] },
  ]) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    const before = port.commands.length;
    await assert.rejects(bridge.runScript(handoff, supplied as UpstreamAllowedWritePolicy | undefined));
    assert.equal(port.commands.length, before);
    assert.equal(store.puts.length, 0);
  }
});

test("append-only decisions retain exact prefix and existing state is committed using original etag", async () => {
  const { bridge, port, store } = fixture();
  const originalEtag = store.files.get(STATE)!.etag;
  await bridge.initializeMirror();
  port.onRun = p => {
    assert.equal(p.args!.SessionLog, "");
    assert.equal(p.args!.LockTimeoutSeconds, 30);
    port.tree.set(DECISIONS, file(DECISIONS, "# Decisions\n## New decision\n"));
    port.tree.set(STATE, file(STATE, state.replace('"turn":0', '"turn":1')));
  };
  await bridge.runScript(handoff, policy);
  assert.equal(store.puts.length, 0);
  await bridge.commitAllowedChanges();
  assert.equal(store.puts.find(p => p.path === STATE)!.etag, originalEtag);
  assert.equal(store.files.get(DECISIONS)!.content, "# Decisions\n## New decision\n");
});

test("rewriting an append-only history or decision prefix is rejected before any live write", async () => {
  const history = '# History: Squad Researcher\n### Turn 1\n#### Consumption\n```json\n{"model":"gpt-5-mini","model_source":"operator-declared","model_tier":"small","internal_turns":1,"input_tokens":1,"cached_tokens":0,"cache_write_tokens":0,"output_tokens":1,"basis":"estimated"}\n```\n';
  for (const path of [DECISIONS, HISTORY]) {
    const { bridge, port, store } = fixture({ [STATE]: state, [DECISIONS]: "original\n", [HISTORY]: history });
    await bridge.initializeMirror();
    const mirrored = path === HISTORY ? MIRROR_HISTORY : path;
    port.onRun = () => port.tree.set(mirrored, file(mirrored, "replacement\n"));
    await rejectsCode(bridge.runScript(handoff, policy), "append_only");
    assert.equal(store.puts.length, 0);
  }
});

test("native logs cannot be silently used as upstream accounting", async () => {
  for (const initial of [
    { [STATE]: '{"version":1,"runId":"run-a"}' },
    { [STATE]: state, [HISTORY]: "### Research completed\nTokens: 42\n" },
  ] as Record<string, string>[]) {
    const { bridge, port } = fixture(initial);
    await bridge.initializeMirror();
    await rejectsCode(bridge.runScript({ script: "Measure-SquadLedger", args: {} }), "incompatible_schema");
    assert.equal(port.commands.filter(c => c.payload.operation === "run").length, 0);
  }
});

test("explicit history filename aliases preserve schema and commit exact bytes to safe store paths", async () => {
  const { bridge, port, store } = fixture({ [STATE]: state, [HISTORY]: "# History: Squad Researcher\n" });
  await bridge.initializeMirror();
  assert.ok(port.tree.has(MIRROR_HISTORY));
  assert.ok(!port.tree.has(HISTORY));
  const appended = "# History: Squad Researcher\n### Turn 1\n#### Consumption\n```json\n" +
    JSON.stringify({ model: "gpt-5-mini", model_source: "operator-declared", model_tier: "small",
      internal_turns: 1, input_tokens: 1, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 1, basis: "estimated" }) + "\n```\n";
  port.onRun = () => port.tree.set(MIRROR_HISTORY, file(MIRROR_HISTORY, appended));
  assert.deepEqual((await bridge.runScript(handoff, policy)).changedPaths, [HISTORY]);
  assert.deepEqual((await bridge.commitAllowedChanges()).committedPaths, [HISTORY]);
  assert.equal(store.files.get(HISTORY)!.content, appended);
  assert.equal(store.files.has(MIRROR_HISTORY), false);
});

test("malformed state produced in an eligible path is still unsafe output", async () => {
  const { bridge, port, store } = fixture();
  await bridge.initializeMirror();
  port.onRun = () => port.tree.set(STATE, file(STATE, "{malformed"));
  await rejectsCode(bridge.runScript(handoff, policy), "incompatible_schema");
  assert.equal(store.puts.length, 0);
});

test("commit preflights unrelated input and tree-membership conflicts before writes", async () => {
  for (const conflict of [
    (s: Store) => s.external(DOC, "concurrent edit"),
    (s: Store) => s.external("docs/concurrent.md", "new"),
    (s: Store) => s.external(RATES, "concurrent create"),
    (s: Store) => s.files.delete(DOC),
  ]) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    port.onRun = () => port.tree.set(RATES, file(RATES, "rates"));
    await bridge.runScript(seed);
    conflict(store);
    await rejectsCode(bridge.commitAllowedChanges(), "commit_conflict");
    assert.equal(store.puts.length, 0);
  }
});

test("multi-file CAS race and transport failure report exact durable and uncertain writes without atomicity claims", async () => {
  for (const throws of [false, true]) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    port.onRun = () => {
      port.tree.set(DECISIONS, file(DECISIONS, "# Decisions\nnew\n"));
      port.tree.set(STATE, file(STATE, state.replace('"turn":0', '"turn":1')));
    };
    await bridge.runScript(handoff, policy);
    if (throws) store.throwAt = STATE; else store.conflictAt = STATE;
    await assert.rejects(bridge.commitAllowedChanges(), (e: unknown) => {
      assert.ok(e instanceof UpstreamScriptBridgeError);
      assert.deepEqual(e.committedPaths, [DECISIONS]);
      assert.deepEqual(e.uncertainPaths, throws ? [STATE] : []);
      return true;
    });

    assert.equal(store.files.get(DECISIONS)!.content, "# Decisions\nnew\n");
  }
});

test("a pre-create read failing after a committed file retains the partial-commit receipt", async () => {
  const { bridge, port, store } = fixture();
  await bridge.initializeMirror();
  port.onRun = () => {
    port.tree.set(DECISIONS, file(DECISIONS, "# Decisions\nnew\n"));
    port.tree.set(MIRROR_HISTORY, file(MIRROR_HISTORY, "# History: Squad Researcher\n"));
  };
  await bridge.runScript(handoff, { writes: [
    { path: DECISIONS, mode: "append" }, { path: HISTORY, mode: "append" },
  ] });
  const get = store.get.bind(store);
  store.get = async (tenant, project, path) => {
    if (path === HISTORY && store.puts.length) throw new Error("read unavailable");
    return get(tenant, project, path);
  };
  await assert.rejects(bridge.commitAllowedChanges(), (e: unknown) => {
    assert.ok(e instanceof UpstreamScriptBridgeError);
    assert.equal(e.code, "commit_failed");
    assert.deepEqual(e.committedPaths, [DECISIONS]);
    assert.deepEqual(e.uncertainPaths, []);
    return true;
  });
});

test("mirror changes between run and commit cannot be smuggled into approved paths", async () => {
  const { bridge, port, store } = fixture();
  await bridge.initializeMirror();
  port.onRun = () => port.tree.set(RATES, file(RATES, "approved"));
  await bridge.runScript(seed);
  port.tree.set(RATES, file(RATES, "not approved"));
  await rejectsCode(bridge.commitAllowedChanges(), "mirror_changed");
  assert.equal(store.puts.length, 0);
});

test("malformed envelopes, missing exits, and script refusal are explicit failures", async () => {
  for (const corrupt of [
    (r: Record<string, unknown>) => { delete r.scriptExitCode; },
    (r: Record<string, unknown>) => { r.scriptExitCode = 2; },
    (r: Record<string, unknown>) => { r.ok = false; },
    (r: Record<string, unknown>) => { r.scriptOutput = ""; },
    (r: Record<string, unknown>) => { r.files = null; },
  ]) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    port.corrupt = corrupt;
    await assert.rejects(bridge.runScript(seed));
    assert.equal(store.puts.length, 0);
  }
  const { bridge, port } = fixture();
  port.transport = { success: true };
  await rejectsCode(bridge.initializeMirror(), "transport_uncertain");
});

test("symlinks, non-UTF8, invalid hashes, oversized files, and secret output are blocked", async () => {
  for (const bad of [
    { ...file(RATES, "rates"), kind: "symlink" },
    { ...file(RATES, "rates"), kind: "file", sha256: "0".repeat(64) },
    { ...file(RATES, "rates"), kind: "file", base64: "/w==", sha256: createHash("sha256").update(Buffer.from([255])).digest("hex") },
    { ...file(RATES, "x".repeat(256001)), kind: "file" },
    { ...file(RATES, `github_pat_${"x".repeat(40)}`), kind: "file" },
    { ...file("docs/../../escape.md", "escape"), kind: "file" },
    file(RATES, "type missing"),
  ]) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    port.corrupt = response => { response.files = [...(response.files as unknown[]), bad]; };
    await assert.rejects(bridge.runScript(seed));
    assert.equal(store.puts.length, 0);
  }
});

test("secret inputs are never transported and arbitrary scripts, paths, env, and file-mode parameters are refused", async () => {
  const secret = fixture({ "docs/secret.md": "do not export" });
  await rejectsCode(secret.bridge.initializeMirror(), "unsafe_path");
  assert.equal(secret.port.commands.length, 0);
  for (const request of [
    { script: "Invoke-Expression", args: {} },
    { script: seed.script, args: { mode: "economy", SquadRoot: "/outside" } },
    { script: seed.script, args: { mode: "economy", env: { TOKEN: "secret" } } },
    { script: "Measure-SquadLedger", args: { check: true, Write: true, SessionLog: "/home/user/events.jsonl" } },
    { script: "Write-SquadHandoff", args: { PayloadPath: "/outside", payload: {} } },
  ]) {
    const { bridge, port } = fixture();
    await bridge.initializeMirror();
    await assert.rejects(bridge.runScript(request as unknown as UpstreamScriptRequest));
    assert.equal(port.commands.filter(c => c.payload.operation === "run").length, 0);
  }
});

test("trusted billing log crosses hashed private transport, never model args or mirrored project files", async () => {
  const { port, store } = fixture();
  const records = [attributeCompletion({
    eventId: "a", attempt: 1, outcome: "completed", backendId: "copilot-sdk",
    usage: copilotUsageFor({ copilotUsage: { totalNanoAiu: 500_000_000 } }),
  }, { runId: "run-a", stage: "Squad Coordinator", actor: "Squad Coordinator" })];
  const bridge = new UpstreamScriptBridge({ store, port, bundle, tenantId: "tenant-a", project: "project-a",
    runId: "run-a", billingRecords: records });
  await bridge.initializeMirror();
  const result = await bridge.runScript({ script: "Measure-SquadLedger", args: {} });
  const command = port.commands.find(command => command.payload.operation === "run")!;
  const bytes = Buffer.from(command.payload.billingLog!.base64, "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), command.payload.billingLog!.sha256);
  assert.ok(bytes.toString().includes('"totalNanoAiu":500000000'));
  assert.equal(result.runBilling?.billingStatus, "complete");
  assert.equal(command.payload.args!.SessionLog, undefined);
  assert.match(command.source, /Runtime chmod failed/);
  assert.match(command.source, /Billing-log integrity mismatch/);
  assert.match(command.source, /chmod '600' \(\$runtime \+ '\/events.jsonl'\)/);
  assert.match(command.source, /\.runtime\/events\.jsonl/);
  assert.equal([...port.tree.keys()].some(path => path.includes("events.jsonl")), false);
  assert.equal(store.puts.length, 0);
  assert.equal(port.data.size, 0);
  await rejectsCode(bridge.runScript(seed), "invalid_billing_scope");
});

test("Set preflight only permits state replacement and decisions append, with genuine parameter names", async () => {
  const { bridge, port } = fixture();
  await bridge.initializeMirror();
  const preflight = { decision: "within-ceiling" };
  await bridge.runScript({ script: "Set-SquadCostPreflight", args: {
    expectedUpdated: "2026-10-10T00:00:00Z", preflight, decisionText: "explicit decision",
  } }, { writes: [{ path: STATE, mode: "replace" }, { path: DECISIONS, mode: "append" }] });
  assert.deepEqual(port.commands.find(c => c.payload.operation === "run")!.payload.args, {
    ExpectedUpdated: "2026-10-10T00:00:00Z", PreflightJson: JSON.stringify(preflight), DecisionText: "explicit decision",
  });
});

test("not-requested preflight omits DecisionText and rejects incompatible decision entries before execution", async () => {
  const policy = { writes: [{ path: STATE, mode: "replace" as const }, { path: DECISIONS, mode: "append" as const }] };
  const preflight = { decision: "not-requested" };
  const { bridge, port } = fixture();
  await bridge.initializeMirror();
  await bridge.runScript({ script: "Set-SquadCostPreflight", args: {
    expectedUpdated: "2026-10-10T00:00:00Z", preflight,
  } }, policy);
  assert.deepEqual(port.commands.find(c => c.payload.operation === "run")!.payload.args, {
    ExpectedUpdated: "2026-10-10T00:00:00Z", PreflightJson: JSON.stringify(preflight),
  });
  const source = port.commands.find(c => c.payload.operation === "run")!.source;
  assert.equal([...source.matchAll(/ConvertFrom-Json -AsHashtable -DateKind String/g)].length, 3,
    "Both transport readers and the child preserve ISO strings instead of coercing CAS timestamps to DateTime.");
  for (const args of [
    { expectedUpdated: "", preflight, decisionText: "not allowed" },
    { expectedUpdated: "", preflight: { decision: "within-ceiling" } },
    { expectedUpdated: "", preflight: { decision: "within-ceiling" }, decisionText: " " },
  ]) {
    const f = fixture();
    await f.bridge.initializeMirror();
    await rejectsCode(f.bridge.runScript({ script: "Set-SquadCostPreflight", args }, policy), "invalid_args");
    assert.equal(f.port.commands.filter(c => c.payload.operation === "run").length, 0);
  }
});

const pwsh = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
test("ledger Check accepts only the genuine exact PASS receipt with zero exit; render remains JSON-only", async () => {
  const script = readFileSync(join(bundleRoot, ".github", "skills", "squad", "scripts", "Measure-SquadLedger.ps1"), "utf8");
  assert.match(script, /Write-Host 'Measure-SquadLedger -Check: PASS' -ForegroundColor Green\s+exit 0/);
  for (const [output, check, exit, accepted] of [
    ["Measure-SquadLedger -Check: PASS\n", true, 0, true],
    ["Measure-SquadLedger -Check: PASS\r\n", true, 0, true],
    ["Measure-SquadLedger -Check: PASS\n", true, 1, false],
    ["Measure-SquadLedger -Check: FAIL (1 mismatch(es))", true, 0, false],
    ["prefix\nMeasure-SquadLedger -Check: PASS", true, 0, false],
    ["Measure-SquadLedger -Check: PASS\nsuffix", true, 0, false],
    ["{}", true, 0, false],
    ["Measure-SquadLedger -Check: PASS", false, 0, false],
    ["{}", false, 0, true],
  ] as const) {
    const { bridge, port, store } = fixture();
    await bridge.initializeMirror();
    port.corrupt = r => {
      if (r.operation === "run") { r.scriptOutput = output; r.scriptExitCode = exit; }
    };
    const result = bridge.runScript({ script: "Measure-SquadLedger", args: { check } });
    if (accepted) assert.equal((await result).output, output);
    else await assert.rejects(result);
    assert.equal(store.puts.length, 0);
  }
});

test("genuine pinned handoff frontmatter passes accounting validation without admitting native metadata", { skip: pwsh.error ? "pwsh unavailable" : false }, async () => {
  const source = readFileSync(join(bundleRoot, ".github", "skills", "squad", "scripts", "Write-SquadHandoff.ps1"), "utf8");
  const start = source.indexOf("function Get-HistoryHeader {");
  const end = source.indexOf("\nfunction Add-ToTextFile", start);
  assert.ok(start >= 0 && end > start);
  const extracted = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `${source.slice(start, end)}\n(Get-HistoryHeader -Agent 'Squad Researcher') -join [char]10`],
  { encoding: "utf8", timeout: 30000 });
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.match(extracted.stdout, /^---\r?\ndescription: "Append-only dispatch history for a single squad agent"/);
  const entry = '\n### Turn 1\n#### Consumption\n```json\n' + JSON.stringify({
    model: "gpt-5-mini", model_source: "operator-declared", model_tier: "small", internal_turns: 1,
    input_tokens: 1, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 1, basis: "estimated",
  }) + "\n```\n";
  for (const header of [extracted.stdout, "\uFEFF" + extracted.stdout.replace(/\r?\n/g, "\r\n")]) {
    const { bridge, port, store } = fixture({ [STATE]: state });
    await bridge.initializeMirror();
    port.onRun = () => port.tree.set(MIRROR_HISTORY, file(MIRROR_HISTORY, header + entry));
    await bridge.runScript(handoff, policy);
    await bridge.commitAllowedChanges();
    assert.equal(store.files.get(HISTORY)!.content, header + entry);
  }
  for (const header of [
    extracted.stdout.replace("single squad agent", "native production log"),
    extracted.stdout.replace("---\n\n", "extra: native\n---\n\n"),
    extracted.stdout.replace("# History: Squad Researcher", "# History: Other Agent"),
    "---\n" + "description: x\n".repeat(100) + "---\n\n# History: Squad Researcher\n",
  ]) {
    const { bridge, port, store } = fixture({ [STATE]: state });
    await bridge.initializeMirror();
    port.onRun = () => port.tree.set(MIRROR_HISTORY, file(MIRROR_HISTORY, header + entry));
    await rejectsCode(bridge.runScript(handoff, policy), "incompatible_schema");
    assert.equal(store.puts.length, 0);
  }
});

test("actual encoded child preserves Write-Host success but refuses errors, warnings, and nonzero exit", { skip: pwsh.error ? "pwsh unavailable" : false }, async () => {
  const { bridge, port } = fixture();
  await bridge.initializeMirror();
  await bridge.runScript(seed);
  const source = port.commands.find(c => c.payload.operation === "run")!.source;
  const childLine = source.split("\n").find(line => line.trimStart().startsWith("$child = "))!;
  assert.match(childLine, /@a 6>&1/);
  const processBlock = source.slice(source.indexOf("    $start = "), source.indexOf("    $proc.Dispose()") + "    $proc.Dispose()".length);
  assert.match(processBlock, /'-InputFormat','Text','-OutputFormat','Text'/);
  assert.match(processBlock, /\$start.WorkingDirectory = \$runtime/);
  assert.match(processBlock, /\$start.Environment\['HOME'\] = \$runtime/);
  assert.match(processBlock, /\$start.Environment\['XDG_CACHE_HOME'\] = \$runtime \+ '\/cache'/);
  assert.match(processBlock, /\$start.Environment\['DOTNET_CLI_HOME'\] = \$runtime \+ '\/dotnet'/);
  const executable = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Id $PID).Path"], { encoding: "utf8" }).stdout.trim();
  const dir = join(process.cwd(), `.test-upstream-script-bridge-${randomUUID()}`);
  mkdirSync(dir);
  const scripts = join(dir, "scripts");
  mkdirSync(scripts);
  const mirror = join(dir, "mirror");
  mkdirSync(mirror);
  const dataPath = join(dir, "transport.json");
  writeFileSync(dataPath, JSON.stringify({ workspace: mirror, script: seed.script, args: {} }));
  try {
    for (const [body, success] of [
      ["if (-not (Test-Path -LiteralPath $env:HOME -PathType Container) -or -not (Test-Path -LiteralPath $env:XDG_CACHE_HOME -PathType Container) -or -not (Test-Path -LiteralPath $env:DOTNET_CLI_HOME -PathType Container)) { throw 'Runtime homes missing' }; [IO.File]::WriteAllText(($env:HOME + '/runtime-marker'),'private'); Write-Host 'OK/SEEDED'; exit 0", true],
      ["Write-Error 'controlled error'; exit 0", false],
      ["Write-Warning 'controlled warning'; exit 0", false],
      ["Write-Host 'not successful'; exit 7", false],
    ] as const) {
      writeFileSync(dataPath, JSON.stringify({ workspace: mirror, script: seed.script, args: {} }));
      writeFileSync(join(scripts, `${seed.script}.ps1`), `param([string]$SquadRoot)\n${body}\n`);
      const parent: string = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; $response=@{}; ` +
        `function Regular($path,$directory) { if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'Bad runtime directory' } }; ` +
        `$dataPath='${dataPath}'; $p=@{workspace='${mirror}';script='${seed.script}'};\n` +
        childLine.replaceAll("/opt/hve-upstream/.github/skills/squad/scripts", scripts) + "\ntry {\n" +
        processBlock.replaceAll("/usr/bin/pwsh", executable).replace(/& \/usr\/bin\/chmod[^\n]*/g, "$global:LASTEXITCODE = 0") +
        "\n@{ok=$true;output=$out} | ConvertTo-Json -Compress; exit 0 } catch { exit 1 }";
      const executed = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(parent, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000 });
      assert.equal(executed.status === 0, success, `Unexpected status ${executed.status}: ${executed.stderr}`);
      if (success) {
        assert.match(JSON.parse(executed.stdout).output, /OK\/SEEDED/);
        assert.equal(executed.stderr, "");
        assert.ok(existsSync(dataPath + ".runtime"));
        assert.equal(readFileSync(join(dataPath + ".runtime", "runtime-marker"), "utf8"), "private");
      }
      assert.deepEqual(readdirSync(mirror), [], "Real PowerShell startup must not add profiler output to mirrored roots.");
      const cleanupSource = decodeCommand(port.rawCommands.at(-1)!);
      const originalDataPath = /\$path = '([^']+)'/.exec(cleanupSource)![1];
      const cleanup = cleanupSource.replaceAll(originalDataPath, dataPath)
        .replace(/if \(\$path -notmatch '[^']+'\) \{ throw 'Unsafe transport path' \}/, "")
        .replaceAll("'/workspace/.hve-upstream'", `'${dir}'`)
        .replaceAll("'/workspace'", `'${dir}'`)
        .replace("& /usr/bin/test '-f' $path", "$global:LASTEXITCODE = 0")
        .replace(/^\s*\$responseOptions\.UnixCreateMode = .*$/m, "");
      const cleaned = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(cleanup, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000 });
      assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
      assert.equal(existsSync(dataPath), false);
      assert.equal(existsSync(dataPath + ".runtime"), false);
      assert.ok(existsSync(mirror), "Specific private-runtime cleanup must preserve the mirror.");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actual private billing-log child receives only the aggregated compatible checkpoint and cleans it up", { skip: pwsh.error ? "pwsh unavailable" : false }, async () => {
  const f = fixture();
  const records = [1_000_000_000, 2_000_000_000].map((nano, index) => attributeCompletion({
    eventId: `billing-${index}`, attempt: 1, outcome: "completed", backendId: "copilot-sdk",
    usage: copilotUsageFor({ copilotUsage: { totalNanoAiu: nano } }),
  }, { runId: "run-a", stage: "Squad Coordinator", actor: "Squad Coordinator" }));
  const bridge = new UpstreamScriptBridge({ store: f.store, port: f.port, bundle, tenantId: "tenant-a", project: "project-a",
    runId: "run-a", billingRecords: records });
  await bridge.initializeMirror();
  await bridge.runScript({ script: "Measure-SquadLedger", args: {} });
  const run = f.port.commands.find(command => command.payload.operation === "run")!;
  const source = run.source;
  const childLine = source.split("\n").find(line => line.trimStart().startsWith("$child = "))!;
  const processBlock = source.slice(source.indexOf("    $start = "), source.indexOf("    $proc.Dispose()") + "    $proc.Dispose()".length);
  const executable = spawnSync("pwsh", ["-NoProfile", "-Command", "(Get-Process -Id $PID).Path"], { encoding: "utf8" }).stdout.trim();
  const dir = join(process.cwd(), `.test-upstream-script-bridge-${randomUUID()}`);
  mkdirSync(dir);
  try {
    const scripts = join(dir, "scripts"), mirror = join(dir, "mirror"), dataPath = join(dir, "transport.json");
    mkdirSync(scripts); mkdirSync(mirror);
    writeFileSync(join(scripts, "Measure-SquadLedger.ps1"),
      "param([string]$SquadRoot,[string]$Format,[string]$SessionLog)\n" +
      "$events=@([IO.File]::ReadAllLines($SessionLog)|ForEach-Object{$_|ConvertFrom-Json}); " +
      "$checkpoints=@($events|Where-Object type -eq 'session.usage_checkpoint'); " +
      "if($checkpoints.Count -ne 1 -or $checkpoints[0].data.totalNanoAiu -ne 3000000000){throw 'Bad cumulative billing'}; " +
      "if($SessionLog.StartsWith($SquadRoot)){throw 'Log exposed in mirrored tree'}; Write-Output 'BILLING-LOG-OK'; exit 0");
    const payload = { ...run.payload, workspace: mirror };
    writeFileSync(dataPath, JSON.stringify(payload));
    const parent = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest; $response=@{}; ` +
      `function Regular($path,$directory) { if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'Bad runtime directory' } }; ` +
      `$dataPath='${dataPath}'; $p=[IO.File]::ReadAllText($dataPath)|ConvertFrom-Json -AsHashtable;\n` +
      childLine.replaceAll("/opt/hve-upstream/.github/skills/squad/scripts", scripts) + "\ntry {\n" +
      processBlock.replaceAll("/usr/bin/pwsh", executable).replace(/& \/usr\/bin\/chmod[^\n]*/g, "$global:LASTEXITCODE = 0") +
      "\nWrite-Output $out; exit 0 } catch { [Console]::Error.WriteLine($_); exit 1 }";
    const executed = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(parent, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000 });
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    assert.match(executed.stdout, /BILLING-LOG-OK/);
    assert.deepEqual(readdirSync(mirror), []);
    const cleanupSource = decodeCommand(f.port.rawCommands.at(-1)!);
    const original = /\$path = '([^']+)'/.exec(cleanupSource)![1];
    const cleanup = cleanupSource.replaceAll(original, dataPath)
      .replace(/if \(\$path -notmatch '[^']+'\) \{ throw 'Unsafe transport path' \}/, "")
      .replaceAll("'/workspace/.hve-upstream'", `'${dir}'`).replaceAll("'/workspace'", `'${dir}'`)
      .replace("& /usr/bin/test '-f' $path", "$global:LASTEXITCODE = 0")
      .replace(/^\s*\$responseOptions\.UnixCreateMode = .*$/m, "");
    const cleaned = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(cleanup, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30000 });
    assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
    assert.equal(existsSync(dataPath + ".runtime"), false);
    assert.ok(existsSync(mirror));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generated server PowerShell parses and genuine pinned seed writes the upstream rate schema", { skip: pwsh.error ? "pwsh unavailable" : false }, async () => {
  assert.equal(bundle.identity.sourceCommit, UPSTREAM_SCRIPT_PIN);
  const { bridge, port } = fixture();
  await bridge.initializeMirror();
  const syntax = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$scripts = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($s in $scripts) { $tokens=$null; $errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 } }"],
  { input: JSON.stringify(port.rawCommands.map(decodeCommand)), encoding: "utf8", timeout: 30000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const command of port.rawCommands) {
    const source = decodeCommand(command);
    for (const line of source.split("\n").filter(line => /Get-Item\b/.test(line))) assert.match(line, /-Force\b/);
  }
  assert.match(port.commands[0].source, /\$info = Get-Item -LiteralPath \$path -Force/);
  assert.match(port.commands[0].source, /if \(\$info.Length -ne \$file.bytes -or \(FileHash \$path\) -ne \$file.sha256\)/);
  assert.ok(!port.commands[0].source.includes("Get-FileHash"));
  const dir = join(process.cwd(), `.test-upstream-script-bridge-${randomUUID()}`);
  mkdirSync(dir);
  try {
    const hiddenPath = join(dir, ".hidden-inventory.md");
    const hiddenBytes = Buffer.from("hidden pinned inventory resource\n");
    writeFileSync(hiddenPath, hiddenBytes);
    const hashFunction = /function FileHash\(\$path\) \{[\s\S]*?\n\}/.exec(port.commands[0].source)![0];
    const hiddenProbe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; ${hashFunction}; $path='${hiddenPath}'; ` +
      "if ($IsWindows) { [IO.File]::SetAttributes($path, [IO.FileAttributes]::Hidden) }; " +
      "$info=Get-Item -LiteralPath $path -Force; " +
      `if ($info.Length -ne ${hiddenBytes.length} -or (FileHash $path) -ne '${createHash("sha256").update(hiddenBytes).digest("hex")}') { throw 'Hidden inventory mismatch' }; ` +
      "[IO.File]::AppendAllText($path,'tampered'); " +
      `if ((FileHash $path) -eq '${createHash("sha256").update(hiddenBytes).digest("hex")}') { throw 'Hidden drift was not detected' }`],
    { encoding: "utf8", timeout: 30000 });
    assert.equal(hiddenProbe.status, 0, hiddenProbe.stdout + hiddenProbe.stderr);
    const genuine = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      join(bundleRoot, ".github", "skills", "squad", "scripts", "Initialize-SquadConsumptionRates.ps1"),
      "-SquadRoot", dir, "-Mode", "economy"], { encoding: "utf8", timeout: 30000 });
    assert.equal(genuine.status, 0, genuine.stderr);
    const rates = readFileSync(join(dir, "consumption-rates.md"), "utf8");
    assert.match(rates, /Per-model token rates/);
    assert.match(rates, /Dispatch-size estimator/);
    assert.match(rates, /gpt-5-mini/);
    // Execute the genuine server initialization logic locally, adapting only fixed
    // Linux paths and the native `test -f` probe for this Windows test host.
    const payload = { ...port.commands[0].payload, workspace: join(dir, "mirror") };
    const data = Buffer.from(JSON.stringify(payload));
    const dataPath = join(dir, "transport.json");
    writeFileSync(dataPath, data);
    const originalSource = port.commands[0].source;
    const originalPath = /\$dataPath = '([^']+)'/.exec(originalSource)![1];
    let local = originalSource.replaceAll(originalPath, dataPath)
      .replaceAll("/opt/hve-upstream", bundleRoot)
      .replace(/if \(\$p\.workspace -notmatch '[^']+'\) \{ throw 'Bad workspace' \}/, "")
      .replaceAll("'/workspace/.hve-upstream'", `'${dir}'`)
      .replace("Regular '/workspace' $true", `Regular '${dir}' $true`)
      .replace("& /usr/bin/test '-f' $path", "$global:LASTEXITCODE = 0")
      .replace(/^\s*\$responseOptions\.UnixCreateMode = .*$/m, "");
    local = local.replace(/if \(\$data\.Length -ne \d+ -or ([^\n]+?) -ne '[a-f0-9]{64}'\)/,
      `if ($data.Length -ne ${data.length} -or $1 -ne '${createHash("sha256").update(data).digest("hex")}')`);
    const executed = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(local, "utf16le").toString("base64")], { encoding: "utf8", timeout: 60000, maxBuffer: 12000000 });
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    const receipt = JSON.parse(executed.stdout);
    assert.equal(receipt.operation, "response");
    const responseBytes = readFileSync(dataPath + ".response");
    assert.equal(responseBytes.length, receipt.bytes);
    assert.equal(createHash("sha256").update(responseBytes).digest("hex"), receipt.sha256);
    const envelope = JSON.parse(responseBytes.toString("utf8"));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.files.length, 3);
    assert.deepEqual(envelope.files.map((f: { path: string }) => f.path).sort(), payload.files!.map(f => f.path).sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
