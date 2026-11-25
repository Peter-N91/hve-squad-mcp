import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coordinatorRequestFromRun,
  decodeRunParams,
  encodeRunParams,
} from "../src/engine/run-params.js";

test("async run params preserve project context across the durable boundary", () => {
  const encoded = encodeRunParams({
    toolId: "squad_run",
    request: "deliver the project",
    context: "accepted facts",
    project: "legora-storyboard",
    projectContext: {
      schemaVersion: 1,
      projectId: "11111111-1111-4111-8111-111111111111",
      revision: 7,
      sequence: 12,
      trackingRoot: ".copilot-tracking",
      storage: {
        provider: "sharepoint",
        driveId: "drive",
        folderItemId: "folder",
      },
    },
    mode: "autopilot",
  });
  const decoded = decodeRunParams(encoded);
  assert.equal(decoded.project, "legora-storyboard");
  assert.equal(decoded.projectContext?.revision, 7);

  const request = coordinatorRequestFromRun({
    toolId: "squad_run",
    request: "deliver the project",
    context: "accepted facts",
    params: encoded,
  });
  assert.equal(request.project, "legora-storyboard");
  assert.equal(request.projectContext?.projectId, "11111111-1111-4111-8111-111111111111");
});
