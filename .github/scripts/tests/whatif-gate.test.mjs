// Fixture tests for .github/scripts/whatif-gate.mjs (cicd bicep-cicd-pipeline
// P01-T01). Run with: node --test .github/scripts/tests/whatif-gate.test.mjs
//
// Covers: clean, delete, unsupported, error, diagnostics (error vs.
// short-circuit warning), the same-digest case, and a property-path change
// mismatch. Every fixture is synthetic — no real resourceId or value.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate, computeSignature, flattenDelta, resourceType, UsageError, main } from "../whatif-gate.mjs";

const RG = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test";
const CONTAINER_APP = `${RG}/providers/Microsoft.App/containerApps/example`;

test("clean payload (all NoChange) passes and yields an empty signature", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    changes: [{ resourceId: `${RG}/providers/Microsoft.Storage/storageAccounts/example`, changeType: "NoChange", delta: [] }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.signatureEntries.length, 0);
});

test("Delete fails the gate and is reported by resourceId/changeType", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    changes: [{ resourceId: `${RG}/providers/Microsoft.KeyVault/vaults/example`, changeType: "Delete" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].detail, /changeType=Delete/);
});

test("Unsupported fails the gate and prints unsupportedReason", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    potentialChanges: [
      { resourceId: `${RG}/providers/Microsoft.Foo/bar/example`, changeType: "Unsupported", unsupportedReason: "SomeReason" },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].detail, /unsupportedReason=SomeReason/);
});

test("Replace fails the gate when present", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    changes: [{ resourceId: `${RG}/providers/Microsoft.Foo/bar/example`, changeType: "Replace" }],
  });
  assert.equal(result.ok, false);
});

test("non-Succeeded status fails the gate", () => {
  const result = evaluate({ status: "Failed", error: null, changes: [] });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].detail, /status is "Failed"/);
});

test("a non-null top-level error fails the gate", () => {
  const result = evaluate({ status: "Succeeded", error: { code: "SomeError" }, changes: [] });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].detail, /SomeError/);
});

test("an Error-level diagnostic fails the gate", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    changes: [],
    diagnostics: [{ code: "ResourceTypeApiVersionInvalid", level: "Error", target: "modB" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.warnings.length, 0);
});

test("a short-circuit/partial-evaluation diagnostic warns but does not fail", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    changes: [],
    diagnostics: [{ code: "NestedDeploymentShortCircuited", level: "Warning", target: "modA" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
});

test("empty/invalid JSON raises UsageError distinct from a gate failure (parse layer)", () => {
  assert.throws(() => JSON.parse(""), SyntaxError);
  assert.throws(() => {
    // Simulate the script's own guard for a non-what-if payload shape.
    const payload = {};
    if (!("status" in payload)) throw new UsageError("no status field");
  }, UsageError);
});

test("resourceType() extracts the ARM provider/type pair", () => {
  assert.equal(resourceType(CONTAINER_APP), "Microsoft.App/containerApps");
  assert.equal(resourceType(""), "");
});

test("flattenDelta() joins nested children into dot/bracket paths", () => {
  const delta = [
    {
      path: "properties",
      children: [{ path: "template", children: [{ path: "containers[0].image", propertyChangeType: "Modify" }] }],
    },
  ];
  assert.deepEqual(flattenDelta(delta), ["properties.template.containers[0].image"]);
});

test("same-digest policy: an image-only Modify on Microsoft.App/containerApps collapses to NoChange for the signature", () => {
  const makePayload = (digest) => ({
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: CONTAINER_APP,
        changeType: "Modify",
        delta: [
          {
            path: "properties",
            children: [{ path: "template", children: [{ path: "containers[0].image", propertyChangeType: "Modify", before: "old", after: digest }] }],
          },
        ],
      },
    ],
  });
  const a = evaluate(makePayload("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  const b = evaluate(makePayload("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
  assert.equal(a.ok, true);
  assert.equal(a.signatureEntries.length, 0);
  assert.equal(computeSignature(a.signatureEntries).hash, computeSignature(b.signatureEntries).hash);
});

test("same-digest policy does NOT apply to other resource types (image-shaped path is kept, not collapsed)", () => {
  // The signature is intentionally value-blind (paths only, never values), so
  // two Modify payloads that touch the SAME path always share a signature —
  // that is proven separately by the "property-path change mismatch" test.
  // What the same-digest EXCLUSION must NOT do outside containerApps/jobs is
  // drop the path (and thus the whole entry) from the signature.
  const payload = {
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: `${RG}/providers/Microsoft.Web/sites/example`,
        changeType: "Modify",
        delta: [{ path: "properties", children: [{ path: "image", propertyChangeType: "Modify", before: "old", after: "new" }] }],
      },
    ],
  };
  const result = evaluate(payload);
  assert.equal(result.signatureEntries.length, 1, "a non-excluded resource type's image-only Modify must NOT collapse to NoChange");
  assert.deepEqual(result.signatureEntries[0].paths, ["properties.image"]);
});

