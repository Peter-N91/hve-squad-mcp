/**
 * Shared write-or-verify step for the generators.
 *
 * `generate` writes; `generate --check` reports which outputs are stale and writes
 * nothing, so CI can assert that everything under `generated/` matches the sources
 * it is derived from without diffing the working tree afterwards.
 *
 * Comparison is LF-normalized: this repository has `core.autocrlf=true`, so a
 * Windows checkout holds CRLF for the same blob a Linux runner holds as LF, and a
 * byte comparison would report drift for identical content.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Write each output, or in check mode return the ones that differ from disk
 * (relative to `root`, POSIX separators). An empty list means everything is current.
 */
export function emitOrCheck(
  outputs: Map<string, string>,
  check: boolean,
  root: string,
): string[] {
  const stale: string[] = [];
  for (const [path, content] of outputs) {
    if (check) {
      if (!existsSync(path) || normalize(readFileSync(path, "utf8")) !== normalize(content)) {
        stale.push(relative(root, path).replace(/\\/g, "/"));
      }
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return stale;
}
