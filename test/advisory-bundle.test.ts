import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { AdvisoryBundle, BundleLookupError, BundleResourceError } from "../src/engine/advisory-bundle.js";

test("bundle discovery and loading cover flat and nested skill families, not a research-only allow-list", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisory-bundle-"));
  const files = {
    "skills/rpi-research/SKILL.md": "# Research",
    "skills/business/requirements-author/SKILL.md": "# Requirements",
    "skills/business/requirements-author/references/template.md": "# BRD template",
    "skills/business/requirements-author/references/state.schema.json": "{\"type\":\"object\"}",
    "skills/communication/editor/SKILL.md": "# Editor",
    "skills/writing/editor/SKILL.md": "# Another editor",
    "instructions/business/disclaimer.instructions.md": "# Required disclaimer",
  };
  try {
    for (const [path, text] of Object.entries(files)) {
      const target = join(root, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const bundle = new AdvisoryBundle(root);
    assert.equal((await bundle.list("skills")).length, 4);
    assert.equal((await bundle.skill("requirements-author")).content, "# Requirements");
    assert.equal((await bundle.skill("requirements-author", "references/template.md#section")).content, "# BRD template");
    assert.equal((await bundle.skill("communication/editor")).content, "# Editor");
    await assert.rejects(bundle.skill("editor"), /ambiguous/);
    assert.deepEqual(await bundle.list("instructions"), ["business/disclaimer.instructions.md"]);
    assert.equal((await bundle.instruction("business/disclaimer.instructions.md")).content, "# Required disclaimer");
    assert.equal((await bundle.reference("skills/business/requirements-author/references/state.schema.json")).content, "{\"type\":\"object\"}");
    assert.deepEqual(await bundle.list("skills", true), Object.keys(files).filter((path) => path.startsWith("skills/")).sort());
    await assert.rejects(bundle.skill("requirements-author", "references/absent.md"),
      (error: unknown) => error instanceof BundleLookupError &&
        error.path === "skills/business/requirements-author/references/absent.md" && error.discovery === "list_references");
    await assert.rejects(bundle.reference("skills/business/requirements-author/scripts/run.py"), BundleResourceError);
    await assert.rejects(bundle.skill("unknown"), BundleResourceError);
    await assert.rejects(bundle.skill("requirements-author", "../editor/SKILL.md"), BundleResourceError);
    await assert.rejects(bundle.skill("requirements-author", "scripts/run.py"), BundleResourceError);
    await assert.rejects(bundle.instruction("../skills/rpi-research/SKILL.md"), BundleResourceError);
    await assert.rejects(bundle.skill("C:/private"), BundleResourceError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing pinned trees stay terminal, not recoverable resource lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisory-bundle-"));
  try {
    const bundle = new AdvisoryBundle(root);
    for (const operation of [
      () => bundle.skill("rpi-research"),
      () => bundle.instruction("missing.instructions.md"),
      () => bundle.reference("skills/rpi-research/missing.md"),
    ]) {
      await assert.rejects(operation(), (error: unknown) => error instanceof BundleResourceError && !(error instanceof BundleLookupError));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
