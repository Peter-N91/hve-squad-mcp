import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Newer casts keep the canonical catalog outside the roster instruction. */
export function readRosterDocumentation(githubRoot: string): string {
  const roster = readFileSync(join(githubRoot, "instructions", "squad", "squad-roster.instructions.md"), "utf8");
  const catalog = join(githubRoot, "references", "squad", "roster-catalog.md");
  return existsSync(catalog) ? `${roster}\n\n${readFileSync(catalog, "utf8")}` : roster;
}
