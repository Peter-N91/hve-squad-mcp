/**
 * Structural checks for the pinned rpi-research/rpi-plan artifact templates.
 * These do not attest to evidence, tool execution, durable files, parent-owned
 * reuse decisions, readiness, or the independent critique gate.
 */

interface Heading {
  level: number;
  title: string;
  line: number;
}

interface Document {
  label: string;
  lines: string[];
  visible: string[];
  headings: Heading[];
}

const RESEARCH_SECTIONS = [
  "Research Brief", "Research Parameters", "Extension Registry and Provenance",
  "User Participation and Research Decisions", "Scope and Success Criteria",
  "Task Research Requests", "Direction Controls", "Research Questions",
  "Prior Knowledge Gate", "Research Cycle Log", "Evidence Log",
  "Findings Mapped to Questions and Evidence", "Key Discoveries",
  "Alternatives and Decision State", "Open Questions, Risks, and Residual Uncertainty",
  "Current Decisions", "Unresolved Decisions", "Potential Next Research",
  "Planning Readiness", "Closeout Record", "Advisory Next Step", "Sources",
  "Artifact Self-Check",
];
const PLAN_SECTIONS = [
  "Task Metadata", "Executive Summary", "User Decisions and Requirements", "Goals",
  "Scope and Non-Goals", "Functional Requirements", "Non-Functional Requirements",
  "Acceptance Criteria", "Implementation Context Record", "Sources",
  "Phase Checklist", "Dependencies", "Critique Disposition", "Follow-Up Items", "Handoff",
];
const DETAIL_SECTIONS = [
  "Context", "Intent", "Boundaries", "Likely Targets", "Dependencies",
  "Validation Expectations", "Completion Evidence", "Unresolved Items",
];
const CYCLE_SECTIONS = [
  "Wave 1: Wider", "Wave 2: Deeper", "Wave 3: Contrarian",
  "Parent Synthesis and Disposition", "Cycle Re-entry Evaluation",
];

function document(content: string, label: string, title: string, errors: string[]): Document {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "<!-- markdownlint-disable-file -->") {
    errors.push(`${label}: must begin with <!-- markdownlint-disable-file --> (no YAML frontmatter).`);
  }
  let fence: { character: string; length: number } | undefined;
  const unfenced = lines.map((line) => {
    const boundary = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (boundary && boundary[1][0] === fence.character &&
          boundary[1].length >= fence.length && !boundary[2].trim()) {
        fence = undefined;
      }
      return "";
    }
    if (boundary) {
      fence = { character: boundary[1][0], length: boundary[1].length };
      return "";
    }
    return line;
  });
  if (fence) errors.push(`${label}: contains an unclosed code fence.`);
  const visible = unfenced.join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ""))
    .split("\n");
  const headings: Heading[] = [];
  visible.forEach((line, index) => {
    const match = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (match) headings.push({ level: match[1].length, title: match[2], line: index });
  });
  const titles = headings.filter((heading) => heading.level === 1);
  if (titles.length !== 1 || headings[0] !== titles[0] || !titles[0].title.startsWith(`${title}: `) ||
      !titles[0].title.slice(title.length + 2).trim()) {
    errors.push(`${label}: requires one # ${title}: <task> heading.`);
  }
  if (visible.some((line) => /\{\{[^{}\n]+\}\}/.test(line))) {
    errors.push(`${label}: contains unfilled template placeholders.`);
  }
  if (visible.some((line) => /^\s*applyTo\s*:/.test(line))) {
    errors.push(`${label}: must not contain applyTo metadata.`);
  }
  return { label, lines: unfenced, visible, headings };
}

function endOf(doc: Document, heading: Heading): number {
  return doc.headings.find((next) => next.line > heading.line && next.level <= heading.level)?.line
    ?? doc.lines.length;
}

function body(doc: Document, heading: Heading | undefined, end?: number): string {
  return heading ? doc.visible.slice(heading.line + 1, end ?? endOf(doc, heading)).join("\n") : "";
}

