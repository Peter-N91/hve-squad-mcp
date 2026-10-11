import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { CopilotServerCommandResult } from "./copilot-stage-executor.js";

export const LOCAL_CONVERTER_SHA256 = "3b1b3dbd02523fb488f4a5ccc313be4a7484d4433c224ccb750c71a6f023ee9c";
const CONVERTER = "/opt/hve-specialist-node/md-to-docx--scripts/md-to-docx.mjs";
const SOURCE_CONVERTER = "/opt/hve-upstream/.github/skills/md-to-docx/scripts/md-to-docx.mjs";
const MAX_INPUT = 256_000;
const MAX_OUTPUT = 8_000_000;
const INPUT_CHUNK = 12_000;
const OUTPUT_CHUNK = 24_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type LocalSpecialistOperation = "markdown-to-docx" | "graphviz-to-png";
export type LocalCapabilityStatus = "installed" | "unavailable" | "auth-deferred" | "windows-unsupported";
export interface LocalSpecialistCapability {
  readonly id: string;
  readonly status: LocalCapabilityStatus;
  readonly callable: boolean;
}
export interface LocalSpecialistRequest {
  readonly operation: LocalSpecialistOperation;
  readonly inputPath: string;
  readonly outputPath: string;
}
export interface LocalBinaryArtifact {
  readonly path: string;
  readonly mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "image/png";
  readonly bytes: Uint8Array;
  readonly sha256: string;
}
export interface LocalSpecialistReceipt {
  readonly operation: LocalSpecialistOperation;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly inputSha256: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly exitCode: 0;
  readonly converterSha256?: string;
}
export interface LocalSpecialistCommandPort {
  /** Signal/deadline support is optional for SDK ports; native subprocesses also have a hard deadline. */
  runServerCommand(command: string, control?: { signal?: AbortSignal; timeoutMs: number }): Promise<CopilotServerCommandResult>;
}
export interface LocalSpecialistsOptions {
  readonly port: LocalSpecialistCommandPort;
  /** Bound by trusted runtime code to ONE tenant/project; never reads sandbox paths. */
  readonly readTextArtifact: (path: string, control?: { signal?: AbortSignal; timeoutMs: number }) => Promise<string | undefined>;
  /**
   * Trusted binary store, not SquadArtifactStore's text put. Receives only verified bytes.
   * Implementations must independently verify sha256 and honor cancellation before committing.
   */
  readonly writeBinaryArtifact: (artifact: LocalBinaryArtifact, receipt: LocalSpecialistReceipt,
    control?: { signal?: AbortSignal; timeoutMs: number }) => Promise<void>;
  readonly timeoutMs?: number;
}
export class LocalSpecialistError extends Error {
  constructor(readonly code: string) {
    super(`Local specialist failed: ${code}.`);
    this.name = "LocalSpecialistError";
  }
}
function fail(code: string): never { throw new LocalSpecialistError(code); }
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function artifactPath(path: unknown, extension: string): asserts path is string {
  if (typeof path !== "string" || path.length > 240 ||
      !/^(?:docs|outputs|\.copilot-tracking)\/[A-Za-z0-9._/-]+$/.test(path) ||
      path.split("/").some(p => !p || p === "." || p === "..") ||
      /(?:^|\/)(?:\.env|credentials?|secrets?|tokens?|id_rsa)(?:[./_-]|$)/i.test(path) ||
      !path.endsWith(extension)) fail("unsafe_path");
}
function safeText(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (!bytes.length || bytes.length > MAX_INPUT || utf8.decode(bytes) !== text || text.includes("\0")) fail("invalid_input");
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})|(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|authorization)\s*[:=]\s*["']?(?!<|redacted\b|\*{3})[A-Za-z0-9+/._=-]{12,}/i.test(text)) fail("secret_detected");
  return bytes;
}

