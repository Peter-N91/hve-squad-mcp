#!/usr/bin/env node
// What-if JSON gate (cicd bicep-cicd-pipeline P01-T01; deployer DC6, security C6/C8/C13).
//
// Turns `az deployment group what-if ... -o json` output into a pass/fail exit
// code, a normalized change signature two independent what-if runs can compare
// without an artifact upload/download, and a human-readable job-summary table.
//
// node:* built-ins only (supply-chain R7) — no npm dependency, so no job that
// runs this script needs `npm ci`/`actions/setup-node` cache.
//
// Contract (deployer DC6):
//   * Read the change list from top-level `changes[]`, falling back to
//     `properties.changes[]` when the top-level key is absent, and separately
//     read top-level `potentialChanges[]` when present.
//   * FAIL (gate) when any entry in either list has `changeType` `Delete` or
//     `Unsupported`, or `Replace` when that value is present.
//   * FAIL when the payload's top-level `status` is anything other than
//     `Succeeded`, or a top-level `error` is non-null.
//   * FAIL (Error-level diagnostic) when any top-level `diagnostics[]` entry
//     has `level === "Error"`.
//   * WARN (non-fatal) on a short-circuit/partial-evaluation diagnostic.
//   * Exit with the USAGE code (2) on empty input, invalid JSON, or a payload
//     that is not shaped like a what-if result — distinct from a gate FAILURE
//     (1), which is a real, well-formed diff this gate refuses to approve.
//
// Change signature (security C6/C8, deployer DC7): sorted, hashed
// `(resourceId, changeType, sorted changed-property paths)` triples, built
// from every entry whose `changeType` is not `NoChange`/`Ignore`. It never
// crosses a workflow-run boundary (no artifact) — a later job in the SAME run
// reads it from `$GITHUB_OUTPUT` (this job's own `outputs.signature`) and
// compares it directly, or via this script's own `--compare` mode.
//
// Same-digest policy (deployer DC6/DC7, this revision's N5 refinement): the
// pre-approval what-if (P03-T02) can only pass a PLACEHOLDER container image
// value, because the `build` job that produces the real digest has not run
// yet; the immediate re-what-if inside `deploy` (P03-T04) always has the real
// digest. That means the container image is EXPECTED to differ between the
// two what-if runs the signature compares — it must never, by itself, look
// like drift. So, for `Microsoft.App/containerApps` and `Microsoft.App/jobs`
// resources ONLY, the container-image property path is excluded from the
// signature's property-path list; if that exclusion leaves a `Modify` entry
// with NO remaining property paths, the entry is dropped from the signature
// entirely (`Modify` collapses to `NoChange` for signature purposes, and
// stays out of it). Every other resource type, and every other property on
// these two resource types, must still match exactly — this is a narrow,
// documented exception, not a blanket "ignore image changes" rule.
//
// Printing convention (security C13's "never print a value", reused here for
// consistency with host/infra/tests/check-no-placeholders.mjs's own rule):
// every message below prints only a `resourceId`, a `changeType`, an
// `unsupportedReason` (when present), a diagnostic `code`/`level`/`target`, or
// a dot-path — never a `before`/`after` property value, and never a
// diagnostic `message` (which can itself embed a value).

import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/** changeType values that fail the gate outright, wherever they appear. */
export const BLOCKING_CHANGE_TYPES = new Set(["Delete", "Unsupported", "Replace"]);

/** changeType values excluded from the change signature entirely. */
const SIGNATURE_EXCLUDED_CHANGE_TYPES = new Set(["NoChange", "Ignore"]);

/** Resource types eligible for the same-digest image-path exclusion (DC6/DC7, N5). */
const IMAGE_EXCLUDED_RESOURCE_TYPES = new Set(["microsoft.app/containerapps", "microsoft.app/jobs"]);

/** Matches a delta property path whose LEAF segment is a container image field. */
const IMAGE_PATH_RE = /(^|[.\]])image$/i;

/** Diagnostic code/message pattern that is a WARNING, not a gate failure. */
const SHORT_CIRCUIT_RE = /short-?circuit|partial[ -]evaluation/i;

/**
 * A structured, non-fatal usage/parse problem — distinct from a gate finding.
 * Signals exit code 2 ("usage/parse error") rather than 1 ("gate failure").
 */
export class UsageError extends Error {}

/** Extract the ARM resource type (e.g. "Microsoft.App/containerApps") from a resourceId. */
export function resourceType(resourceId) {
  const m = /\/providers\/([^/]+\/[^/]+)/i.exec(String(resourceId || ""));
  return m ? m[1] : "";
}

