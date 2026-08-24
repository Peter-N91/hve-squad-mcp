import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, initializeSession } from "./conformance/support/harness.js";
import { bearer } from "./conformance/support/fake-auth.js";
import { remoteToolAnnotations } from "../src/transports/remote-tool-metadata.js";

const ORIGIN = "https://m365.cloud.microsoft";
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

test("runtime annotations preserve destructive and stateful tool semantics", () => {
  assert.deepEqual(remoteToolAnnotations("squad_memory_write", "Squad Memory Write"), {
    title: "Squad Memory Write",
    destructiveHint: true,
  });
  assert.deepEqual(remoteToolAnnotations("squad_memory_sync", "Squad Memory Sync"), {
    title: "Squad Memory Sync",
    destructiveHint: true,
  });
  assert.deepEqual(remoteToolAnnotations("squad_render_pptx", "Squad Render PPTX"), {
    title: "Squad Render PPTX",
  });
});

test("HTTP tools/list serves embedded descriptions and runtime safety annotations", async () => {
  const harness = buildHarness({ allowedOrigins: [ORIGIN] });
  harness.verifier.register({
    token: "cowork-dynamic",
    tenantId: "77777777-7777-4777-8777-777777777777",
    subject: "cowork-user",
    scopes: [
      "Squad.Research",
      "Squad.Plan",
      "Squad.Review",
      "Squad.Architect",
      "Squad.Run",
      "Squad.Federate",
    ],
  });

  const sessionId = await initializeSession(harness.handler, "cowork-dynamic", ORIGIN);
  const response = await harness.handler.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      origin: ORIGIN,
      authorization: bearer("cowork-dynamic"),
      "mcp-session-id": sessionId,
      ...JSON_HEADERS,
    },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });

  const tools =
    (
      response.body as {
        result?: {
          tools?: {
            name: string;
            description: string;
            annotations?: {
              title?: string;
              readOnlyHint?: boolean;
              destructiveHint?: boolean;
            };
          }[];
        };
      }
    ).result?.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const research = byName.get("squad_research");
  assert.ok(research);
  assert.match(research.description, /Embedded execution \(squad-guided \/ embedded\)/);
  assert.doesNotMatch(research.description, /Delegated execution/i);
  assert.deepEqual(research.annotations, {
    title: "Squad Research",
    readOnlyHint: true,
  });

  const run = byName.get("squad_run");
  assert.ok(run);
  assert.match(run.description, /full advisory pipeline server-side/);
  assert.doesNotMatch(run.description, /-> Implement ->/);
  assert.deepEqual(run.annotations, { title: "Squad Run" });

  const status = byName.get("squad_status");
  assert.ok(status);
  assert.deepEqual(status.annotations, {
    title: "Squad Status",
    readOnlyHint: true,
  });
});