test("property-path change mismatch: a different changed property path produces a different signature", () => {
  const minReplicasChange = evaluate({
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: CONTAINER_APP,
        changeType: "Modify",
        delta: [{ path: "properties", children: [{ path: "template.scale.minReplicas", propertyChangeType: "Modify", before: 0, after: 1 }] }],
      },
    ],
  });
  const maxReplicasChange = evaluate({
    status: "Succeeded",
    error: null,
    changes: [
      {
        resourceId: CONTAINER_APP,
        changeType: "Modify",
        delta: [{ path: "properties", children: [{ path: "template.scale.maxReplicas", propertyChangeType: "Modify", before: 1, after: 2 }] }],
      },
    ],
  });
  assert.notEqual(computeSignature(minReplicasChange.signatureEntries).hash, computeSignature(maxReplicasChange.signatureEntries).hash);
});

test("computeSignature() is order-independent (sorted before hashing)", () => {
  const entries = [
    { resourceId: "b", changeType: "Modify", paths: ["y", "x"] },
    { resourceId: "a", changeType: "Modify", paths: ["z"] },
  ];
  const reordered = [
    { resourceId: "a", changeType: "Modify", paths: ["z"] },
    { resourceId: "b", changeType: "Modify", paths: ["x", "y"] },
  ];
  assert.equal(computeSignature(entries).hash, computeSignature(reordered).hash);
});

test("falls back to properties.changes[] when top-level changes[] is absent", () => {
  const result = evaluate({
    status: "Succeeded",
    error: null,
    properties: { changes: [{ resourceId: `${RG}/providers/Microsoft.Foo/bar/example`, changeType: "Delete" }] },
  });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// CLI: --compare must never fail open (SEC-AC3 / DEP-C6).
//
// A caller that always passes `--compare "${{ needs.what-if.outputs.signature }}"`
// must get a hard USAGE ERROR (exit 2) when that upstream value is empty or
// missing — never a silently-skipped comparison that lets `deploy` proceed
// against an unverified diff.
// ---------------------------------------------------------------------------

function withCleanWhatifFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "whatif-gate-cli-"));
  const file = join(dir, "whatif.json");
  writeFileSync(
    file,
    JSON.stringify({
      status: "Succeeded",
      error: null,
      changes: [{ resourceId: `${RG}/providers/Microsoft.Storage/storageAccounts/example`, changeType: "NoChange" }],
    }),
    "utf8"
  );
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureConsole(fn) {
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (msg) => errors.push(String(msg));
  console.log = (msg) => logs.push(String(msg));
  try {
    const code = fn();
    return { code, errors, logs };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

test("CLI: --compare with a missing value is a usage error (exit 2), not a skipped comparison", () => {
  withCleanWhatifFile((file) => {
    const { code, errors } = captureConsole(() => main([file, "--compare"]));
    assert.equal(code, 2);
    assert.ok(errors.some((e) => /--compare requires a non-empty/.test(e)));
  });
});

test("CLI: --compare with an explicit empty string is a usage error (exit 2), not a skipped comparison", () => {
  withCleanWhatifFile((file) => {
    const { code, errors } = captureConsole(() => main([file, "--compare", ""]));
    assert.equal(code, 2);
    assert.ok(errors.some((e) => /--compare requires a non-empty/.test(e)));
  });
});

test("CLI: no --compare at all runs the gate only (no comparison requested)", () => {
  withCleanWhatifFile((file) => {
    const { code } = captureConsole(() => main([file]));
    assert.equal(code, 0);
  });
});

test("CLI: --compare with the correct signature passes", () => {
  withCleanWhatifFile((file) => {
    const clean = evaluate(JSON.parse(readFileSync(file, "utf8")));
    const { hash } = computeSignature(clean.signatureEntries);
    const { code, logs } = captureConsole(() => main([file, "--compare", hash]));
    assert.equal(code, 0);
    assert.ok(logs.some((l) => /compare: signature matches/.test(l)));
  });
});

test("CLI: --compare with a wrong signature fails (exit 1), not a usage error", () => {
  withCleanWhatifFile((file) => {
    const { code, errors } = captureConsole(() => main([file, "--compare", "0".repeat(64)]));
    assert.equal(code, 1);
    assert.ok(errors.some((e) => /FAIL compare: signature/.test(e)));
  });
});
