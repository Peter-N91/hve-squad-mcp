/**
 * Deterministic PowerPoint render backend (the swap seam).
 *
 * `squad_render_pptx` performs ONE known transform — deck content YAML in, a
 * `.pptx` byte buffer out — via the `powerpoint` skill's `python-pptx` build step.
 * This interface is the seam that keeps the execution strategy swappable with no
 * rip-out: the Phase 1 implementation ({@link import("./python-pptx-render-backend.js").PythonPptxRenderBackend})
 * runs Python in-process in a bounded ephemeral workspace; a later sidecar service
 * or ACA Job can implement the same contract without touching the tool surface.
 *
 * Security posture (SEC-5 — the caller YAML is DATA, never code):
 *   * The input is text-only YAML; an implementation MUST materialize only data
 *     files (`content.yaml` / `style.yaml`), never an executable `content-extra.py`,
 *     and MUST NOT pass `--allow-scripts` to the build step, so no caller-supplied
 *     Python can execute inside python-pptx.
 *   * The interpreter path, scripts directory, and any brand template come from
 *     OPERATOR config (SEC-3), never from a tool input.
 */

/** The input to a single deterministic render. All fields are caller DATA. */
export interface RenderPptxInput {
  /**
   * A YAML document with a top-level `slides:` array; each item is one slide's
   * `content.yaml` body. Materialized to `content/slide-NNN/content.yaml`.
   */
  contentYaml: string;
  /** The global `style.yaml` body, written verbatim to `content/global/style.yaml`. */
  styleYaml: string;
  /**
   * OPTIONAL operator-provided brand template path (`--template`). Resolved from
   * operator config, NEVER a tool input. Absent => the skill default look.
   */
  templatePath?: string;
}

/** The result of a render: the finished deck bytes plus optional metadata. */
export interface RenderPptxOutput {
  /** The rendered `.pptx` file contents. */
  pptxBytes: Uint8Array;
  /** The number of slides materialized (best-effort, for the result note). */
  slideCount: number;
  /** True when no brand template was applied (the skill default was used). */
  usedDefaultTemplate: boolean;
}

/** A deterministic YAML -> .pptx renderer. */
export interface RenderBackend {
  renderPptx(input: RenderPptxInput): Promise<RenderPptxOutput>;
}

/** A render input that fails validation before any workspace or process is created. */
export class RenderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderInputError";
  }
}
