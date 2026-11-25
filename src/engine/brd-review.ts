import { Ajv } from "ajv";
import { parse as parseYaml } from "yaml";
import { assertSafeArtifactPath } from "./artifact-store.js";

export interface BrdReviewRequest {
  kind: "brd";
  targetPath: string;
  targetSha256: string;
  document: { id: string; version: string; phase: "Define" | "Govern" };
  sources: { path: string; sha256: string; content?: string }[];
}

const text = { type: "string", minLength: 1, maxLength: 4000 };
const digest = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });
export const BRD_REVIEW_SCHEMA = object({
  kind: { const: "brd" }, targetPath: text, targetSha256: digest,
  document: object({ id: text, version: text, phase: { enum: ["Define", "Govern"] } }),
  sources: { type: "array", maxItems: 16, items: object({
    path: text, sha256: digest, content: { type: "string", minLength: 1, maxLength: 64000 },
  }, ["path", "sha256"]) },
});
const ajv = new Ajv({ allErrors: true, strict: false });
const validRequest = ajv.compile<BrdReviewRequest>(BRD_REVIEW_SCHEMA);

export function parseBrdReview(value: unknown): BrdReviewRequest | undefined {
  if (value === undefined) return undefined;
  if (!validRequest(value) || JSON.stringify(value).length > 256000) throw new Error("review_input_invalid");
  const paths = [value.targetPath, ...value.sources.map((source) => source.path)];
  for (const path of paths) {
    try { assertSafeArtifactPath(path); } catch { throw new Error("review_input_path"); }
  }
  if (new Set(paths).size !== paths.length) throw new Error("review_input_duplicate_path");
  return value;
}

export function checkReviewMetadata(content: string, expected: BrdReviewRequest["document"]): void {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return;
  let data: Record<string, unknown>;
  try { data = parseYaml(frontmatter[1], { maxAliasCount: 0 }) as Record<string, unknown>; }
  catch { throw new Error("review_target_metadata_invalid"); }
  if (!data || typeof data !== "object") throw new Error("review_target_metadata_invalid");
  for (const [key, value] of Object.entries({ brd_id: expected.id, version: expected.version, phase: expected.phase })) {
    if (data[key] !== undefined && String(data[key]) !== value) throw new Error("review_target_metadata_conflict");
  }
}

const statuses = ["RISK", "CAUTION", "COVERED", "NOT_APPLICABLE"];
const severities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const count = { type: "integer", minimum: 0 };
const counts = object(Object.fromEntries(statuses.map((key) => [key, count])));
const brd = object({ id: text, version: text, phase: { enum: ["Define", "Govern"] }, artifact_path: text });
const standard = object({ skill_name: text, skill_version: text });
const location = object({ section: text, line_range: text }, ["section"]);
const finding = object({
  finding_id: text, checklist_item: text, requirement_id: { type: "string", pattern: "^[A-Z]+-[0-9]{3,}$" },
  status: { enum: statuses }, severity: { enum: [...severities, "N/A"] }, location, finding: text,
  recommendation: { anyOf: [text, { type: "null" }] },
}, ["finding_id", "checklist_item", "status", "severity", "location", "finding", "recommendation"]);
const attributes = ["necessary", "appropriate", "unambiguous", "complete", "singular", "feasible", "verifiable", "correct", "conforming"];
const categories = ["functional_suitability", "performance_efficiency", "compatibility", "usability", "reliability", "security", "maintainability", "portability"];
const pct = { type: "number", minimum: 0, maximum: 100 };
const coverage = object({ fr_total: count, fr_with_ac: count, coverage_pct: pct });
const ids = { type: "array", maxItems: 256, items: text };
const timestamp = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" };
export const BRD_FINDINGS_SCHEMA = object({
  schema_version: { const: "BRD_STANDARD_FINDINGS_V1" }, assessment_id: text, assessed_at: timestamp, brd, standard,
  mode: { const: "plan" }, assessment_outcome: { enum: ["plan", "drift"] }, overall_status: { enum: statuses }, summary_counts: counts,
  findings: { type: "array", maxItems: 256, items: finding },
  iso_29148_attributes: object(Object.fromEntries(attributes.map((key) => [key, { type: "integer", minimum: 0, maximum: 3 }]))),
  iso_25010_categories: object(Object.fromEntries(categories.map((key) => [key, { type: "boolean" }]))),
  smart_business_goals: { type: "array", maxItems: 256, items: object({
    goal_id: text, statement: text, specific: { type: "boolean" }, measurable: { type: "boolean" },
    achievable: { type: "boolean" }, relevant: { type: "boolean" }, time_bound: { type: "boolean" }, overall: { enum: ["PASS", "FAIL"] },
  }) }, fr_ac_coverage: coverage, notes: { type: "string", maxLength: 16000 },
}, ["schema_version", "assessment_id", "assessed_at", "brd", "standard", "mode", "overall_status", "summary_counts", "findings",
  "iso_29148_attributes", "iso_25010_categories", "smart_business_goals", "fr_ac_coverage"]);