/** Deliberately small DOT dialect: no HTML, includes, image/shape files, URLs, or plugins. */
export function validateLocalGraphviz(dot: string): void {
  const allowed = new Set(["label", "shape", "color", "fillcolor", "style", "fontsize", "fontcolor",
    "rankdir", "rank", "width", "height", "penwidth", "arrowhead", "arrowsize", "nodesep", "ranksep"]);
  const tokens: string[] = [];
  const lexer = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\x00-\x1f]|\\["\\nrt])*"|(?:[A-Za-z_][A-Za-z0-9_]*|-?(?:\d+(?:\.\d*)?|\.\d+))|->|--|[{}\[\];,=]/gy;
  let offset = 0;
  while (offset < dot.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(dot);
    if (!match) fail("unsafe_graphviz");
    offset = lexer.lastIndex;
    if (!/^\s|^\/[/*]/.test(match[0])) tokens.push(match[0]);
  }
  if (!/^(?:strict )?(?:di)?graph\b/.test(tokens.slice(0, 2).join(" "))) fail("unsafe_graphviz");
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "=" && !allowed.has(tokens[i - 1])) fail("unsafe_graphviz");
  }
}

const PYTHON_ENVS = [
  "accessibility--accessibility", "data-science-engineering--data-catalog", "data-science-engineering--dataops",
  "data-science-engineering--evaluation-design", "data-science-engineering--feasibility",
  "experimental--copilot-otel-metrics", "experimental--customer-card-render", "experimental--demo-video",
  "experimental--hve-demo-material", "experimental--mural", "experimental--powerpoint",
  "experimental--tts-voiceover", "experimental--vscode-playwright", "hve-core--architecture-diagrams",
  "hve-core--vally-tests", "project-planning--adr-author", "project-planning--gitlab",
  "project-planning--jira", "project-planning--security-planning", "security--vex",
] as const;
const PROBES: readonly { id: string; path: string }[] = [
  { id: "python3", path: "/usr/bin/python3" }, { id: "uv", path: "/opt/hve-tools/bin/uv" },
  { id: "pwsh", path: "/usr/bin/pwsh" }, { id: "ffmpeg", path: "/usr/bin/ffmpeg" },
  { id: "soffice", path: "/usr/bin/soffice" }, { id: "graphviz", path: "/usr/bin/dot" },
  { id: "pandoc", path: "/usr/bin/pandoc" },
  { id: "chromium-runtime", path: "/opt/ms-playwright" },
  ...PYTHON_ENVS.map(id => ({ id: `python-env:${id}`, path: `/opt/hve-specialists/${id}/bin/python` })),
  ...["accessibility--accessibility--scripts--runtime_a11y", "hve-slides--templates--deck", "md-to-docx--scripts"]
    .map(id => ({ id: `node-env:${id}`, path: `/opt/hve-specialist-node/${id}/node_modules` })),
];

// This trusted code is constant, never supplied by the caller or copied from an input artifact.
// The upstream lexer must reject every image token: the converter otherwise resolves local image paths.
const MARKDOWN_RUNNER = `
const fs = require('node:fs'), cp = require('node:child_process');
(async () => {
  const [input, output, root, timeout] = process.argv.slice(1);
  const {marked} = await import('/opt/hve-specialist-node/md-to-docx--scripts/node_modules/marked/lib/marked.esm.js');
  const md = fs.readFileSync(input, 'utf8').replace(/^---[\\s\\S]*?---\\n*/m, '');
  const tokens = marked.lexer(md);
  let image = false;
  marked.walkTokens(tokens, t => { if (t.type === 'image') image = true; });
  if (image) process.exit(65);
  const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  const result = cp.spawnSync('/usr/local/bin/node', [
    permissionFlag, '--allow-fs-read=' + root,
    '--allow-fs-read=/opt/hve-specialist-node/md-to-docx--scripts',
    '--allow-fs-write=' + root,
    '${CONVERTER}', input, output
  ], {cwd:root, env:{PATH:'/usr/local/bin:/usr/bin:/bin', HOME:root, TMPDIR:root, LANG:'C.UTF-8'},
      stdio:'ignore', timeout:Number(timeout), killSignal:'SIGKILL'});
  process.exit(result.error ? 70 : (result.status ?? 70));
})().catch(() => process.exit(70));
`;
const FILE_SIZE_GUARD = `
import os, resource, sys
resource.setrlimit(resource.RLIMIT_FSIZE, (${MAX_OUTPUT}, ${MAX_OUTPUT}))
os.execve(sys.argv[1], sys.argv[1:], dict(os.environ))
`;

const PREAMBLE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($v) { ConvertTo-Json -InputObject $v -Depth 8 -Compress }
function Regular([string]$f) {
  $item = Get-Item -LiteralPath $f -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe_file' }
}
function Hash([byte[]]$b) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($b)).ToLowerInvariant() }
function CheckRoot([string]$root) {
  foreach ($d in @('/workspace', '/workspace/.hve-local', $root)) {
    $item = Get-Item -LiteralPath $d -Force
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe_directory' }
  }
}
`;
function command(body: string, payload: Record<string, unknown>): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64");
  const script = PREAMBLE + `
try {
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPayload}')) | ConvertFrom-Json
  ${body}
} catch { Emit @{ok=$false; code='execution_failed'}; exit 1 }
`;
  const result = `pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  if (Buffer.byteLength(result) >= 64_000) fail("command_too_large");
  return result;
}

const INIT = `
if (!$IsLinux) { Emit @{ok=$false; code='linux_required'}; exit 1 }
foreach ($d in @('/workspace', '/workspace/.hve-local')) {
  if (!(Test-Path -LiteralPath $d)) { [IO.Directory]::CreateDirectory($d) | Out-Null }
  $item = Get-Item -LiteralPath $d -Force
  if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe_directory' }
}
if (Test-Path -LiteralPath $p.root) { throw 'existing_directory' }
[IO.Directory]::CreateDirectory($p.root) | Out-Null
[IO.File]::SetUnixFileMode($p.root, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute)
CheckRoot $p.root
$s = [IO.File]::Open($p.input, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $s.Dispose()
Emit @{ok=$true; phase='init'}
`;
const WRITE = `
CheckRoot $p.root; Regular $p.input
$b = [Convert]::FromBase64String($p.base64)
$s = [IO.File]::Open($p.input, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  if ($s.Length -ne $p.offset -or ($s.Length + $b.Length) -gt ${MAX_INPUT}) { throw 'bad_offset' }
  $s.Position = $s.Length; $s.Write($b, 0, $b.Length)
} finally { $s.Dispose() }
Emit @{ok=$true; phase='write'; offset=($p.offset + $b.Length)}
`;
const EXECUTE = `
CheckRoot $p.root; Regular $p.input
if ((Hash ([IO.File]::ReadAllBytes($p.input))) -cne $p.inputSha256) { throw 'input_integrity' }
if (Test-Path -LiteralPath $p.output) { throw 'existing_output' }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.UseShellExecute = $false; $info.WorkingDirectory = $p.root
$info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
$info.Environment.Clear()
$info.Environment['PATH'] = '/usr/local/bin:/usr/bin:/bin'
$info.Environment['HOME'] = $p.root; $info.Environment['TMPDIR'] = $p.root; $info.Environment['LANG'] = 'C.UTF-8'
if ($p.operation -ceq 'markdown-to-docx') {
  Regular '${CONVERTER}'; Regular '${SOURCE_CONVERTER}'
  if ((Hash ([IO.File]::ReadAllBytes('${CONVERTER}'))) -cne '${LOCAL_CONVERTER_SHA256}' -or
      (Hash ([IO.File]::ReadAllBytes('${SOURCE_CONVERTER}'))) -cne '${LOCAL_CONVERTER_SHA256}') {
    Emit @{ok=$false; code='bundle_integrity'}; exit 1
  }
  $info.FileName = '/usr/local/bin/node'
  foreach ($a in @('-e', $p.runner, $p.input, $p.output, $p.root, [string]$p.timeout)) { $info.ArgumentList.Add($a) }
} else {
  $info.FileName = '/usr/bin/dot'
  foreach ($a in @('-Tpng', '-o', $p.output, $p.input)) { $info.ArgumentList.Add($a) }
}
$native = $info.FileName
$nativeArgs = @($info.ArgumentList)
$info.ArgumentList.Clear()
$info.FileName = '/usr/bin/python3'
foreach ($a in @('-c', $p.guard, $native) + $nativeArgs) { $info.ArgumentList.Add([string]$a) }
$proc = [Diagnostics.Process]::new(); $proc.StartInfo = $info
try {
  $null = $proc.Start()
  $stdout = $proc.StandardOutput.ReadToEndAsync(); $stderr = $proc.StandardError.ReadToEndAsync()
  if (!$proc.WaitForExit([int]$p.timeout)) {
    $proc.Kill($true); $proc.WaitForExit()
    Emit @{ok=$false; code='deadline'}; exit 1
  }
  if ($proc.ExitCode -ne 0) {
    $code = if ($proc.ExitCode -eq 65) { 'unsafe_markdown' }
      elseif ((Test-Path -LiteralPath $p.output) -and (Get-Item -LiteralPath $p.output).Length -ge ${MAX_OUTPUT}) { 'output_too_large' }
      else { 'native_exit' }
    Emit @{ok=$false; code=$code; exitCode=$proc.ExitCode}; exit 1
  }
} finally { $proc.Dispose() }
Regular $p.output
$size = (Get-Item -LiteralPath $p.output).Length
if ($size -le 0 -or $size -gt ${MAX_OUTPUT}) { Emit @{ok=$false; code='output_too_large'}; exit 1 }
$hash = Hash ([IO.File]::ReadAllBytes($p.output))
Emit @{ok=$true; phase='execute'; operation=$p.operation; inputSha256=$p.inputSha256;
  sha256=$hash; byteLength=$size; exitCode=0; converterSha256=$(if ($p.operation -ceq 'markdown-to-docx') {'${LOCAL_CONVERTER_SHA256}'} else {$null})}
`;
const READ = `
CheckRoot $p.root; Regular $p.output
$s = [IO.File]::Open($p.output, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  if ($s.Length -ne $p.total -or $p.offset -lt 0 -or $p.offset -ge $s.Length) { throw 'bad_output' }
  $s.Position = $p.offset
  $n = [int][Math]::Min(${OUTPUT_CHUNK}, $s.Length - $p.offset)
  $b = [byte[]]::new($n); $s.ReadExactly($b, 0, $n)
  Emit @{ok=$true; phase='read'; offset=$p.offset; base64=[Convert]::ToBase64String($b)}
} finally { $s.Dispose() }
`;
const CLEANUP = `
CheckRoot $p.root
foreach ($f in @($p.input, $p.output)) {
  if (Test-Path -LiteralPath $f) { Regular $f; [IO.File]::Delete($f) }
}
[IO.Directory]::Delete($p.root, $false)
Emit @{ok=$true; phase='cleanup'}
`;

/**
 * Local, non-network, named operations only. Binary persistence is delegated to a trusted sink.
 * The runtime must keep .hve-local private from model filesystem tools and cap concurrent calls.
 * No process cancellation can be guaranteed by SDK ports that ignore control.signal; native
 * work still expires at its hard deadline. Cleanup is best-effort on disconnected/aborted ports.
 */
export class LocalSpecialists {
  private readonly timeoutMs: number;
  constructor(private readonly options: LocalSpecialistsOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) fail("invalid_deadline");
  }
  private async bounded<T>(work: (control: { signal?: AbortSignal; timeoutMs: number }) => Promise<T>,
    deadline: number, signal: AbortSignal | undefined, failureCode: string): Promise<T> {
    if (signal?.aborted) fail("aborted");
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        work({ signal, timeoutMs: remaining }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LocalSpecialistError("deadline")), remaining);
          abort = () => reject(new LocalSpecialistError("aborted"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
      if (signal?.aborted) fail("aborted");
      if (Date.now() >= deadline) fail("deadline");
      return result;
    } catch (error) {
      if (error instanceof LocalSpecialistError) throw error;
      return fail(failureCode);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  private async invoke(body: string, payload: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) fail("aborted");
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        this.options.port.runServerCommand(command(body, payload), { signal, timeoutMs: remaining }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new LocalSpecialistError("deadline")), remaining);
          abort = () => reject(new LocalSpecialistError("aborted"));
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
      if (signal?.aborted) fail("aborted");
      if (typeof result.output !== "string" || result.output.length > 40_000) fail("invalid_receipt");
      let receipt: unknown;
      try { receipt = JSON.parse(result.output.trim()); } catch { fail("invalid_receipt"); }
      if (!object(receipt)) fail("invalid_receipt");
      if (!result.success || (result.exitCode != null && result.exitCode !== 0) || receipt.ok !== true) {
        const codes = ["linux_required", "bundle_integrity", "deadline", "unsafe_markdown", "native_exit", "output_too_large"];
        fail(typeof receipt.code === "string" && codes.includes(receipt.code) ? receipt.code : "execution_failed");
      }
      return receipt;
    } catch (error) {
      if (error instanceof LocalSpecialistError) throw error;
      return fail("transport_failed");
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  async listCapabilities(signal?: AbortSignal): Promise<readonly LocalSpecialistCapability[]> {
    const receipt = await this.invoke(`
$installed = @()
foreach ($probe in $p.probes) {
  $installed += @{id=$probe.id; present=($IsLinux -and (Test-Path -LiteralPath $probe.path))}
}
$md = $false
if ($IsLinux -and (Test-Path -LiteralPath '${CONVERTER}') -and (Test-Path -LiteralPath '${SOURCE_CONVERTER}') -and
    (Test-Path -LiteralPath '/usr/local/bin/node')) {
  Regular '${CONVERTER}'; Regular '${SOURCE_CONVERTER}'
  $md = ((Hash ([IO.File]::ReadAllBytes('${CONVERTER}'))) -ceq '${LOCAL_CONVERTER_SHA256}' -and
         (Hash ([IO.File]::ReadAllBytes('${SOURCE_CONVERTER}'))) -ceq '${LOCAL_CONVERTER_SHA256}')
}
Emit @{ok=$true; linux=[bool]$IsLinux; probes=$installed; markdown=$md}
`, { probes: PROBES }, Date.now() + this.timeoutMs, signal);
    if (typeof receipt.linux !== "boolean" || typeof receipt.markdown !== "boolean" ||
        !Array.isArray(receipt.probes) || receipt.probes.length !== PROBES.length) fail("invalid_receipt");
    const available = new Map<string, boolean>();
    for (let i = 0; i < PROBES.length; i++) {
      const p: unknown = receipt.probes[i];
      if (!object(p) || p.id !== PROBES[i].id || typeof p.present !== "boolean") fail("invalid_receipt");
      available.set(PROBES[i].id, receipt.linux && p.present);
    }
    const installed = (id: string, present: boolean, callable = false): LocalSpecialistCapability =>
      ({ id, status: present ? "installed" : "unavailable", callable: present && callable });
    return [
      installed("markdown-to-docx", receipt.linux && receipt.markdown && available.get("python3") === true &&
        available.get("node-env:md-to-docx--scripts") === true, true),
      installed("graphviz-to-png", available.get("graphviz") === true && available.get("python3") === true, true),
      ...PROBES.map(p => installed(p.id, available.get(p.id) === true)),
      { id: "authenticated-per-user-bindings", status: "auth-deferred", callable: false },
      { id: "windows-desktop-automation", status: "windows-unsupported", callable: false },
    ];
  }
  async execute(request: LocalSpecialistRequest, signal?: AbortSignal): Promise<LocalSpecialistReceipt> {
    if (!object(request) || Object.keys(request).some(k => !["operation", "inputPath", "outputPath"].includes(k)) ||
        !["markdown-to-docx", "graphviz-to-png"].includes(request.operation)) fail("invalid_contract");
    const docx = request.operation === "markdown-to-docx";
    artifactPath(request.inputPath, docx ? ".md" : ".dot");
    artifactPath(request.outputPath, docx ? ".docx" : ".png");
    const deadline = Date.now() + this.timeoutMs;
    if (signal?.aborted) fail("aborted");
    const text = await this.bounded(control => this.options.readTextArtifact(request.inputPath, control),
      deadline, signal, "source_failed");
    if (text === undefined) fail("input_not_found");
    const input = safeText(text);
    if (!docx) validateLocalGraphviz(text);
    const root = `/workspace/.hve-local/${randomUUID()}`;
    const payload = { root, input: `${root}/input${docx ? ".md" : ".dot"}`, output: `${root}/output${docx ? ".docx" : ".png"}` };
    let initialized = false;
    try {
      await this.invoke(INIT, payload, deadline, signal);
      initialized = true;
      for (let offset = 0; offset < input.length; offset += INPUT_CHUNK) {
        const chunk = input.subarray(offset, offset + INPUT_CHUNK);
        const written = await this.invoke(WRITE, { ...payload, offset, base64: chunk.toString("base64") }, deadline, signal);
        if (written.phase !== "write" || written.offset !== offset + chunk.length) fail("invalid_receipt");
      }
      const inputSha256 = sha(input);
      const remote = await this.invoke(EXECUTE, {
        ...payload, operation: request.operation, inputSha256,
        runner: docx ? MARKDOWN_RUNNER : "", guard: FILE_SIZE_GUARD, timeout: Math.max(1, deadline - Date.now()),
      }, deadline, signal);
      if (remote.phase !== "execute" || remote.operation !== request.operation || remote.inputSha256 !== inputSha256 ||
          remote.exitCode !== 0 || typeof remote.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(remote.sha256) ||
          typeof remote.byteLength !== "number" || !Number.isSafeInteger(remote.byteLength) ||
          remote.byteLength <= 0 || remote.byteLength > MAX_OUTPUT ||
          (docx && remote.converterSha256 !== LOCAL_CONVERTER_SHA256)) fail("invalid_receipt");
      const output = Buffer.alloc(remote.byteLength);
      for (let offset = 0; offset < output.length; offset += OUTPUT_CHUNK) {
        const chunk = await this.invoke(READ, { ...payload, offset, total: output.length }, deadline, signal);
        if (chunk.phase !== "read" || chunk.offset !== offset || typeof chunk.base64 !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.base64)) fail("invalid_receipt");
        const bytes = Buffer.from(chunk.base64, "base64");
        if (bytes.length !== Math.min(OUTPUT_CHUNK, output.length - offset) || bytes.toString("base64") !== chunk.base64) fail("invalid_receipt");
        bytes.copy(output, offset);
      }
      if (sha(output) !== remote.sha256) fail("output_integrity");
      if (docx ? !output.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) :
        !output.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail("output_type");
      if (signal?.aborted) fail("aborted");
      if (Date.now() >= deadline) fail("deadline");
      const receipt: LocalSpecialistReceipt = {
        ...request, inputSha256, sha256: remote.sha256, byteLength: output.length, exitCode: 0,
        ...(docx ? { converterSha256: LOCAL_CONVERTER_SHA256 } : {}),
      };
      await this.bounded(control => this.options.writeBinaryArtifact({
        path: request.outputPath, bytes: output, sha256: receipt.sha256,
        mediaType: docx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "image/png",
      }, receipt, control), deadline, signal, "sink_failed");
      return receipt;
    } finally {
      if (initialized) {
        try { await this.invoke(CLEANUP, payload, Date.now() + 2_000); } catch { /* No bulk deletion or cleanup failure masking the execution result. */ }
      }
    }
  }
}