/**
 * Flatten an ARM what-if `delta[]` (each entry: `path`, `propertyChangeType`,
 * optional `children[]`) into a list of fully-qualified, dot/bracket-joined
 * leaf paths. A child whose own `path` starts with `[` (an array index) is
 * concatenated directly onto the parent path; every other child path is
 * joined with a `.` separator.
 */
export function flattenDelta(delta, prefix = "") {
  const out = [];
  for (const entry of delta || []) {
    const segment = entry && typeof entry.path === "string" ? entry.path : "";
    const joined = !segment ? prefix : !prefix ? segment : segment.startsWith("[") ? `${prefix}${segment}` : `${prefix}.${segment}`;
    if (entry && Array.isArray(entry.children) && entry.children.length > 0) {
      out.push(...flattenDelta(entry.children, joined));
    } else if (joined) {
      out.push(joined);
    }
  }
  return out;
}

/** Read the change list per DC6's fallback contract: top-level, else `properties.changes`. */
function readChanges(payload) {
  if (Array.isArray(payload.changes)) return payload.changes;
  if (payload.properties && Array.isArray(payload.properties.changes)) return payload.properties.changes;
  return [];
}

/** `potentialChanges[]` is read only from the top level, per DC6. */
function readPotentialChanges(payload) {
  return Array.isArray(payload.potentialChanges) ? payload.potentialChanges : [];
}

/**
 * Evaluate one parsed what-if payload against the gate contract.
 * Returns `{ ok, failures, warnings, signatureEntries, allEntries }`, never a value.
 */
export function evaluate(payload) {
  const failures = [];
  const warnings = [];

  if (typeof payload !== "object" || payload === null) {
    throw new UsageError("payload is not a JSON object");
  }
  if (!("status" in payload)) {
    throw new UsageError('payload has no top-level "status" field — not a what-if result');
  }

  if (payload.status !== "Succeeded") {
    failures.push({ kind: "status", detail: `status is "${String(payload.status)}", expected "Succeeded"` });
  }
  if (payload.error !== null && payload.error !== undefined) {
    const code = payload.error && typeof payload.error === "object" ? payload.error.code : undefined;
    failures.push({ kind: "error", detail: code ? `top-level error present (code: ${code})` : "top-level error present" });
  }

  for (const diag of Array.isArray(payload.diagnostics) ? payload.diagnostics : []) {
    const level = diag && diag.level;
    const code = (diag && diag.code) || "";
    const target = (diag && diag.target) || "";
    if (level === "Error") {
      failures.push({ kind: "diagnostic", detail: `Error diagnostic (code: ${code || "unknown"}, target: ${target || "n/a"})` });
    } else if (SHORT_CIRCUIT_RE.test(code) || SHORT_CIRCUIT_RE.test((diag && diag.message) || "")) {
      warnings.push({ kind: "diagnostic", detail: `short-circuit/partial-evaluation diagnostic (code: ${code || "unknown"}, level: ${level || "unknown"})` });
    }
  }

  const changes = readChanges(payload);
  const potentialChanges = readPotentialChanges(payload);
  const allEntries = [...changes, ...potentialChanges];

  const signatureEntries = [];
  for (const entry of allEntries) {
    const changeType = entry && entry.changeType;
    const resourceId = (entry && entry.resourceId) || "";
    if (BLOCKING_CHANGE_TYPES.has(changeType)) {
      const reason = entry && entry.unsupportedReason;
      failures.push({
        kind: "change",
        detail: `resourceId=${resourceId} changeType=${changeType}${reason ? ` unsupportedReason=${reason}` : ""}`,
      });
    }
    if (SIGNATURE_EXCLUDED_CHANGE_TYPES.has(changeType)) continue;

    let paths = [...new Set(flattenDelta(entry && entry.delta))].sort();
    const type = resourceType(resourceId).toLowerCase();
    if (IMAGE_EXCLUDED_RESOURCE_TYPES.has(type)) {
      paths = paths.filter((p) => !IMAGE_PATH_RE.test(p));
      // Same-digest policy: a Modify whose ONLY delta was the (now-excluded)
      // image path collapses to NoChange for signature purposes.
      if (changeType === "Modify" && paths.length === 0) continue;
    }
    signatureEntries.push({ resourceId, changeType, paths });
  }

  return { ok: failures.length === 0, failures, warnings, signatureEntries, allEntries };
}

/**
 * Build the stable, order-independent signature string and its sha256 hex
 * digest. Sorts each entry's own path list AND the overall row order, so the
 * signature is stable across two independently-produced what-if payloads for
 * the same underlying diff even if property ordering inside an entry, or
 * entry ordering across the payload, differs (sort BEFORE hashing, not after).
 */
export function computeSignature(signatureEntries) {
  const rows = signatureEntries
    .map((e) => `${e.resourceId}|${e.changeType}|${[...e.paths].sort().join(",")}`)
    .sort();
  const canonical = rows.join("\n");
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { canonical, hash };
}

