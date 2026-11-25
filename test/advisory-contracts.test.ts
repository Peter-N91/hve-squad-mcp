import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validatePlanArtifacts,
  validateResearchArtifact,
} from "../src/engine/advisory-contracts.js";
import { planning, research } from "./helpers/advisory-artifacts.js";

function removeSection(content: string, heading: string, level = 2): string {
  const lines = content.split("\n");
  const start = lines.indexOf(`${"#".repeat(level)} ${heading}`);
  assert.ok(start >= 0, `fixture contains ${heading}`);
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

test("completed pinned research template accepts inline work and code-only sources", () => {
  const content = research().replaceAll("Recorded", "Inline investigation; C1 supports this conclusion");
  assert.deepEqual(validateResearchArtifact(content), []);
  assert.equal(content.includes("No external sources used."), true);
});

for (const disposition of ["reused", "satisfied-and-skipped"]) {
  test(`parent-owned ${disposition} research requires no fabricated executed waves`, () => {
    assert.deepEqual(validateResearchArtifact(research(disposition)), []);
  });
}

test("completed research accepts multiple complete cycles", () => {
  const content = research();
  const cycle = content.slice(content.indexOf("### Cycle 1"), content.indexOf("## Evidence Log"));
  assert.deepEqual(validateResearchArtifact(
    content.replace("## Evidence Log", `${cycle.replace("### Cycle 1", "### Cycle 2")}\n## Evidence Log`),
  ), []);
});

for (const section of [
  "Research Brief", "Extension Registry and Provenance", "User Participation and Research Decisions",
  "Research Questions", "Prior Knowledge Gate", "Evidence Log", "Current Decisions",
  "Planning Readiness", "Closeout Record", "Sources", "Artifact Self-Check",
]) {
  test(`research rejects missing canonical ${section} section`, () => {
    assert.ok(validateResearchArtifact(removeSection(research(), section)).some((error) => error.includes(section)));
  });
}

for (const section of [
  "Wave 1: Wider", "Wave 2: Deeper", "Wave 3: Contrarian",
  "Parent Synthesis and Disposition", "Cycle Re-entry Evaluation",
]) {
  test(`executed research requires ${section} in every cycle`, () => {
    const content = removeSection(research(), section, 4);
    assert.ok(validateResearchArtifact(content).some((error) => error.includes(section)));
  });
}

test("research rejects out-of-order waves even when their names all occur", () => {
  const content = research()
    .replace("#### Wave 1: Wider", "#### SWAP")
    .replace("#### Wave 2: Deeper", "#### Wave 1: Wider")
    .replace("#### SWAP", "#### Wave 2: Deeper");
  assert.ok(validateResearchArtifact(content).some((error) => error.includes("canonical order")));
});

test("research rejects absent, duplicate and malformed cycle blocks", () => {
  const content = research();
  assert.ok(validateResearchArtifact(
    content.replace(/### Cycle 1[\s\S]*?(?=## Evidence Log)/, "No work.\n"),
  ).some((error) => error.includes("at least one")));
  const cycle = content.slice(content.indexOf("### Cycle 1"), content.indexOf("## Evidence Log"));
  assert.ok(validateResearchArtifact(content.replace("## Evidence Log", cycle + "## Evidence Log"))
    .some((error) => error.includes("unique")));
  assert.ok(validateResearchArtifact(content.replace("## Evidence Log", "### Cycle two\nIncomplete.\n## Evidence Log"))
    .some((error) => error.includes("Cycle <number>")));
});

test("reused research does not excuse an incomplete retained cycle", () => {
  const content = research().replaceAll("| executed ", "| reused ");
  assert.ok(validateResearchArtifact(removeSection(content, "Wave 3: Contrarian", 4))
    .some((error) => error.includes("Wave 3: Contrarian")));
});

test("research requires reflection and re-entry records rather than labels alone", () => {
  assert.ok(validateResearchArtifact(research().replaceAll("* Reflection:", "* Observation:"))
    .some((error) => error.includes("Reflection")));
  assert.ok(validateResearchArtifact(research().replace("* Trigger or stop basis:", "* Other:"))
    .some((error) => error.includes("Trigger or stop basis")));
});

test("research synthesis cannot consist only of an empty table header", () => {
  const content = research().replace(
    /#### Parent Synthesis and Disposition\n[\s\S]*?(?=\n#### Cycle Re-entry Evaluation)/,
    "#### Parent Synthesis and Disposition\n\n| Claim | Rationale |\n|---|---|\n",
  );
  assert.ok(validateResearchArtifact(content).some((error) =>
    error.includes("Parent Synthesis and Disposition must contain a completed record")));
});

test("research completion is separate from planning readiness", () => {
  const content = research().replace("* Status: Not applicable", "* Status: Not ready");
  assert.deepEqual(validateResearchArtifact(content), []);
  assert.ok(validateResearchArtifact(content.replace("| Complete ", "| Partial "))
    .some((error) => error.includes("Complete")));
  assert.ok(validateResearchArtifact(content.replace("* [x]", "* [ ]"))
    .some((error) => error.includes("unchecked")));
});

test("research rejects inconsistent disposition and unfinished fields", () => {
  assert.ok(validateResearchArtifact(research().replace("| executed ", "| reused "))
    .some((error) => error.includes("dispositions must agree")));
  assert.ok(validateResearchArtifact(research("invented"))
    .some((error) => error.includes("disposition must")));
  assert.ok(validateResearchArtifact(research().replace("* Why it matters: Recorded", "* Why it matters: "))
    .some((error) => error.includes("Why it matters")));
  assert.ok(validateResearchArtifact(research().replace("## Key Discoveries", "## Key Discoveries\n{{unfilled}}"))
    .some((error) => error.includes("placeholders")));
});

test("pinned plan and phase-details templates form a valid structural pair", () => {
  const { plan, details } = planning();
  assert.deepEqual(validatePlanArtifacts(plan, details), []);
});

test("current plan IDs may be reordered or renumbered without a historical sequence", () => {
  const { plan, details } = planning();
  assert.deepEqual(validatePlanArtifacts(plan.replaceAll("P01", "P07"), details.replaceAll("P01", "P07")), []);
});

test("plan structure does not impose a Pass-only critique loop or prove readiness", () => {
  const { plan, details } = planning();
  const revised = plan.replace("| Recorded ", "| Revise; PC-001 resolved with explicit evidence ")
    .replace("* Planning status: ready", "* Planning status: draft");
  assert.deepEqual(validatePlanArtifacts(revised, details), []);
});

for (const section of [
  "Executive Summary", "User Decisions and Requirements", "Goals", "Scope and Non-Goals",
  "Functional Requirements", "Non-Functional Requirements", "Acceptance Criteria",
  "Implementation Context Record", "Critique Disposition", "Follow-Up Items", "Handoff",
]) {
  test(`plan requires canonical ${section} section`, () => {
    const { plan, details } = planning();
    assert.ok(validatePlanArtifacts(removeSection(plan, section), details)
      .some((error) => error.includes(section)));
  });
}

test("plan requires summary and follow-up sections at their prescribed locations", () => {
  const { plan, details } = planning();
  assert.ok(validatePlanArtifacts(plan.replace("## Executive Summary", "## Interlude\nText\n## Executive Summary"), details)
    .some((error) => error.includes("immediately follow Task Metadata")));
  assert.ok(validatePlanArtifacts(plan.replace("## Handoff", "## Interlude\nText\n## Handoff"), details)
    .some((error) => error.includes("immediately follow Follow-Up Items")));
});

test("plan/details identity and active ID sets must agree", () => {
  const { plan, details } = planning();
  assert.ok(validatePlanArtifacts(plan, details.replace("task-123", "different-task"))
    .some((error) => error.includes("Task ID must match")));
  assert.ok(validatePlanArtifacts(plan, details.replaceAll("P01-T01", "P01-T02"))
    .some((error) => error.includes("missing P01-T01")));
  assert.ok(validatePlanArtifacts(plan, details.replaceAll("P01-T01", "P01-T02"))
    .some((error) => error.includes("no matching plan entry")));
  assert.ok(validatePlanArtifacts(plan.replace("* Detail section: P01-T01", "* Detail section: P01-T02"), details)
    .some((error) => error.includes("Detail section must point to the same task ID")));
});

test("plan/details require adjacent matching markers, unique IDs and owning phase", () => {
  const { plan, details } = planning();
  assert.ok(validatePlanArtifacts(plan.replace("<!-- rpi:task id=P01-T01 -->", ""), details)
    .some((error) => error.includes("matching contextual marker")));
  assert.ok(validatePlanArtifacts(plan.replace("<!-- rpi:task id=P01-T01 -->", "<!-- rpi:task id=P01-T02 -->"), details)
    .some((error) => error.includes("orphaned or mismatched")));
  assert.ok(validatePlanArtifacts(plan.replaceAll("P01-T01", "P02-T01"), details.replaceAll("P01-T01", "P02-T01"))
    .some((error) => error.includes("owning phase")));
  assert.ok(validatePlanArtifacts(plan, `${details}\n<!-- rpi:task id=P01-T01 -->\n### P01-T01: Duplicate\n`)
    .some((error) => error.includes("duplicate P01-T01")));
});

for (const section of [
  "Context", "Intent", "Boundaries", "Likely Targets", "Dependencies",
  "Validation Expectations", "Completion Evidence", "Unresolved Items",
]) {
  test(`every task detail requires its own ${section}`, () => {
    const { plan, details } = planning();
    assert.ok(validatePlanArtifacts(plan, removeSection(details, section, 4))
      .some((error) => error.includes(section)));
  });
}

test("task detail cannot satisfy a missing phase-level section", () => {
  const { plan, details } = planning();
  assert.ok(validatePlanArtifacts(plan, removeSection(details, "Context", 3))
    .some((error) => error.includes("### Context")));
});

test("fenced and commented headings cannot spoof required structure", () => {
  const content = removeSection(research(), "Research Brief");
  for (const hidden of [
    "```markdown\n## Research Brief\npretend\n```",
    "~~~markdown\n## Research Brief\npretend\n~~~",
    "<!--\n## Research Brief\npretend\n-->",
  ]) {
    assert.ok(validateResearchArtifact(`${content}\n${hidden}`)
      .some((error) => error.includes("Research Brief")));
  }
  const { plan, details } = planning();
  assert.deepEqual(validatePlanArtifacts(`${plan}\n\`\`\`markdown\n<!-- rpi:phase id=P99 -->\n### [ ] P99: Example\n\`\`\`\n`, details), []);
});

test("validators tolerate CRLF and BOM, but reject frontmatter and applyTo metadata", () => {
  const { plan, details } = planning();
  assert.deepEqual(validateResearchArtifact("\uFEFF" + research().replaceAll("\n", "\r\n")), []);
  assert.deepEqual(validatePlanArtifacts("\uFEFF" + plan.replaceAll("\n", "\r\n"), details), []);
  assert.ok(validateResearchArtifact(`---\ndescription: not artifact content\n---\n${research()}`)
    .some((error) => error.includes("frontmatter")));
  assert.ok(validatePlanArtifacts(plan, `---\napplyTo: "**"\n---\n${details}`)
    .some((error) => error.includes("applyTo")));
});

test("empty and truncated artifacts return deterministic diagnostics rather than throw", () => {
  assert.ok(validateResearchArtifact("").length);
  assert.ok(validatePlanArtifacts("", "").length);
  assert.deepEqual(validateResearchArtifact(""), validateResearchArtifact(""));
  assert.ok(validateResearchArtifact(`${research()}\n\`\`\`\n`)
    .some((error) => error.includes("unclosed")));
});
