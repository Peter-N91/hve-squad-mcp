/**
 * Markdown table reader shared by every module that treats a deployed squad
 * instruction file as data.
 *
 * The routing engine, the profile resolver, and `generators/build-manifests.ts`
 * all read the same instruction files, and they must read them the SAME way or a
 * drift check can pass against a table the runtime parses differently. Fenced
 * code blocks are skipped so an example table inside ``` is never mistaken for a
 * real one.
 */
export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

export function isSeparatorLine(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

export function parseTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (isTableLine(line) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j += 1) {
        if (/^\s*```/.test(lines[j]) || !isTableLine(lines[j])) {
          break;
        }
        rows.push(splitRow(lines[j]));
      }
      tables.push({ headers, rows });
      i = j - 1;
    }
  }
  return tables;
}
