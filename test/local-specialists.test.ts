import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";
import {
  LocalSpecialists, LocalSpecialistError, LOCAL_CONVERTER_SHA256, validateLocalGraphviz,
  type LocalBinaryArtifact, type LocalSpecialistCommandPort, type LocalSpecialistReceipt,
  type LocalSpecialistRequest,
} from "../src/engine/copilot/local-specialists.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(48_123, 42)]);
const docx = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.alloc(123, 42)]);
const graphRequest: LocalSpecialistRequest = { operation: "graphviz-to-png", inputPath: "docs/example.dot", outputPath: "outputs/example.png" };
const mdRequest: LocalSpecialistRequest = { operation: "markdown-to-docx", inputPath: ".copilot-tracking/docs/example.md", outputPath: "outputs/example.docx" };
type Payload = Record<string, unknown>;
function unpack(command: string): { script: string; payload: Payload } {
  assert.ok(Buffer.byteLength(command) < 64_000);
  assert.match(command, /^pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  const match = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)!;
  return { script, payload: JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Payload };
}
class FakePort implements LocalSpecialistCommandPort {
  readonly calls: { script: string; payload: Payload }[] = [];
  readonly staged: Buffer[] = [];
  output = png;
  mutate?: (phase: string, receipt: Payload) => Payload;
  async runServerCommand(command: string) {
    const call = unpack(command);
    this.calls.push(call);
    const p = call.payload;
    let receipt: Payload;
    let phase: string;
    if ("probes" in p) {
      phase = "discovery";
      receipt = { ok: true, linux: true, markdown: true,
        probes: (p.probes as Payload[]).map(probe => ({ id: probe.id, present: probe.id !== "pandoc" })) };
    } else if ("base64" in p) {
      phase = "write";
      assert.equal(p.offset, Buffer.concat(this.staged).length);
      this.staged.push(Buffer.from(p.base64 as string, "base64"));
      receipt = { ok: true, phase, offset: (p.offset as number) + this.staged.at(-1)!.length };
    } else if ("operation" in p) {
      phase = "execute";
      assert.equal(hash(Buffer.concat(this.staged)), p.inputSha256);
      receipt = { ok: true, phase, operation: p.operation, inputSha256: p.inputSha256,
        sha256: hash(this.output), byteLength: this.output.length, exitCode: 0,
        converterSha256: p.operation === "markdown-to-docx" ? LOCAL_CONVERTER_SHA256 : null };
    } else if ("total" in p) {
      phase = "read";
      const offset = p.offset as number;
      receipt = { ok: true, phase, offset, base64: this.output.subarray(offset, offset + 24_000).toString("base64") };
    } else if (call.script.includes("phase='cleanup'")) {
      phase = "cleanup"; receipt = { ok: true, phase };
    } else { phase = "init"; receipt = { ok: true, phase }; }
    receipt = this.mutate?.(phase, receipt) ?? receipt;
    return { success: receipt.ok === true, exitCode: receipt.ok === true ? 0 : 1, output: JSON.stringify(receipt) };
  }
}
function harness(text = "digraph G { a -> b; a [label=\"Hello\"]; }") {
  const port = new FakePort();
  const artifacts: LocalBinaryArtifact[] = [];
  const receipts: LocalSpecialistReceipt[] = [];
  const reads: string[] = [];
  const adapter = new LocalSpecialists({ port,
    readTextArtifact: async path => { reads.push(path); return text; },
    writeBinaryArtifact: async (artifact, receipt) => { artifacts.push(artifact); receipts.push(receipt); },
  });
  return { adapter, port, artifacts, receipts, reads };
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof LocalSpecialistError && error.code === code;
}

test("converter identity is pinned to the verified bundled script", () => {
  const bytes = readFileSync(new URL("../host/upstream-runtime/.github/skills/md-to-docx/scripts/md-to-docx.mjs", import.meta.url));
  assert.equal(hash(bytes), LOCAL_CONVERTER_SHA256);
});

