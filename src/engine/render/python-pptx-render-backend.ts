/**
 * In-image `python-pptx` render backend (Phase 1 implementation of
 * {@link RenderBackend}).
 *
 * Runs the `powerpoint` skill's `build_deck.py` in a BOUNDED EPHEMERAL workspace:
 * a fresh `mkdtemp` directory is populated with only the caller's DATA YAML
 * (`content/slide-NNN/content.yaml` + `content/global/style.yaml`), the build step
 * is invoked as an argv array (never a shell string), the `.pptx` bytes are read
 * back, and the workspace is ALWAYS removed in a `finally`. No state persists.
 *
 * Security posture:
 *   * SEC-5 — the workspace contains ONLY data files this backend writes; a
 *     `content-extra.py` is never materialized and `--allow-scripts` is never
 *     passed, so python-pptx cannot execute caller-supplied Python.
 *   * SEC-3 — `pythonPath`, `scriptsDir`, and `templatePath` come from operator
 *     config, never a tool input.
 *
 * The command runner is injectable so unit tests never spawn a real Python.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  RenderInputError,
  type RenderBackend,
  type RenderPptxInput,
  type RenderPptxOutput,
} from "./render-backend.js";

/** The result of running an external command. */
export interface CommandRunResult {
  stdout: string;
  stderr: string;
}

/** An injectable command runner (default wraps `execFile`). */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandRunResult>;

export interface PythonPptxRenderBackendOptions {
  /** Absolute path to the Python 3.11+ interpreter (operator config; SEC-3). */
  pythonPath: string;
  /** Directory containing `build_deck.py` and its `pptx_*` helpers (operator config). */
  scriptsDir: string;
  /** Optional operator brand template passed as `--template` (operator config). */
  defaultTemplatePath?: string;
  /** Max wall-clock for one build before it is killed (default 120s < 240s ingress). */
  timeoutMs?: number;
  /** Injectable command runner (default: `execFile`). */
  runCommand?: CommandRunner;
}

/** The default `execFile`-based runner (never a shell; argv array only). */
const defaultRunCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // Preserve the build step's stderr for observability; the logger scrubs
          // the message before it is written, so including it is safe (SEC-10).
          reject(new Error(`${error.message}${stderr ? ` (stderr: ${String(stderr)})` : ""}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function padSlide(index: number): string {
  return `slide-${String(index + 1).padStart(3, "0")}`;
}

/** Extract the caller's `slides` array from the content YAML (validated, DATA-only). */
function parseSlides(contentYaml: string): unknown[] {
  let doc: unknown;
  try {
    doc = parseYaml(contentYaml);
  } catch {
    throw new RenderInputError("contentYaml is not valid YAML.");
  }
  const slides =
    doc && typeof doc === "object" ? (doc as Record<string, unknown>).slides : undefined;
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new RenderInputError("contentYaml must contain a non-empty top-level 'slides' array.");
  }
  return slides;
}

export class PythonPptxRenderBackend implements RenderBackend {
  private readonly pythonPath: string;
  private readonly scriptsDir: string;
  private readonly defaultTemplatePath?: string;
  private readonly timeoutMs: number;
  private readonly runCommand: CommandRunner;

  constructor(options: PythonPptxRenderBackendOptions) {
    this.pythonPath = options.pythonPath;
    this.scriptsDir = options.scriptsDir;
    this.defaultTemplatePath = options.defaultTemplatePath;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  async renderPptx(input: RenderPptxInput): Promise<RenderPptxOutput> {
    // Validate + split BEFORE any workspace/process is created (fail fast, no cleanup owed).
    const slides = parseSlides(input.contentYaml);
    if (typeof input.styleYaml !== "string" || input.styleYaml.trim().length === 0) {
      throw new RenderInputError("styleYaml must be a non-empty YAML string.");
    }
    const templatePath = input.templatePath ?? this.defaultTemplatePath;

    const workspace = await mkdtemp(join(tmpdir(), "squad-render-"));
    try {
      const contentDir = join(workspace, "content");
      const globalDir = join(contentDir, "global");
      await mkdir(globalDir, { recursive: true });
      // style.yaml written verbatim (caller DATA).
      await writeFile(join(globalDir, "style.yaml"), input.styleYaml, "utf8");
      // Each slide re-serialized into its own slide-NNN/content.yaml (DATA only;
      // never a content-extra.py, so python-pptx cannot execute caller Python).
      for (let i = 0; i < slides.length; i += 1) {
        const slideDir = join(contentDir, padSlide(i));
        await mkdir(slideDir, { recursive: true });
        await writeFile(join(slideDir, "content.yaml"), stringifyYaml(slides[i]), "utf8");
      }

      const outputPath = join(workspace, "out.pptx");
      const args = [
        join(this.scriptsDir, "build_deck.py"),
        "--content-dir",
        contentDir,
        "--style",
        join(globalDir, "style.yaml"),
        "--output",
        outputPath,
      ];
      // SEC-5: NEVER `--allow-scripts`. Brand template is operator config only.
      if (templatePath) {
        args.push("--template", templatePath);
      }

      await this.runCommand(this.pythonPath, args, { cwd: this.scriptsDir, timeoutMs: this.timeoutMs });

      const bytes = await readFile(outputPath);
      return {
        pptxBytes: new Uint8Array(bytes),
        slideCount: slides.length,
        usedDefaultTemplate: !templatePath,
      };
    } finally {
      // Bounded ephemeral workspace: always removed, even on failure.
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