function hasContent(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((line, index) =>
    line.trim() && !/^#{1,6}\s/.test(line) && !/^[\s|:*-]+$/.test(line) &&
    !(/^\s*\|/.test(line) && /^\s*\|[\s|:-]+\|\s*$/.test(lines[index + 1] ?? "")));
}

function sections(
  doc: Document, names: readonly string[], level: number, errors: string[],
  start = -1, end = doc.lines.length,
): Map<string, Heading> {
  const found = new Map<string, Heading>();
  let previous = start;
  for (const name of names) {
    const matches = doc.headings.filter((heading) =>
      heading.line > start && heading.line < end && heading.level === level && heading.title === name);
    if (matches.length !== 1) {
      errors.push(`${doc.label}: requires exactly one ${"#".repeat(level)} ${name} section in this block.`);
      continue;
    }
    const heading = matches[0];
    found.set(name, heading);
    if (heading.line < previous) errors.push(`${doc.label}: ${name} is out of canonical order.`);
    previous = heading.line;
    if (!hasContent(body(doc, heading, Math.min(end, endOf(doc, heading))))) {
      errors.push(`${doc.label}: ${name} must contain a completed record.`);
    }
  }
  return found;
}

function plain(value: string): string {
  return value.trim().replace(/^[`*_]+|[`*_]+$/g, "").trim();
}

function field(text: string, name: string, label: string, errors: string[]): string {
  const values: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().split(/(?<!\\)\|/).slice(1, -1);
      if (plain(cells[0] ?? "") === name) values.push(plain(cells[1] ?? ""));
    } else {
      const match = /^\s*[-*+]\s+(.+?):\s*(.*)$/.exec(line);
      if (match && plain(match[1]) === name) values.push(plain(match[2]));
    }
  }
  if (values.length !== 1 || !values[0]) {
    errors.push(`${label}: requires one nonempty ${name} field.`);
    return "";
  }
  return values[0];
}

function fields(text: string, names: readonly string[], label: string, errors: string[]): void {
  for (const name of names) field(text, name, label, errors);
}