test("discovery separates installed dependencies from callable, deferred, unsupported and absent capabilities", async () => {
  const h = harness();
  const capabilities = await h.adapter.listCapabilities();
  assert.deepEqual(capabilities.filter(c => c.callable).map(c => c.id), ["markdown-to-docx", "graphviz-to-png"]);
  assert.deepEqual(capabilities.find(c => c.id === "pandoc"), { id: "pandoc", status: "unavailable", callable: false });
  assert.equal(capabilities.find(c => c.id === "authenticated-per-user-bindings")?.status, "auth-deferred");
  assert.equal(capabilities.find(c => c.id === "windows-desktop-automation")?.status, "windows-unsupported");
  assert.equal(capabilities.filter(c => c.id.startsWith("python-env:")).length, 20);
  assert.ok(capabilities.filter(c => c.id.startsWith("python-env:")).every(c => !c.callable));
  assert.equal(h.artifacts.length, 0);
  assert.doesNotMatch(h.port.calls[0].script, /Get-ChildItem\s+Env:|Get-Item\s+Env:|\$env:|GetEnvironmentVariables/i);
});

test("graph rendering returns complete typed binary bytes and a matching receipt, not text artifacts", async () => {
  const h = harness();
  const receipt = await h.adapter.execute(graphRequest);
  assert.equal(receipt.byteLength, png.length);
  assert.equal(receipt.sha256, hash(png));
  assert.equal(receipt.inputSha256, hash(Buffer.concat(h.port.staged)));
  assert.equal(receipt.exitCode, 0);
  assert.equal(h.artifacts[0].mediaType, "image/png");
  assert.equal(h.artifacts[0].path, graphRequest.outputPath);
  assert.deepEqual(Buffer.from(h.artifacts[0].bytes), png);
  assert.equal(h.port.calls.filter(c => "total" in c.payload).length, 3);
  const execute = h.port.calls.find(c => "operation" in c.payload)!;
  assert.match(execute.script, /FileName = '\/usr\/bin\/dot'/);
  assert.match(execute.script, /@\('-Tpng', '-o', \$p.output, \$p.input\)/);
  assert.match(execute.script, /Environment.Clear\(\)/);
  assert.match(execute.script, /Kill\(\$true\)/);
  assert.match(execute.payload.guard as string, /resource.setrlimit\(resource.RLIMIT_FSIZE, \(8000000, 8000000\)\)/);
  assert.match(execute.payload.root as string, /^\/workspace\/\.hve-local\/[a-f0-9-]{36}$/);
  assert.notEqual(execute.payload.input, graphRequest.inputPath);
  assert.ok(h.port.calls.at(-1)!.script.includes("[IO.Directory]::Delete($p.root, $false)"));
  assert.ok(h.port.calls.every(c => !/Remove-Item|Recurse|GetEnvironmentVariables|\$env:/i.test(c.script)));
});