/** Render the job-summary markdown for one evaluated payload. Never prints a value. */
export function renderSummary(result, signatureHash) {
  const lines = ["### What-if gate", ""];
  lines.push(`* Result: ${result.ok ? "PASS" : "FAIL"}`);
  lines.push(`* Signature: \`${signatureHash}\``);
  if (result.failures.length > 0) {
    lines.push("", "#### Failures", "", "| Kind | Detail |", "| --- | --- |");
    for (const f of result.failures) lines.push(`| ${f.kind} | ${f.detail} |`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "#### Warnings", "", "| Kind | Detail |", "| --- | --- |");
    for (const w of result.warnings) lines.push(`| ${w.kind} | ${w.detail} |`);
  }
  lines.push(
    "",
    "#### Changes (resourceId, changeType, changed paths — never values)",
    "",
    "| Resource | Change type | Changed paths |",
    "| --- | --- | --- |"
  );
  for (const e of result.signatureEntries) {
    lines.push(`| ${e.resourceId} | ${e.changeType} | ${e.paths.join(", ") || "(none)"} |`);
  }
  return lines.join("\n") + "\n";
}

function writeGithubOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${name}=${value}\n`, "utf8");
}

function writeStepSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown, "utf8");
}

function parsePayload(raw, sourceLabel) {
  if (raw.trim().length === 0) {
    throw new UsageError(`${sourceLabel}: empty input`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${sourceLabel}: invalid JSON (${e.message})`);
  }
  return payload;
}

function printFailures(result) {
  for (const f of result.failures) console.error(`FAIL ${f.kind}: ${f.detail}`);
  for (const w of result.warnings) console.warn(`WARN ${w.kind}: ${w.detail}`);
}

// ---------------------------------------------------------------------------
// Self-test fixtures — exercised by `--self-test` and mirrored (not shared
// verbatim) by .github/scripts/tests/whatif-gate.test.mjs, per this task's
// "ship at least three inline fixtures" requirement. Every fixture below is
// synthetic: no real resourceId, subscription, or value.
// ---------------------------------------------------------------------------

const RG = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-example";

function fixtureClean() {
  return {
    status: "Succeeded",
    error: null,
    changes: [{ resourceId: `${RG}/providers/Microsoft.Storage/storageAccounts/ex`, changeType: "NoChange", delta: [] }],
    potentialChanges: [],
  };
}

function fixtureDelete() {
  return {
    status: "Succeeded",
    error: null,
    changes: [{ resourceId: `${RG}/providers/Microsoft.KeyVault/vaults/ex`, changeType: "Delete" }],
  };
}

function fixtureUnsupported() {
  return {
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: `${RG}/providers/Microsoft.Something/thing/ex`,
        changeType: "Unsupported",
        unsupportedReason: "NestedTemplateShortCircuited",
      },
    ],
  };
}

function fixtureError() {
  return { status: "Succeeded", error: { code: "DeploymentWhatIfResourceError" }, changes: [] };
}

function fixtureDiagnostics() {
  return {
    status: "Succeeded",
    error: null,
    changes: [],
    diagnostics: [
      { code: "NestedDeploymentShortCircuited", level: "Warning", target: "modA" },
      { code: "ResourceTypeApiVersionInvalid", level: "Error", target: "modB" },
    ],
  };
}

function fixtureSameDigest(digest) {
  return {
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: `${RG}/providers/Microsoft.App/containerApps/ex`,
        changeType: "Modify",
        delta: [
          {
            path: "properties",
            children: [{ path: "template", children: [{ path: "containers[0].image", propertyChangeType: "Modify", before: "old", after: digest }] }],
          },
        ],
      },
    ],
  };
}

function fixturePropertyMismatch(replicaCount) {
  return {
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: `${RG}/providers/Microsoft.App/containerApps/ex`,
        changeType: "Modify",
        delta: [{ path: "properties", children: [{ path: `template.scale.minReplicas`, propertyChangeType: "Modify", before: 0, after: replicaCount }] }],
      },
    ],
  };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`self-test failed: ${label}: expected ${expected}, got ${actual}`);
}

function assertTrue(actual, label) {
  if (!actual) throw new Error(`self-test failed: ${label}`);
}

