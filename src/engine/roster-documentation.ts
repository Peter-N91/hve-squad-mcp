import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Newer casts keep the canonical catalog outside the roster instruction. */
export function readRosterDocumentation(githubRoot: string): string {
  const roster = readFileSync(join(githubRoot, "instructions", "squad", "squad-roster.instructions.md"), "utf8");
  for (const candidate of [
    join(githubRoot, "skills", "squad", "references", "roster-catalog.md"),
    join(githubRoot, "references", "squad", "roster-catalog.md"),
  ]) {
    if (existsSync(candidate)) {
      return `${roster}\n\n${readFileSync(candidate, "utf8")}`;
    }
  }
  return roster;
}