export const BRD_REPORT_SCHEMA = object({
  schema_version: { const: "BRD_QUALITY_REPORT_V1" }, report_id: text, generated_at: timestamp, brd,
  overall_status: { enum: ["PASS", "NEEDS_REVIEW", "FAIL"] },
  decision_thresholds: object({ iso_29148_core_min_score: { const: 2 }, fr_to_ac_min_pct: pct, fr_to_bg_target_pct: { const: 100 } }),
  gate_decisions: object(Object.fromEntries(["define_exit", "govern_exit"].map((key) =>
    [key, { enum: ["APPROVED", "APPROVED_WITH_COMMENTS", "BLOCKED", "NOT_EVALUATED"] }]))),
  summary_counts: counts, severity_breakdown: object(Object.fromEntries(severities.map((key) => [key, count]))),
  standards_assessed: { type: "array", minItems: 1, maxItems: 1, items: object({
    skill_name: text, skill_version: text, overall_status: { enum: statuses }, findings_ref: text, findings_count: count,
  }, ["skill_name", "skill_version", "overall_status", "findings_count"]) },
  category_summaries: object({
    iso_29148: object({ average_score: { type: "number", minimum: 0, maximum: 3 }, weakest_attribute: { enum: attributes }, weakest_attribute_score: { type: "integer", minimum: 0, maximum: 3 } }),
    iso_25010: object({ covered_categories: { type: "integer", minimum: 0, maximum: 8 }, missing_categories: { type: "array", maxItems: 8, uniqueItems: true, items: { enum: categories } } }),
    smart: object({ goals_total: count, goals_passing: count, pass_rate_pct: pct }),
    fr_ac_coverage: object({ fr_total: count, fr_with_ac: count, coverage_pct: pct, threshold_pct: pct }),
    fr_bg_coverage: object({ fr_total: count, fr_with_bg: count, bg_total: count, coverage_pct: pct, target_pct: { const: 100 }, waiver_required: { type: "boolean" } }),
  }),
  top_findings: { type: "array", maxItems: 10, items: object({
    finding_id: text, standard: text, severity: { enum: severities }, status: { enum: ["RISK", "CAUTION"] }, location, finding: text, recommendation: text,
  }) },
  recommendations: { type: "array", maxItems: 256, items: object({
    id: text, priority: { enum: ["P0", "P1", "P2", "P3"] }, target_section: text, action: text, related_finding_ids: { ...ids, minItems: 1 },
  }) },
  warnings: { type: "array", maxItems: 256, items: object({
    id: text, severity: { enum: ["INFO", "WARNING", "ADVISORY"] }, message: text, related_finding_ids: ids,
  }, ["id", "severity", "message"]) },
  notes: { type: "string", maxLength: 16000 },
}, ["schema_version", "report_id", "generated_at", "brd", "overall_status", "decision_thresholds", "gate_decisions",
  "summary_counts", "severity_breakdown", "standards_assessed", "category_summaries", "top_findings", "recommendations"]);
const validFindings = ajv.compile(BRD_FINDINGS_SCHEMA);
const validReport = ajv.compile(BRD_REPORT_SCHEMA);

