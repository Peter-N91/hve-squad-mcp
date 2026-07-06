/**
 * Render toolchain snapshot generator (build-time, reproducible).
 *
 * Copies the `powerpoint` skill's build scripts from the authoritative in-repo
 * source into `host/render/scripts` so the container `Containerfile` can COPY them
 * into the image (the skill tree lives OUTSIDE the `squad-mcp/` build context).
 * The `squad_render_pptx` tool invokes `build_deck.py` from this bundled copy.
 *
 * Pure file copy — no model, no network. Read-only source: the deployed skill is
 * the single source of truth; this script never edits it.
 *
 * Source (READ-ONLY):
 *   - `<repo>/.agents/skills/powerpoint/scripts/**` ... build_deck.py + pptx_* helpers
 *
 * Run: `npm run snapshot:render` (from the `squad-mcp/` package root).
 *
 * SCOPE NOTE: bundles the build scripts only. The Export/Validate scripts
 * (`export_*.py`, `validate_*.py`) are copied too (they share the folder) but are
 * NOT invoked by the render tool and their heavy system deps (LibreOffice, poppler,
 * Copilot CLI) are intentionally NOT installed in the image.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HOST_DIR);
const REPO_ROOT = dirname(PACKAGE_ROOT);

const SOURCE = join(REPO_ROOT, ".agents", "skills", "powerpoint", "scripts");
const DEST = join(HOST_DIR, "render", "scripts");

function main(): void {
  if (!existsSync(SOURCE)) {
    throw new Error(`Render snapshot source missing: ${SOURCE}`);
  }
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  cpSync(SOURCE, DEST, { recursive: true });
  process.stdout.write(`[snapshot-render] copied powerpoint build scripts -> ${DEST}\n`);
}

main();