test("Markdown contract runs exact upstream converter with per-call SHA checks and inert image denial", async () => {
  const h = harness("# A document\n\nOrdinary **content**, not an invoice.");
  h.port.output = docx;
  const receipt = await h.adapter.execute(mdRequest);
  assert.equal(h.artifacts[0].mediaType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.deepEqual(Buffer.from(h.artifacts[0].bytes), docx);
  assert.equal(receipt.converterSha256, LOCAL_CONVERTER_SHA256);
  const execute = h.port.calls.find(c => "operation" in c.payload)!;
  assert.match(execute.script, new RegExp(LOCAL_CONVERTER_SHA256));
  assert.match(execute.script, /Regular '\/opt\/hve-upstream\/\.github\/skills\/md-to-docx\/scripts\/md-to-docx.mjs'/);
  const runner = execute.payload.runner as string;
  assert.match(runner, /marked.walkTokens/);
  assert.match(runner, /t.type === 'image'/);
  assert.match(runner, /md-to-docx--scripts\/md-to-docx.mjs', input, output/);
  assert.match(runner, /--experimental-permission/);
  assert.match(runner, /stdio:'ignore'/);
  assert.doesNotMatch(runner, /pandoc|fetch\(|https?:\/\//);
});

test("untrusted payloads use bounded base64 chunks, not shell interpolation", async () => {
  const text = "# Heading\n\n" + "a '$();` & | <tag> \n".repeat(8_000);
  const h = harness(text);
  h.port.output = docx;
  await h.adapter.execute(mdRequest);
  assert.ok(h.port.staged.length > 5);
  assert.deepEqual(Buffer.concat(h.port.staged), Buffer.from(text));
  assert.ok(h.port.staged.every(c => c.length <= 12_000));
  assert.ok(h.port.calls.every(c => !c.script.includes(text)));
});

test("only named operations and project artifact scope are accepted before any I/O", async () => {
  const unsafe = [
    { ...graphRequest, operation: "shell" }, { ...graphRequest, command: "env" },
    { ...graphRequest, inputPath: "/etc/passwd" }, { ...graphRequest, inputPath: "docs/../secret.dot" },
    { ...graphRequest, inputPath: "docs\\example.dot" }, { ...graphRequest, inputPath: "docs/secrets.dot" },
    { ...graphRequest, outputPath: "outputs/result.md" }, { ...mdRequest, outputPath: "outputs/.env.docx" },
    { ...graphRequest, outputPath: "outputs/x;env.png" }, { ...graphRequest, inputPath: "docs//a.dot" },
  ];
  for (const request of unsafe) {
    const h = harness();
    await assert.rejects(h.adapter.execute(request as LocalSpecialistRequest), LocalSpecialistError);
    assert.equal(h.port.calls.length, 0);
    assert.equal(h.reads.length, 0);
  }
});

test("DOT dialect blocks local file references, HTML images, URL and disguised quoted attributes", () => {
  for (const dot of [
    'digraph G { a [image="/etc/passwd"]; }', 'digraph G { a ["image"="/etc/passwd"]; }',
    'digraph G { a [shapefile="/etc/passwd"]; }', 'digraph G { a [URL="https://example.com"]; }',
    'digraph G { a [label=<<IMG SRC="/etc/passwd"/>>]; }',
    'digraph G { a [fontpath="/etc"]; }', 'digraph G { a [stylesheet="https://example.com"]; }',
    'digraph G { a [image /* comment */ = "a.png"]; }', 'digraph G { a [label="x"]; #include "x" }',
  ]) assert.throws(() => validateLocalGraphviz(dot), errorCode("unsafe_graphviz"));
  validateLocalGraphviz('strict digraph G { rankdir=LR; a -> b [label="line\\ntext"]; /* safe */ }');
  validateLocalGraphviz('graph G { a -- b; a [label="image=\\"inert\\""]; }');
});

test("secret-like content, invalid Unicode and oversized inputs never cross the command port", async () => {
  for (const text of [
    "# Secret\npassword=abcdefghijklmnopqrst", "ghp_" + "x".repeat(30),
    "-----BEGIN PRIVATE KEY-----", "\uD800", "x".repeat(256_001), "a\0b",
  ]) {
    const h = harness(text);
    await assert.rejects(h.adapter.execute(mdRequest), LocalSpecialistError);
    assert.equal(h.port.calls.length, 0);
    assert.equal(h.artifacts.length, 0);
  }
});

test("native exit, image rejection and changed script SHA are explicit failures and never reach sink", async () => {
  for (const code of ["native_exit", "unsafe_markdown", "bundle_integrity", "deadline", "output_too_large"]) {
    const h = harness("# Test");
    h.port.mutate = (phase, receipt) => phase === "execute" ? { ok: false, code, exitCode: 65 } : receipt;
    await assert.rejects(h.adapter.execute(mdRequest), errorCode(code));
    assert.equal(h.artifacts.length, 0);
    assert.match(h.port.calls.at(-1)!.script, /phase='cleanup'/);
  }
});

test("complete length, content SHA, binary type and receipt identity must all verify before persistence", async () => {
  for (const mutation of [
    (p: string, r: Payload) => p === "execute" ? { ...r, operation: "markdown-to-docx" } : r,
    (p: string, r: Payload) => p === "execute" ? { ...r, inputSha256: "a".repeat(64) } : r,
    (p: string, r: Payload) => p === "execute" ? { ...r, byteLength: 8_000_001 } : r,
    (p: string, r: Payload) => p === "execute" ? { ...r, sha256: "b".repeat(64) } : r,
    (p: string, r: Payload) => p === "read" ? { ...r, base64: "AA==" } : r,
    (p: string, r: Payload) => p === "read" ? { ...r, offset: 2 } : r,
    (p: string, r: Payload) => p === "read" ? { ...r, base64: r.base64 + "\n" } : r,
  ]) {
    const h = harness();
    h.port.mutate = mutation;
    await assert.rejects(h.adapter.execute(graphRequest), LocalSpecialistError);
    assert.equal(h.artifacts.length, 0);
  }
  const h = harness();
  h.port.output = Buffer.from("This is NOT binary output.");
  await assert.rejects(h.adapter.execute(graphRequest), errorCode("output_type"));
  assert.equal(h.artifacts.length, 0);
});

test("upstream output and transport errors do not disclose raw diagnostic or environment content", async () => {
  const adapter = new LocalSpecialists({
    port: { runServerCommand: async () => { throw new Error("SECRET_TOKEN=not-for-user"); } },
    readTextArtifact: async () => "# Content", writeBinaryArtifact: async () => assert.fail("No sink call"),
  });
  await assert.rejects(adapter.execute(mdRequest), error => {
    assert.ok(errorCode("transport_failed")(error));
    assert.doesNotMatch(String(error), /SECRET_TOKEN/);
    return true;
  });
});

test("missing sources and malformed or oversized command receipts fail closed", async () => {
  const missing = new LocalSpecialists({ port: new FakePort(), readTextArtifact: async () => undefined,
    writeBinaryArtifact: async () => assert.fail("No sink call") });
  await assert.rejects(missing.execute(mdRequest), errorCode("input_not_found"));
  for (const output of ["not json SECRET_TOKEN=hidden", "x".repeat(40_001), '{"ok":true}', '[]']) {
    const adapter = new LocalSpecialists({
      port: { runServerCommand: async () => ({ success: true, exitCode: 0, output }) },
      readTextArtifact: async () => "# Content", writeBinaryArtifact: async () => assert.fail("No sink call"),
    });
    await assert.rejects(adapter.listCapabilities(), error => {
      assert.ok(errorCode("invalid_receipt")(error));
      assert.doesNotMatch(String(error), /SECRET_TOKEN/);
      return true;
    });
  }
});

test("source and sink errors are sanitized; both receive the deadline contract", async () => {
  const h = harness();
  const sourceFailure = new LocalSpecialists({ port: h.port,
    readTextArtifact: async () => { throw Error("SECRET_SOURCE"); },
    writeBinaryArtifact: async () => assert.fail("No sink call") });
  await assert.rejects(sourceFailure.execute(mdRequest), errorCode("source_failed"));
  assert.equal(h.port.calls.length, 0);
  const adapter = new LocalSpecialists({ port: h.port,
    readTextArtifact: async (_path, control) => { assert.ok(control!.timeoutMs > 0); return "digraph G { a; }"; },
    writeBinaryArtifact: async (artifact, receipt, control) => {
      assert.equal(hash(artifact.bytes), artifact.sha256);
      assert.equal(receipt.sha256, artifact.sha256);
      assert.ok(control!.timeoutMs > 0);
      throw Error("SECRET_SINK");
    } });
  await assert.rejects(adapter.execute(graphRequest), errorCode("sink_failed"));
  assert.match(h.port.calls.at(-1)!.script, /phase='cleanup'/);
});

test("abort and deadline prohibit output publication; native execution has its own bound", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.adapter.execute(graphRequest, controller.signal), errorCode("aborted"));
  assert.equal(h.port.calls.length, 0);
  const adapter = new LocalSpecialists({
    timeoutMs: 100, port: { runServerCommand: async () => new Promise(() => {}) },
    readTextArtifact: async () => "# Content", writeBinaryArtifact: async () => assert.fail("No sink call"),
  });
  await assert.rejects(adapter.execute(mdRequest), errorCode("deadline"));
  const slowSource = new LocalSpecialists({
    timeoutMs: 100, port: h.port, readTextArtifact: async () => new Promise(() => {}),
    writeBinaryArtifact: async () => assert.fail("No sink call"),
  });
  await assert.rejects(slowSource.execute(mdRequest), errorCode("deadline"));
  assert.equal(h.port.calls.length, 0);
  const controller2 = new AbortController();
  const promise = new LocalSpecialists({
    port: { runServerCommand: async () => new Promise(() => {}) },
    readTextArtifact: async () => "# Content", writeBinaryArtifact: async () => assert.fail("No sink call"),
  }).execute(mdRequest, controller2.signal);
  setTimeout(() => controller2.abort(), 20);
  await assert.rejects(promise, errorCode("aborted"));
});

const exec = promisify(execFile);
const realPort: LocalSpecialistCommandPort = {
  async runServerCommand(command, control) {
    const args = command.split(" ").slice(1);
    try {
      const { stdout } = await exec("pwsh", args, { timeout: control?.timeoutMs ?? 30_000, maxBuffer: 64_000 });
      return { success: true, exitCode: 0, output: stdout };
    } catch (error) {
      const e = error as { stdout?: string; code?: number };
      return { success: false, exitCode: typeof e.code === "number" ? e.code : 1, output: e.stdout ?? "" };
    }
  },
};
let pwshPresent = false;
try { await exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "'ready'"], { timeout: 15_000 }); pwshPresent = true; } catch { /* Optional local integration prerequisite. */ }