/** Validate a completed primary artifact, not the shorter research chat closeout. */
export function validateResearchArtifact(content: string): string[] {
  const errors: string[] = [];
  const doc = document(content, "Research", "Task Research", errors);
  const blocks = sections(doc, RESEARCH_SECTIONS, 2, errors);
  const text = (name: string) => body(doc, blocks.get(name));
  const metadata = doc.visible.slice(0, doc.headings.find((h) => h.level === 2)?.line).join("\n");
  fields(metadata, ["Date", "Researcher / agent", "Artifact path"], "Research metadata", errors);
  if (field(metadata, "Status", "Research metadata", errors).toLowerCase() !== "complete") {
    errors.push("Research: metadata Status must be Complete.");
  }
  fields(text("Research Brief"), [
    "What to research", "Why it matters", "Audience or intended use", "Scope",
    "Non-goals", "Criteria", "Requested outputs", "Output mode",
  ], "Research Brief", errors);
  fields(text("Research Parameters"), [
    "Research posture", "Posture provenance", "Explicit limits / deadline",
    "Posture-specific completion basis", "Resolved evidence root",
  ], "Research Parameters", errors);
  fields(text("Prior Knowledge Gate"), [
    "Existing artifacts reviewed", "Reused (verified) findings", "Superseded / stale",
  ], "Prior Knowledge Gate", errors);
  fields(text("Planning Readiness"), [
    "Status", "Decision state", "Evidence basis", "Preconditions met",
    "Blockers", "Smallest action to change readiness",
  ], "Planning Readiness", errors);
  const closeout = text("Closeout Record");
  if (field(closeout, "Research execution status", "Closeout Record", errors).toLowerCase() !== "complete") {
    errors.push("Research: closeout execution status must be Complete.");
  }
  fields(closeout, [
    "Completed waves", "Lane evidence or inline fallback", "Planning Readiness",
    "Blockers", "Continuation owner and state",
  ], "Closeout Record", errors);
  const disposition = field(closeout, "Research disposition", "Closeout Record", errors);
  if (!["executed", "reused", "satisfied-and-skipped"].includes(disposition)) {
    errors.push("Research: disposition must be executed, reused, or satisfied-and-skipped.");
  }
  const advisory = text("Advisory Next Step");
  if (field(advisory, "Research disposition", "Advisory Next Step", errors) !== disposition) {
    errors.push("Research: closeout and advisory dispositions must agree.");
  }
  fields(advisory, [
    "Planning Readiness", "Output mode and planning support", "Acting owner",
    "Required gates or confirmations", "Continuation result", "Primary evidence file",
    "Notes for planning or re-entry", "Completion or limit-blocked basis",
  ], "Advisory Next Step", errors);

  const cycleLog = blocks.get("Research Cycle Log");
  const cycleHeadings = cycleLog ? doc.headings.filter((heading) =>
    heading.line > cycleLog.line && heading.line < endOf(doc, cycleLog) &&
    heading.level === 3) : [];
  const cycles = cycleHeadings.filter((heading) => /^Cycle [1-9]\d*$/.test(heading.title));
  if (cycles.length !== cycleHeadings.length) {
    errors.push("Research: Research Cycle Log must use ### Cycle <number> blocks.");
  }
  if (disposition === "executed" && !cycles.length) {
    errors.push("Research: executed research requires at least one complete Cycle <number>.");
  }
  if (new Set(cycles.map((cycle) => cycle.title)).size !== cycles.length) {
    errors.push("Research: cycle numbers must be unique.");
  }
  for (const cycle of cycles) {
    const parts = sections(doc, CYCLE_SECTIONS, 4, errors, cycle.line, endOf(doc, cycle));
    for (const wave of CYCLE_SECTIONS.slice(0, 3)) {
      fields(body(doc, parts.get(wave)), [
        "Plan and independent lanes", "Worker evidence relationships or inline fallback", "Reflection",
      ], `${cycle.title} ${wave}`, errors);
    }
    fields(body(doc, parts.get("Wave 2: Deeper")), [
      "Parent-prioritized material from Wave 1",
    ], `${cycle.title} Deeper`, errors);
    fields(body(doc, parts.get("Wave 3: Contrarian")), [
      "In-scope challenge targets and boundaries",
    ], `${cycle.title} Contrarian`, errors);
    fields(body(doc, parts.get("Cycle Re-entry Evaluation")), [
      "Another complete three-wave cycle needed", "Trigger or stop basis",
      "Revised brief or revalidation required", "Readiness effect",
    ], `${cycle.title} re-entry`, errors);
  }
  const selfCheck = text("Artifact Self-Check");
  if (!/^\s*[-*+] \[[xX]\]\s+\S/m.test(selfCheck) || /^\s*[-*+] \[ \]/m.test(selfCheck)) {
    errors.push("Research: Artifact Self-Check must contain checked items and no unchecked items.");
  }
  return errors;
}

interface Entity {
  id: string;
  kind: "phase" | "task";
  heading: Heading;
  end: number;
}

function entities(doc: Document, isPlan: boolean, errors: string[]): Entity[] {
  const result: Entity[] = [];
  for (const heading of doc.headings) {
    const match = /^(?:\[[ xX]\] )?(P\d{2,}(?:-T\d{2,})?):\s+\S/.exec(heading.title);
    if (!match) continue;
    const id = match[1];
    const kind = id.includes("-T") ? "task" : "phase";
    const level = (isPlan ? 3 : 2) + (kind === "task" ? 1 : 0);
    if (heading.level !== level || (isPlan && !/^\[[ xX]\] /.test(heading.title))) {
      errors.push(`${doc.label}: ${id} must use the canonical level-${level} ${isPlan ? "checklist " : ""}heading.`);
    }
    if (doc.lines[heading.line - 1]?.trim() !== `<!-- rpi:${kind} id=${id} -->`) {
      errors.push(`${doc.label}: ${id} requires its matching contextual marker immediately before its heading.`);
    }
    if (result.some((entity) => entity.id === id)) errors.push(`${doc.label}: duplicate ${id}.`);
    result.push({ id, kind, heading, end: doc.lines.length });
  }
  result.forEach((entity, index) => {
    entity.end = Math.min(endOf(doc, entity.heading), result[index + 1]?.heading.line ?? doc.lines.length);
  });
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (/<!--\s*rpi:(?:phase|task)\b/.test(doc.lines[index]) &&
        !result.some((entity) => entity.heading.line === index + 1 &&
          doc.lines[index].trim() === `<!-- rpi:${entity.kind} id=${entity.id} -->`)) {
      errors.push(`${doc.label}: orphaned or mismatched phase/task marker at line ${index + 1}.`);
    }
  }
  let phase: string | undefined;
  for (const entity of result) {
    if (entity.kind === "phase") phase = entity.id;
    else if (entity.id.split("-T")[0] !== phase) {
      errors.push(`${doc.label}: ${entity.id} is not under its owning phase.`);
    }
  }
  if (!result.some((entity) => entity.kind === "phase") || !result.some((entity) => entity.kind === "task")) {
    errors.push(`${doc.label}: requires phase and task headings.`);
  }
  return result;
}