/** Runs every fixture and returns nothing; throws on the first failed assertion. */
export function runSelfTest() {
  // 1. Clean payload passes and yields an empty signature.
  {
    const r = evaluate(fixtureClean());
    assertTrue(r.ok, "clean payload should pass");
    assertEqual(r.signatureEntries.length, 0, "clean payload has no signature entries (NoChange excluded)");
  }

  // 2. Delete fails.
  {
    const r = evaluate(fixtureDelete());
    assertTrue(!r.ok, "Delete should fail the gate");
  }

  // 3. Unsupported fails.
  {
    const r = evaluate(fixtureUnsupported());
    assertTrue(!r.ok, "Unsupported should fail the gate");
  }

  // 4. Top-level error fails.
  {
    const r = evaluate(fixtureError());
    assertTrue(!r.ok, "a top-level error should fail the gate");
  }

  // 5. Error-level diagnostic fails; short-circuit warning does not.
  {
    const r = evaluate(fixtureDiagnostics());
    assertTrue(!r.ok, "an Error-level diagnostic should fail the gate");
    assertTrue(r.warnings.length === 1, "the short-circuit diagnostic should be a warning, not a failure");
  }

  // 6. Same-digest policy: two container-image-only Modify payloads, with
  //    DIFFERENT image values, produce the SAME signature.
  {
    const a = evaluate(fixtureSameDigest("sha256:aaaa"));
    const b = evaluate(fixtureSameDigest("sha256:bbbb"));
    assertTrue(a.ok && b.ok, "same-digest fixtures should pass the gate (Modify is not blocking)");
    assertEqual(a.signatureEntries.length, 0, "an image-only Modify on Microsoft.App/containerApps collapses to no signature entry");
    assertEqual(
      computeSignature(a.signatureEntries).hash,
      computeSignature(b.signatureEntries).hash,
      "same-digest policy: signatures must match despite different image values"
    );
  }

  // 7. Property-path change mismatch: the signature is value-blind for the
  //    SAME path set, but a genuinely different property path set must not match.
  {
    const a = evaluate(fixturePropertyMismatch(1));
    const b = evaluate(fixturePropertyMismatch(2));
    assertEqual(
      computeSignature(a.signatureEntries).hash,
      computeSignature(b.signatureEntries).hash,
      "same path, different value: signature is value-blind (paths only) for the SAME path set"
    );
    const c = evaluate({
      status: "Succeeded",
      error: null,
      changes: [
        {
          resourceId: `${RG}/providers/Microsoft.App/containerApps/ex`,
          changeType: "Modify",
          delta: [{ path: "properties", children: [{ path: "template.scale.maxReplicas", propertyChangeType: "Modify", before: 1, after: 2 }] }],
        },
      ],
    });
    assertTrue(
      computeSignature(a.signatureEntries).hash !== computeSignature(c.signatureEntries).hash,
      "a different changed property path must produce a different signature"
    );
  }

  console.log("whatif-gate.mjs --self-test: all checks passed");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return ["usage: node whatif-gate.mjs <whatif.json> [--compare <expected-signature-hex>]", "       node whatif-gate.mjs --self-test"].join("\n");
}

export function main(argv) {
  if (argv[0] === "--self-test") {
    try {
      runSelfTest();
      return 0;
    } catch (e) {
      console.error(String(e.message || e));
      return 1;
    }
  }

  const file = argv[0];
  if (!file) {
    console.error(usage());
    return 2;
  }
  // `--compare` is intentionally a THREE-state flag, not a boolean: absent
  // (no comparison requested), present with a non-empty value (compare), or
  // present with an empty/missing value — which is a USAGE ERROR, not "skip
  // the comparison". A caller that always passes `--compare
  // "${{ needs.what-if.outputs.signature }}"` must never have an empty
  // upstream signature silently treated as "no comparison requested": that
  // would let a `deploy` job proceed against an unverified diff whenever the
  // upstream `what-if` job produced no real signature (SEC-AC3/DEP-C6 — a
  // fail-open bug this exact check exists to close).
  let compareRequested = false;
  let compareTo;
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === "--compare") {
      compareRequested = true;
      compareTo = argv[(i += 1)];
    }
  }
  if (compareRequested && !compareTo) {
    console.error("FAIL usage: --compare requires a non-empty expected-signature value");
    return 2;
  }

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`FAIL usage: cannot read ${file} (${e.code || e.message})`);
    return 2;
  }

  let payload;
  let result;
  try {
    payload = parsePayload(raw, file);
    result = evaluate(payload);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`FAIL usage: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const { hash } = computeSignature(result.signatureEntries);
  printFailures(result);

  let compareOk = true;
  if (compareRequested) {
    compareOk = hash === compareTo;
    if (!compareOk) {
      console.error(`FAIL compare: signature ${hash} does not match expected ${compareTo}`);
    } else {
      console.log(`OK   compare: signature matches (${hash})`);
    }
  }

  writeStepSummary(renderSummary(result, hash));
  writeGithubOutput("signature", hash);
  writeGithubOutput("ok", String(result.ok && compareOk));

  if (!result.ok || !compareOk) return 1;
  console.log(`OK   ${file}: what-if gate passed (signature ${hash})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main(process.argv.slice(2)));
}
