import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isNonPublicHost, validateBrowserUrl, validateWorkflow } from "./browser-policy.mjs";

test("browser policy permits public HTTPS and WSS destinations only", () => {
  assert.equal(validateBrowserUrl("https://www.rfc-editor.org/rfc/rfc6585").allowed, true);
  assert.equal(validateBrowserUrl("wss://www.rfc-editor.org/socket", [], { websocket: true }).allowed, true);
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://169.254.169.254/metadata",
    "https://metadata.google.internal",
    "https://example.com:8443",
    "https://example.com@public.example",
  ]) {
    assert.equal(validateBrowserUrl(url).allowed, false, url);
  }
  assert.equal(validateBrowserUrl("https://not-allowed.example/path", ["example.org"]).allowed, false);
  assert.equal(isNonPublicHost("::ffff:10.0.0.1"), true);
  assert.equal(isNonPublicHost("::ffff:a00:1"), true);
});

test("browser workflows are limited to bounded, non-credential interactions", () => {
  assert.equal(validateWorkflow({
    url: "https://example.com",
    steps: [{ action: "click", role: "link", name: "Read more" }, { action: "scroll", deltaY: 800 }],
  }).steps.length, 2);
  assert.throws(() => validateWorkflow({ url: "https://example.com", steps: Array.from({ length: 13 }, () => ({ action: "wait", ms: 1 })) }), /at most 12/);
  assert.throws(() => validateWorkflow({ url: "https://example.com", steps: [{ action: "fill", label: "Search", value: "x".repeat(1001) }] }), /1000 characters/);
  assert.throws(() => validateWorkflow({ url: "https://example.com", steps: [{ action: "press", key: "Control+L" }] }), /not allowed/);
  assert.throws(() => validateWorkflow({ url: "https://example.com", steps: [{ action: "execute", code: "alert(1)" }] }), /unsupported/);
});

test("files executed inside the Linux sandbox use LF line endings", () => {
  for (const name of ["squad-browser", "entrypoint.sh", "browser-runner.mjs", "browser-policy.mjs"]) {
    const content = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.ok(!content.includes("\r"), `${name} must not contain CR characters`);
  }
});

test("a workflow without steps defaults to an empty, iterable list", () => {
  assert.deepEqual(validateWorkflow({ url: "https://example.com" }).steps, []);
});

test("the launcher sets the browser path the agent's allowlisted shell does not inherit", () => {
  const launcher = readFileSync(new URL("./squad-browser", import.meta.url), "utf8");
  assert.match(launcher, /^export PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright$/m);
  const containerfile = readFileSync(new URL("./Containerfile", import.meta.url), "utf8");
  assert.match(containerfile, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright \S+ install/);
});