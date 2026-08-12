/**
 * The presenter owes a deck, and the product-owner owes work items.
 *
 * Both roles previously produced prose that described the artifact instead of
 * being it — a deck nobody could open, and a bulleted backlog a human had to
 * retype into Azure DevOps. These tests pin the conversion and, just as
 * importantly, pin that a model which ignores the output contract degrades to
 * "the markdown is still there" rather than failing the run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import type { CoordinatorRequest } from "../src/engine/coordinator-engine.js";
import { loadProfileTables } from "../src/engine/profiles.js";
import {
  extractDeckYaml,
  SquadRunRecorder,
  type DeckRenderer,
} from "../src/engine/squad-run-recorder.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "acme";
const RUN = "run-9";
const TABLES = loadProfileTables();
const REQUEST: CoordinatorRequest = { toolId: "squad_run", request: "build the deck" };

class FakeRenderer implements DeckRenderer {
  readonly calls: { contentYaml: string; tenantId: string }[] = [];
  constructor(private readonly fail = false) {}
  render(
    request: { contentYaml: string; styleYaml: string },
    ctx: { tenantId: string },
  ): Promise<{ isError?: boolean; content: { type: string; text?: string }[] }> {
    this.calls.push({ contentYaml: request.contentYaml, tenantId: ctx.tenantId });
    return Promise.resolve(
      this.fail
        ? { isError: true, content: [{ type: "text", text: "Render input rejected: bad shape" }] }
        : { content: [{ type: "text", text: "Download: https://example/deck.pptx?sig=REDACTED" }] },
    );
  }
}

function makeFixture(renderer?: DeckRenderer) {
  const dir = mkdtempSync(join(tmpdir(), "deliverables-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  return {
    store,
    recorder: new SquadRunRecorder({
      store,
      tables: TABLES,
      renderer,
      today: () => "2026-08-07",
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const DECK_PROSE = [
  "Here is the deck outline.",
  "",
  "```yaml",
  "slides:",
  "  - layout: title",
  "    title: Onboarding",
  "  - layout: bullets",
  "    title: Goals",
  "```",
].join("\n");

test("extractDeckYaml takes only a fenced block carrying a top-level slides key", () => {
  assert.match(extractDeckYaml(DECK_PROSE) ?? "", /^slides:/);
  // A YAML fragment that is not a deck must not be rendered as one.
  assert.equal(extractDeckYaml("```yaml\nowner: alice\n```"), undefined);
  assert.equal(extractDeckYaml("no fences here, slides: 3"), undefined);
});

test("a presenter stage becomes a rendered deck plus its reproducible source", async () => {
  const renderer = new FakeRenderer();
  const fixture = makeFixture(renderer);
  try {
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, RUN, {
      roleKey: "presenter",
      agentName: "PowerPoint Subagent",
      artifact: DECK_PROSE,
    });

    assert.equal(renderer.calls.length, 1);
    assert.equal(renderer.calls[0].tenantId, TENANT);

    const root = ".copilot-tracking/ppt/2026-08-07/deck";
    const pointer = await fixture.store.get(TENANT, PROJECT, `${root}/deck-${RUN}.md`);
    assert.match(pointer?.content ?? "", /Download: https:\/\/example\/deck\.pptx/);
    // The YAML is kept so the deck is reproducible after the SAS expires.
    const source = await fixture.store.get(TENANT, PROJECT, `${root}/deck-${RUN}.yaml`);
    assert.match(source?.content ?? "", /^slides:/);
  } finally {
    fixture.cleanup();
  }
});

test("a failed render is recorded, not swallowed, and never loses the markdown", async () => {
  const fixture = makeFixture(new FakeRenderer(true));
  try {
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, RUN, {
      roleKey: "presenter",
      agentName: "PowerPoint Subagent",
      artifact: DECK_PROSE,
    });
    const root = ".copilot-tracking/ppt/2026-08-07/deck";
    const pointer = await fixture.store.get(TENANT, PROJECT, `${root}/deck-${RUN}.md`);
    assert.match(pointer?.content ?? "", /Deck render failed/);
    const tree = (await fixture.store.list(TENANT, PROJECT, root)).map((e) => e.path);
    assert.ok(tree.some((p) => p.endsWith(`${RUN}.md`)));
  } finally {
    fixture.cleanup();
  }
});

test("a presenter that emits no deck YAML still leaves its markdown deliverable", async () => {
  const renderer = new FakeRenderer();
  const fixture = makeFixture(renderer);
  try {
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, RUN, {
      roleKey: "presenter",
      agentName: "PowerPoint Subagent",
      artifact: "I would suggest a five slide deck about onboarding.",
    });
    assert.equal(renderer.calls.length, 0, "nothing to render, so nothing was rendered");
    const tree = (await fixture.store.list(TENANT, PROJECT, ".copilot-tracking/ppt")).map(
      (e) => e.path,
    );
    assert.equal(tree.length, 1, "the role's markdown deliverable is still written");
  } finally {
    fixture.cleanup();
  }
});

test("a product-owner stage becomes work items a connector can create", async () => {
  const fixture = makeFixture();
  try {
    const backlogProse = [
      "Here is the backlog.",
      "",
      "```json",
      JSON.stringify({
        summary: "Onboarding",
        epics: [
          {
            ref: "E1",
            title: "Onboarding",
            stories: [
              { ref: "S1", title: "Sign up", tasks: [{ ref: "T1", title: "Form" }] },
            ],
          },
        ],
      }),
      "```",
    ].join("\n");

    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, RUN, {
      roleKey: "product-owner",
      agentName: "Functional Planner",
      artifact: backlogProse,
    });

    const file = await fixture.store.get(
      TENANT,
      PROJECT,
      `.copilot-tracking/plans/backlog-${RUN}.json`,
    );
    assert.ok(file, "the structured backlog was written");
    const parsed = JSON.parse(file?.content ?? "{}") as {
      workItems: { ref: string; type: string; parentRef?: string }[];
    };
    // Flat, parents first, children linked by parentRef — the shape the native
    // ADO/Jira connector is looped over one item per call.
    assert.deepEqual(
      parsed.workItems.map((i) => i.type),
      ["Epic", "User Story", "Task"],
    );
    assert.equal(parsed.workItems[1].parentRef, parsed.workItems[0].ref);
  } finally {
    fixture.cleanup();
  }
});

test("a product-owner that emits no parsable backlog writes no work-item file", async () => {
  const fixture = makeFixture();
  try {
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, RUN, {
      roleKey: "product-owner",
      agentName: "Functional Planner",
      artifact: "We should probably build sign-up first, then billing.",
    });
    const tree = (await fixture.store.list(TENANT, PROJECT, ".copilot-tracking/plans")).map(
      (e) => e.path,
    );
    assert.ok(
      !tree.some((p) => p.endsWith(".json")),
      "an unparsable backlog must not produce a malformed work-item file",
    );
    assert.equal(tree.length, 1, "the role's markdown deliverable is still written");
  } finally {
    fixture.cleanup();
  }
});
