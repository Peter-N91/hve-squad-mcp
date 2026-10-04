import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "host", "cast", ".github", "skills", "rpi");

export function template(skill: string, file: string): string {
  const source = readFileSync(join(ROOT, skill, "templates", file), "utf8");
  return source.slice(source.indexOf("<!-- markdownlint-disable-file -->"))
    .replace(/<!--[\s\S]*?-->/g, (comment) =>
      /^(?:<!-- markdownlint-disable-file -->|<!-- rpi:(?:phase|task) id=[A-Z0-9-]+ -->)$/.test(comment)
        ? comment : "")
    .replace(/^Fill every .*$/m, "");
}

export function fill(source: string, values: Record<string, string> = {}): string {
  return source.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => values[name.trim()] ?? "Recorded");
}

export function research(disposition = "executed", overrides: Record<string, string> = {}): string {
  let content = fill(template("rpi-research", "research.md"), {
    task_slug: "example-task",
    "YYYY-MM-DD": "2026-09-18",
    "In progress \\| Complete \\| Partial \\| Blocked \\| Needs clarification": "Complete",
    "Complete, Partial, Blocked, or Needs clarification": "Complete",
    "executed, reused, or satisfied-and-skipped": disposition,
    "executed, reused, or satisfied-and-skipped where applicable": disposition,
    cycle_number: "1",
    "convergence | analysis | audit | comparison | research-only | no-handoff": "research-only",
    "Ready | Not ready | Not applicable | Blocked": "Not applicable",
    "yes / no / limit-blocked": "no",
    ...overrides,
  }).replaceAll("* [ ]", "* [x]");
  content = content.replace(
    /## Sources\n[\s\S]*?(?=\n## Artifact Self-Check)/,
    "## Sources\n\nNo external sources used.\n",
  );
  if (disposition !== "executed") {
    content = content.replace(
      /## Research Cycle Log\n[\s\S]*?(?=\n## Evidence Log)/,
      "## Research Cycle Log\n\nNot executed: parent verified the supplied evidence remains adequate.\n",
    );
  }
  return content;
}

export function planning(): { plan: string; details: string } {
  const values = {
    task_id: "task-123",
    task_slug: "example-task",
    task_name: "Example task",
    "YYYY-MM-DD": "2026-09-18",
    draft_or_ready: "ready",
    resolved_superseded_accepted_with_risk_or_open: "resolved",
  };
  return {
    plan: fill(template("rpi-plan", "implementation-plan.md"), values),
    details: fill(template("rpi-plan", "implementation-details.md"), values),
  };
}