/** Structural readiness only: critique verdicts and resolving evidence are parent-owned. */
export function validatePlanArtifacts(plan: string, details: string): string[] {
  const errors: string[] = [];
  const p = document(plan, "Plan", "RPI Plan", errors);
  const d = document(details, "Details", "RPI Phase Details", errors);
  const planBlocks = sections(p, PLAN_SECTIONS, 2, errors);
  const detailBlocks = sections(d, ["Metadata", "Phase Index"], 2, errors);
  const planMetadata = body(p, planBlocks.get("Task Metadata"));
  const detailMetadata = body(d, detailBlocks.get("Metadata"));
  for (const name of ["Task ID", "Task slug"]) {
    const left = field(planMetadata, name, "Plan metadata", errors);
    const right = field(detailMetadata, name, "Details metadata", errors);
    if (left && right && left !== right) errors.push(`Plan and details: ${name} must match.`);
  }
  fields(planMetadata, ["Planning status", "Plan date", "Phase details", "Plan critique"], "Plan metadata", errors);
  fields(detailMetadata, ["Related plan", "Evidence sources"], "Details metadata", errors);
  const top = p.headings.filter((heading) => heading.level === 2);
  for (const [first, next] of [["Task Metadata", "Executive Summary"], ["Follow-Up Items", "Handoff"]]) {
    const index = top.findIndex((heading) => heading.title === first);
    if (index >= 0 && top[index + 1]?.title !== next) {
      errors.push(`Plan: ${next} must immediately follow ${first}.`);
    }
  }
  const planEntities = entities(p, true, errors);
  const detailEntities = entities(d, false, errors);
  const checklist = planBlocks.get("Phase Checklist");
  for (const entity of planEntities) {
    if (!checklist || entity.heading.line <= checklist.line || entity.heading.line >= endOf(p, checklist)) {
      errors.push(`Plan: ${entity.id} must be inside Phase Checklist.`);
    }
    fields(body(p, entity.heading, entity.end), entity.kind === "phase"
      ? ["Intent", "Dependencies"]
      : ["Requirement and evidence", "Expected result", "Detail section"], `Plan ${entity.id}`, errors);
    if (entity.kind === "task") {
      const pointer = field(body(p, entity.heading, entity.end), "Detail section", `Plan ${entity.id}`, []);
      if (pointer && !new RegExp(`\\b${entity.id}\\b`).test(pointer)) {
        errors.push(`Plan: ${entity.id} Detail section must point to the same task ID.`);
      }
    }
  }
  for (const entity of detailEntities) {
    if (entity.heading.line <= (detailBlocks.get("Phase Index")?.line ?? -1)) {
      errors.push(`Details: ${entity.id} must follow Phase Index.`);
    }
    sections(d, DETAIL_SECTIONS, entity.kind === "phase" ? 3 : 4, errors, entity.heading.line, entity.end);
  }
  for (const entity of planEntities) {
    if (!detailEntities.some((detail) => detail.id === entity.id)) errors.push(`Details: missing ${entity.id} from the plan.`);
  }
  for (const entity of detailEntities) {
    if (!planEntities.some((entry) => entry.id === entity.id)) errors.push(`Details: ${entity.id} has no matching plan entry.`);
  }
  return errors;
}
