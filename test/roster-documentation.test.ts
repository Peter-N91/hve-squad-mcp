import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseRosterAgents } from "../generators/build-manifests.js";
import { loadProfileTables } from "../src/engine/profiles.js";
import { readRosterDocumentation } from "../src/engine/roster-documentation.js";
import { loadRoutingTables } from "../src/engine/routing.js";
import { resolveSquadGithubRoot } from "../src/paths.js";

test("split and legacy roster layouts resolve identically across runtime and generator readers", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-documentation-"));
  const bundled = resolveSquadGithubRoot()!;
  try {
    const roster = await readFile(join(bundled, "instructions", "squad", "squad-roster.instructions.md"), "utf8");
    const catalog = await readFile(join(bundled, "references", "squad", "roster-catalog.md"), "utf8");
    const routing = await readFile(join(bundled, "instructions", "squad", "squad-routing.instructions.md"), "utf8");
    const combined = `${roster}\n\n${catalog}`;
    for (const layout of ["split", "legacy"]) {
      const github = join(root, layout);
      await mkdir(join(github, "instructions", "squad"), { recursive: true });
      await writeFile(join(github, "instructions", "squad", "squad-roster.instructions.md"), layout === "split" ? roster : combined);
      await writeFile(join(github, "instructions", "squad", "squad-routing.instructions.md"), routing);
      if (layout === "split") {
        await mkdir(join(github, "references", "squad"), { recursive: true });
        await writeFile(join(github, "references", "squad", "roster-catalog.md"), catalog);
      }
      assert.equal(readRosterDocumentation(github), combined);
      assert.deepEqual(loadRoutingTables(github), loadRoutingTables(bundled));
      assert.deepEqual(loadProfileTables(github), loadProfileTables(bundled));
      assert.deepEqual(parseRosterAgents(readRosterDocumentation(github)), parseRosterAgents(readRosterDocumentation(bundled)));
    }
    await rm(join(root, "split", "references", "squad", "roster-catalog.md"));
    assert.throws(() => loadRoutingTables(join(root, "split")), /Could not find the roster cast catalog/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
