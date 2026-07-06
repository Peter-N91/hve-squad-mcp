/**
 * PPTX render service (Phase 3) — composes the {@link RenderBackend} and the
 * {@link AzureBlobArtifactStore} into the single operation the `squad_render_pptx`
 * tool performs: content YAML in, a short-lived download link out.
 *
 * It is deliberately thin and deterministic: render bytes -> upload to a
 * tenant-scoped blob -> mint a user-delegation SAS -> format an MCP text result
 * carrying the link, its expiry, the content type, and a brand note. No model is
 * called; there is no gate and no run state. A {@link RenderInputError} (bad YAML
 * shape) is surfaced as a helpful tool error — it describes the input contract, not
 * a secret. Any other failure is thrown to the transport, which logs it scrubbed
 * and returns a generic error (the SAS/URL is never in an error path).
 */
import type { RenderedToolResult } from "../render-embedded.js";
import { RenderInputError, type RenderBackend } from "./render-backend.js";
import type { AzureBlobArtifactStore } from "../backends/azure-blob-artifact-store.js";

export interface PptxRenderRequest {
  contentYaml: string;
  styleYaml: string;
}

export interface PptxRenderServiceOptions {
  backend: RenderBackend;
  store: AzureBlobArtifactStore;
  /** SAS lifetime in milliseconds (operator config). */
  ttlMs: number;
  /** Optional operator brand template path (SEC-3; never a caller input). */
  templatePath?: string;
}

export class PptxRenderService {
  private readonly backend: RenderBackend;
  private readonly store: AzureBlobArtifactStore;
  private readonly ttlMs: number;
  private readonly templatePath?: string;

  constructor(options: PptxRenderServiceOptions) {
    this.backend = options.backend;
    this.store = options.store;
    this.ttlMs = options.ttlMs;
    this.templatePath = options.templatePath;
  }

  async render(request: PptxRenderRequest, ctx: { tenantId: string }): Promise<RenderedToolResult> {
    let bytes: Uint8Array;
    let usedDefaultTemplate: boolean;
    let slideCount: number;
    try {
      const out = await this.backend.renderPptx({
        contentYaml: request.contentYaml,
        styleYaml: request.styleYaml,
        templatePath: this.templatePath,
      });
      bytes = out.pptxBytes;
      usedDefaultTemplate = out.usedDefaultTemplate;
      slideCount = out.slideCount;
    } catch (error) {
      if (error instanceof RenderInputError) {
        // A caller-input-shape error: safe to echo (describes the contract, not a secret).
        return { isError: true, content: [{ type: "text", text: `Render input rejected: ${error.message}` }] };
      }
      throw error;
    }

    // Upload + mint the download link (tenant-scoped; SAS never logged).
    const link = await this.store.uploadAndMintDownloadSas(ctx.tenantId, bytes, this.ttlMs);

    const brandNote = usedDefaultTemplate
      ? "No brand template configured — the deck uses the skill default look."
      : "Rendered with the configured brand template.";
    const machine = {
      downloadUrl: link.downloadUrl,
      expiresAt: link.expiresAt,
      contentType: link.contentType,
      slideCount,
    };
    const text = [
      "## Rendered PowerPoint deck",
      "",
      `- slides: ${slideCount}`,
      `- expires: ${link.expiresAt}`,
      `- ${brandNote}`,
      "",
      `[Download the deck](${link.downloadUrl})`,
      "",
      "```json",
      JSON.stringify(machine, null, 2),
      "```",
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
}