/** Structural/provenance checks do not substitute for the reviewer's substantive judgment. */
export function validateBrdReviewOutputs(request: BrdReviewRequest, findings: unknown, report: unknown): "pass" | "revise" | "blocked" {
  if (!validFindings(findings) || !validReport(report)) throw new Error("review_payload_schema");
  const f = findings as Record<string, any>;
  const r = report as Record<string, any>;
  if (!Number.isFinite(Date.parse(f.assessed_at)) || !Number.isFinite(Date.parse(r.generated_at))) throw new Error("review_payload_timestamp");
  const expected = { ...request.document, artifact_path: request.targetPath };
  for (const [key, value] of Object.entries(expected)) {
    if (f.brd[key] !== value || r.brd[key] !== value) throw new Error("review_payload_identity");
  }
  const ids = new Set<string>();
  for (const item of f.findings) {
    if (ids.has(item.finding_id)) throw new Error("review_payload_duplicate_finding");
    ids.add(item.finding_id);
    const benign = ["COVERED", "NOT_APPLICABLE"].includes(item.status);
    if (benign !== (item.severity === "N/A") || (!benign && item.recommendation === null)) throw new Error("review_payload_severity");
  }
  for (const key of statuses) {
    const actual = f.findings.filter((item: any) => item.status === key).length;
    if (f.summary_counts[key] !== actual || r.summary_counts[key] !== actual) throw new Error("review_payload_counts");
  }
  for (const key of severities) {
    if (r.severity_breakdown[key] !== f.findings.filter((item: any) => item.severity === key).length) throw new Error("review_payload_counts");
  }
  const assessed = r.standards_assessed[0];
  if (assessed.findings_count !== f.findings.length || assessed.skill_name !== f.standard.skill_name ||
      assessed.skill_version !== f.standard.skill_version || assessed.overall_status !== f.overall_status) throw new Error("review_payload_standard");
  const status = f.summary_counts.RISK ? "RISK" : f.summary_counts.CAUTION ? "CAUTION" : f.summary_counts.COVERED ? "COVERED" : "NOT_APPLICABLE";
  if (f.overall_status !== status) throw new Error("review_payload_status");
  const c = f.fr_ac_coverage;
  const percent = (n: number, d: number, empty = 0) => d ? 100 * n / d : empty;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  if (c.fr_with_ac > c.fr_total || !near(c.coverage_pct, percent(c.fr_with_ac, c.fr_total))) throw new Error("review_payload_coverage");
  for (const goal of f.smart_business_goals) {
    const passing = ["specific", "measurable", "achievable", "relevant", "time_bound"].every((key) => goal[key]);
    if ((goal.overall === "PASS") !== passing) throw new Error("review_payload_smart");
  }
  const rollup = r.category_summaries;
  const weakest = attributes.reduce((best, key) => f.iso_29148_attributes[key] < f.iso_29148_attributes[best] ? key : best);
  const missing = categories.filter((key) => !f.iso_25010_categories[key]);
  const passing = f.smart_business_goals.filter((goal: any) => goal.overall === "PASS").length;
  if (rollup.iso_29148.weakest_attribute !== weakest || rollup.iso_29148.weakest_attribute_score !== f.iso_29148_attributes[weakest] ||
      !near(rollup.iso_29148.average_score, Math.round(attributes.reduce((sum, key) => sum + f.iso_29148_attributes[key], 0) / 9 * 100) / 100) ||
      rollup.iso_25010.covered_categories !== 8 - missing.length ||
      JSON.stringify([...rollup.iso_25010.missing_categories].sort()) !== JSON.stringify([...missing].sort()) ||
      rollup.smart.goals_total !== f.smart_business_goals.length || rollup.smart.goals_passing !== passing ||
      !near(rollup.smart.pass_rate_pct, percent(passing, f.smart_business_goals.length, 100)) ||
      Object.keys(c).some((key) => rollup.fr_ac_coverage[key] !== c[key]) ||
      rollup.fr_ac_coverage.threshold_pct !== r.decision_thresholds.fr_to_ac_min_pct) throw new Error("review_payload_rollup");
  const bg = rollup.fr_bg_coverage;
  if (bg.fr_total !== c.fr_total || bg.fr_with_bg > bg.fr_total || bg.bg_total !== f.smart_business_goals.length ||
      !near(bg.coverage_pct, percent(bg.fr_with_bg, bg.fr_total)) || bg.waiver_required !== (bg.coverage_pct < bg.target_pct)) throw new Error("review_payload_coverage");
  const blocking = status === "RISK" || ["necessary", "unambiguous", "singular", "verifiable"].some((key) => f.iso_29148_attributes[key] < 2) ||
    c.coverage_pct < r.decision_thresholds.fr_to_ac_min_pct;
  const expectedStatus = blocking ? "FAIL" : status === "CAUTION" || bg.waiver_required ? "NEEDS_REVIEW" : "PASS";
  if (r.overall_status !== expectedStatus ||
      r.gate_decisions.define_exit !== (blocking ? "BLOCKED" : expectedStatus === "NEEDS_REVIEW" ? "APPROVED_WITH_COMMENTS" : "APPROVED") ||
      (request.document.phase === "Define" && r.gate_decisions.govern_exit !== "NOT_EVALUATED") ||
      (request.document.phase === "Govern" && blocking && r.gate_decisions.govern_exit !== "BLOCKED")) throw new Error("review_payload_verdict");
  for (const group of [r.recommendations, r.warnings ?? []]) {
    if (new Set(group.map((item: any) => item.id)).size !== group.length ||
        group.some((item: any) => item.related_finding_ids?.some((id: string) => !ids.has(id)))) throw new Error("review_payload_references");
  }
  for (const top of r.top_findings) {
    const source = f.findings.find((item: any) => item.finding_id === top.finding_id);
    if (!source || top.standard !== f.standard.skill_name ||
        ["status", "severity", "finding", "recommendation"].some((key) => top[key] !== source[key]) ||
        top.location.section !== source.location.section || top.location.line_range !== source.location.line_range) throw new Error("review_payload_references");
  }
  return r.overall_status === "PASS" ? "pass" : r.overall_status === "NEEDS_REVIEW" ? "revise" : "blocked";
}
