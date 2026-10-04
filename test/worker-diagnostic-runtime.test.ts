import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { workerDiagnosticRuntime } from "../src/worker-main.js";

test("worker runtime evidence reads only three fixed module URLs and returns hashes, never file bytes", () => {
  const paths: string[] = [];
  const hashes = workerDiagnosticRuntime(url => {
    paths.push(url.pathname);
    return Buffer.from("private module source");
  });
  assert.equal(paths.length, 3);
  assert.ok(paths.every(path => /\/(?:provider-validation|azure-openai|worker-main)\.js$/.test(path)));
  assert.equal(Object.keys(hashes).length, 3);
  assert.ok(Object.values(hashes).every(value =>
    value === createHash("sha256").update("private module source").digest("hex")));
  assert.doesNotMatch(JSON.stringify(hashes), /private module source/);
});
