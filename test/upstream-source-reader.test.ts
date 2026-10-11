import assert from "node:assert/strict";
import { test } from "node:test";
import { readUpstreamPublicSource } from "../src/engine/copilot/upstream-source-reader.js";

test("upstream sources reject unapproved origins, private addresses, credentials and query data before connecting", async () => {
  for (const url of ["http://learn.microsoft.com/x", "https://127.0.0.1/x", "https://169.254.169.254/x", "https://evil.example/x", "https://learn.microsoft.com/x?private=data", "https://user@learn.microsoft.com/x"]) {
    await assert.rejects(readUpstreamPublicSource(url, new AbortController().signal), /refused|not authorized/);
  }
});
