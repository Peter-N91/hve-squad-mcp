/**
 * Render backend (Phase 1) — the in-image python-pptx build step in a bounded
 * ephemeral workspace, with an INJECTED command runner so no real Python spawns.
 *
 * Proves the security-load-bearing invariants: the temp workspace is created and
 * always cleaned up, the argv never carries `--allow-scripts` (SEC-5, YAML is
 * DATA), the brand `--template` is present only when an operator path is supplied,
 * and a runner failure surfaces as an error (not an unhandled crash / leaked temp).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { PythonPptxRenderBackend, type CommandRunner } from "../src/engine/render/python-pptx-render-backend.js";
import { RenderInputError } from "../src/engine/render/render-backend.js";

const CONTENT = "slides:\n  - slide: 1\n    title: Hello\n  - slide: 2\n    title: World\n";
const STYLE = "dimensions:\n  width: 13.333\n  height: 7.5\n";

/** A runner that records its call and writes a fake .pptx to the requested output. */
function capturingRunner(): { runner: CommandRunner; calls: { command: string; args: string[]; cwd: string }[] } {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const outIdx = args.indexOf("--output");
    if (outIdx >= 0) {
      await writeFile(args[outIdx + 1], Buffer.from("PK\u0003\u0004fake-pptx"));
    }
    return { stdout: "", stderr: "" };
  };
  return { runner, calls };
}

test("renders slides and returns bytes; temp workspace is cleaned up", async () => {
  const before = await readdir(tmpdir());
  const { runner, calls } = capturingRunner();
  const backend = new PythonPptxRenderBackend({ pythonPath: "python3", scriptsDir: "/skill", runCommand: runner });

  const out = await backend.renderPptx({ contentYaml: CONTENT, styleYaml: STYLE });

  assert.equal(calls.length, 1);
  assert.ok(out.pptxBytes.length > 0, "returns deck bytes");
  assert.equal(out.slideCount, 2);
  assert.equal(out.usedDefaultTemplate, true);

  // No squad-render-* temp dir should survive the call.
  const after = await readdir(tmpdir());
  const leaked = after.filter((n) => n.startsWith("squad-render-") && !before.includes(n));
  assert.deepEqual(leaked, [], "the ephemeral workspace is removed");
});

test("SEC-5: argv NEVER contains --allow-scripts", async () => {
  const { runner, calls } = capturingRunner();
  const backend = new PythonPptxRenderBackend({ pythonPath: "python3", scriptsDir: "/skill", runCommand: runner });
  await backend.renderPptx({ contentYaml: CONTENT, styleYaml: STYLE });
  assert.ok(!calls[0].args.includes("--allow-scripts"), "the render step never allows caller scripts");
  assert.ok(calls[0].args.some((a) => a.endsWith("build_deck.py")), "invokes the skill build step");
});

test("brand --template is passed only when a template path is supplied", async () => {
  const a = capturingRunner();
  await new PythonPptxRenderBackend({ pythonPath: "python3", scriptsDir: "/skill", runCommand: a.runner }).renderPptx({
    contentYaml: CONTENT,
    styleYaml: STYLE,
  });
  assert.ok(!a.calls[0].args.includes("--template"), "no template flag by default");

  const b = capturingRunner();
  const out = await new PythonPptxRenderBackend({
    pythonPath: "python3",
    scriptsDir: "/skill",
    defaultTemplatePath: "/brand/pptx-brand-template.pptx",
    runCommand: b.runner,
  }).renderPptx({ contentYaml: CONTENT, styleYaml: STYLE });
  const tIdx = b.calls[0].args.indexOf("--template");
  assert.ok(tIdx >= 0, "template flag present when operator supplies one");
  assert.equal(b.calls[0].args[tIdx + 1], "/brand/pptx-brand-template.pptx");
  assert.equal(out.usedDefaultTemplate, false);
});

test("a runner failure surfaces as an error and still cleans the workspace", async () => {
  const before = await readdir(tmpdir());
  const failing: CommandRunner = async () => {
    throw new Error("build failed");
  };
  const backend = new PythonPptxRenderBackend({ pythonPath: "python3", scriptsDir: "/skill", runCommand: failing });
  await assert.rejects(() => backend.renderPptx({ contentYaml: CONTENT, styleYaml: STYLE }));
  const after = await readdir(tmpdir());
  const leaked = after.filter((n) => n.startsWith("squad-render-") && !before.includes(n));
  assert.deepEqual(leaked, [], "workspace removed even on failure");
});

test("invalid content YAML is rejected before any workspace is created", async () => {
  const { runner, calls } = capturingRunner();
  const backend = new PythonPptxRenderBackend({ pythonPath: "python3", scriptsDir: "/skill", runCommand: runner });
  await assert.rejects(
    () => backend.renderPptx({ contentYaml: "not: [a, valid, slides, doc]", styleYaml: STYLE }),
    RenderInputError,
  );
  assert.equal(calls.length, 0, "no render process spawned for invalid input");
});