test("real PowerShell parses every generated Linux execution and transport script", { skip: !pwshPresent }, async () => {
  const h = harness();
  await h.adapter.execute(graphRequest);
  const parser = exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
$scripts = [Console]::In.ReadToEnd() | ConvertFrom-Json
$count = 0
foreach ($script in $scripts) {
  $tokens = $null; $errors = $null
  $null = [Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { Write-Output 'parse_failed'; exit 1 }
  $count++
}
Write-Output $count
`], { timeout: 15_000 });
  parser.child.stdin?.end(JSON.stringify(h.port.calls.map(c => c.script)));
  const { stdout } = await parser;
  assert.equal(Number(stdout.trim()), h.port.calls.length);
});

test("real PowerShell discovery is secretless and Windows execution is explicitly unsupported", { skip: !pwshPresent }, async () => {
  const adapter = new LocalSpecialists({ port: realPort,
    readTextArtifact: async () => "# Content", writeBinaryArtifact: async () => assert.fail("No Windows output"),
  });
  const capabilities = await adapter.listCapabilities();
  if (process.platform === "win32") {
    assert.ok(capabilities.filter(c => c.status === "installed").length === 0);
    await assert.rejects(adapter.execute(mdRequest), errorCode("linux_required"));
  }
});

test("real Linux Graphviz renders actual PNG, not fixture bytes", {
  skip: !pwshPresent || process.platform !== "linux" || !existsSync("/usr/bin/dot") || !existsSync("/workspace"),
}, async () => {
  let artifact: LocalBinaryArtifact | undefined;
  const adapter = new LocalSpecialists({ port: realPort,
    readTextArtifact: async () => 'digraph G { a -> b; a [label="Actual local rendering"]; }',
    writeBinaryArtifact: async a => { artifact = a; },
  });
  const receipt = await adapter.execute(graphRequest);
  assert.ok(artifact);
  assert.equal(hash(artifact.bytes), receipt.sha256);
  const bytes = Buffer.from(artifact.bytes);
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  assert.ok(bytes.readUInt32BE(16) > 0);
  assert.ok(bytes.readUInt32BE(20) > 0);
});

test("real Linux upstream Markdown produces DOCX ZIP with expected document content and denies local images", {
  skip: !pwshPresent || process.platform !== "linux" ||
    !existsSync("/opt/hve-specialist-node/md-to-docx--scripts/md-to-docx.mjs") || !existsSync("/workspace"),
}, async () => {
  let artifact: LocalBinaryArtifact | undefined;
  let text = "# Actual document\n\nUnique specialist content 1976.";
  const adapter = new LocalSpecialists({ port: realPort,
    readTextArtifact: async () => text, writeBinaryArtifact: async a => { artifact = a; },
  });
  await adapter.execute(mdRequest);
  assert.ok(artifact);
  // Read the DOCX local ZIP entries; no temporary file or new test dependency is required.
  const { inflateRawSync } = await import("node:zlib");
  const zip = Buffer.from(artifact.bytes);
  let xml = "";
  for (let i = 0; i + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(i) !== 0x02014b50) continue;
    const size = zip.readUInt32LE(i + 20);
    const nameLength = zip.readUInt16LE(i + 28);
    if (zip.subarray(i + 46, i + 46 + nameLength).toString() !== "word/document.xml") continue;
    const local = zip.readUInt32LE(i + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + size);
    xml = (zip.readUInt16LE(i + 10) === 8 ? inflateRawSync(body) : body).toString("utf8");
    break;
  }
  assert.match(xml, /Unique specialist content 1976/);
  for (const unsafe of ["![secret](/etc/passwd)", "![secret][x]\n\n[x]: /etc/passwd",
    "> ![secret](../../etc/passwd)", "---\ntitle: Test\n---\n\n![secret](/etc/passwd)"]) {
    text = unsafe;
    artifact = undefined;
    await assert.rejects(adapter.execute(mdRequest), errorCode("unsafe_markdown"));
    assert.equal(artifact, undefined);
  }
});
