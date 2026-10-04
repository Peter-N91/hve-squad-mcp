import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { test } from "node:test";

import {
  type CoworkManifest,
  validateSkillPackage,
  validateManifest,
} from "../generators/build-cowork-plugin.js";
import { packageRoot } from "../src/paths.js";
import { inspectTaskContext } from "../src/engine/model-preflight.js";

function clone(manifest: CoworkManifest): CoworkManifest {
  return JSON.parse(JSON.stringify(manifest)) as CoworkManifest;
}

const root = packageRoot();
const manifest = JSON.parse(
  readFileSync(join(root, "cowork", "manifest.json"), "utf8"),
) as CoworkManifest;

function executionInstructions(): string {
  const skillRoot = join(root, "cowork", "skills", "hve-project-manager");
  return [
    readFileSync(join(skillRoot, "SKILL.md"), "utf8"),
    readFileSync(join(skillRoot, "references", "execution-protocol.md"), "utf8"),
  ].join("\n");
}

function contextPreflightInstructions(): string {
  return readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "context-preflight.md"),
    "utf8",
  );
}

test("Cowork selects task-only context before dispatch without keyword censorship", () => {
  const text = contextPreflightInstructions().replace(/\s+/g, " ");
  for (const required of [
    "before submission",
    "hve-task-context",
    "32,000 characters",
    "metadata-only `contextSelection` receipt",
    "zero `squad_run` calls",
    "Keep those records unchanged",
    "providerAttempted: false",
    "not by a taboo-word list",
    "not a reason for this updated skill to bypass packet validation",
    "not an executable filter inside Cowork's own model",
    "No local preflight can certify all provider policy decisions",
    "Do not automatically resubmit rejected input",
    "Do not claim an independent full-document review",
    "excludes automatic prior run/state digests",
    "Do not copy excluded bodies or secrets",
  ]) {
    assert.ok(text.includes(required), `Missing context preflight rule: ${required}`);
  }
  const packetText = contextPreflightInstructions().match(/```json\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(packetText);
  const packet = JSON.parse(packetText);
  const inspection = inspectTaskContext(packetText);
  assert.equal(inspection.packet, true);
  assert.equal(inspection.preflight, undefined);
  assert.equal(inspection.text, packetText);
  assert.deepEqual(Object.keys(packet).sort(),
    ["kind", "schemaVersion", "facts", "decisions", "constraints", "openQuestions", "sources", "exclusions"].sort());
  assert.equal(packet.kind, "hve-task-context");
  assert.equal(packet.schemaVersion, 1);
  assert.ok(JSON.stringify(packet).length <= 32_000);
  assert.match(packet.decisions[0], /no manual override/);
  assert.match(packet.constraints[0], /explicitly UNMEASURED/);
  assert.match(executionInstructions(), /\]\(references\/context-preflight\.md\)/);
});

test("Cowork package requires preflight instructions and metadata", () => {
  const fixture = mkdtempSync(join(root, ".cowork-context-preflight-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    for (const replacement of ["", "context-preflight-protocol: references/artifact-sync.md"]) {
      writeFileSync(skillPath,
        original.replace("context-preflight-protocol: references/context-preflight.md", replacement),
        "utf8");
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.context-preflight-protocol=references/context-preflight.md"),
      ));
    }
    writeFileSync(skillPath, original, "utf8");
    assert.deepEqual(validateSkillPackage(fixture, manifest), []);
    const packer = readFileSync(join(root, "cowork", "pack.ps1"), "utf8");
    assert.ok(packer.includes("'references/context-preflight.md'"));
    assert.ok(packer.includes("'context preflight' = '(?m)^\\s+context-preflight-protocol:\\s+references/context-preflight\\.md\\s*$'"));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork explains terminal Responsible-AI blocks without inventing a bypass or resumable gate", () => {
  const text = executionInstructions();
  assert.match(text, /structuredContent\.responsibleAi/);
  assert.match(text, /model_backend_content_policy/);
  assert.match(text, /sameRunResumable: false/);
  assert.match(text, /acknowledgmentCanOverride: false/);
  assert.match(text, /not provided/);
  assert.match(text, /NOT `humanInput`/);
  assert.match(text, /do not invent a question ID/);
  assert.match(text, /review\/correct the legitimate business request/);
  assert.match(text, /stop further work/);
  assert.match(text, /escalate a suspected false positive/);
  assert.match(text, /fresh explicit authorization before any new HVE work/);
  assert.match(text, /automatically retry unchanged content/);
  assert.match(text, /mechanically obfuscate/);
  assert.match(text, /partial filtered output complete/);
  assert.match(text, /rather than asserting that content filtering caused it/);
});

function artifactSyncInstructions(): string {
  return readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "artifact-sync.md"),
    "utf8",
  );
}

function stakeholderLibraryInstructions(): string {
  return readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "stakeholder-library.md"),
    "utf8",
  );
}

test("Cowork stakeholder templates form a portable navigable project library", () => {
  const library = stakeholderLibraryInstructions();
  const templates = new Map(
    [...library.matchAll(/^### `([^`]+)`\r?\n\r?\n```markdown\r?\n([\s\S]*?)```/gm)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual([...templates.keys()], [
    "START-HERE.md",
    "library/deliverables.md",
    "library/decisions.md",
    "library/next-steps.md",
  ]);
  const targets = new Set([
    ...[...templates.keys()].map((path) => `/${path}`),
    "/artifact-index.md", "/state.md", "/next-actions.md",
  ]);
  for (const [path, content] of templates) {
    assert.match(content, /Source checkpoint: <revision> \/\s*<sequence>/);
    assert.match(content, /Observed: <time>/);
    assert.match(content, /\]\((?:\.\.\/)?artifact-index\.md\)/);
    for (const [, title, href] of content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
      assert.ok(title.trim(), `Empty navigation title in ${path}`);
      assert.doesNotMatch(href, /[:\\?#<>]/, `Nonportable template link in ${path}: ${href}`);
      assert.ok(targets.has(posix.resolve("/", posix.dirname(path), href)),
        `Broken relative template link in ${path}: ${href}`);
    }
    if (path.startsWith("library/")) {
      assert.match(content, /\[Start here\]\(\.\.\/START-HERE\.md\)/);
    }
  }
  const dashboard = templates.get("START-HERE.md")!;
  for (const path of [...templates.keys()].filter((path) => path.startsWith("library/"))) {
    assert.ok(dashboard.includes(`](${path})`));
  }
  assert.match(templates.get("library/deliverables.md")!, /No verified deliverables recorded yet/);
  assert.match(templates.get("library/decisions.md")!, /No pending decisions recorded in the verified checkpoint/);
  assert.match(templates.get("library/next-steps.md")!, /No supported next action recorded/);
});

test("Cowork curates verified deliverables without hiding drafts or promoting plans", () => {
  const library = stakeholderLibraryInstructions().replace(/\s+/g, " ");
  for (const required of [
    "navigation, not new HVE work",
    "never copies, moves, renames, rewrites, or reformats those artifacts",
    "A failed run can have a usable unapproved draft",
    "A verified file is not an approved deliverable",
    "Do not classify an ordinary plan as a BRD",
    "Unclassified files remain in the technical index",
    "Keep activity logs, state JSON, execution receipts and provenance sidecars out",
    "Unapproved draft - changes requested",
    "Use \"Accepted\" only with the server acceptance evidence",
    "latest accepted version alongside a newer unapproved draft",
    "If precedence is unknown, show labelled alternatives",
    "Not yet available - retrieval pending",
    "with no download link",
    "last-verified evidence",
  ]) {
    assert.ok(library.includes(required), `Missing deliverable curation rule: ${required}`);
  }
});

test("Cowork decision and next-action views preserve authority and response semantics", () => {
  const library = stakeholderLibraryInstructions().replace(/\s+/g, " ");
  for (const required of [
    "Live server question", "Stakeholder input from review",
    "Deferred collaboration", "Operator gate or technical blocker",
    "Never manufacture a `questionId` for a review finding",
    "distinguish answered, submitted, and server-accepted states",
    "Current status unverified",
    "complete notice and exact question/choices",
    "Editing a Markdown checkbox or a row is not a submitted answer",
    'Use "Unassigned" and "Not set"',
    "Never assign the signed-in user by default",
    "draft retention into business approval",
    "current `next-actions.md`, live server guidance and recorded user dispositions",
    "A terminal run is not resumable",
    "No new run is needed just to rebuild this library",
    "Do not promote historical capability failures to current blockers",
  ]) {
    assert.ok(library.includes(required), `Missing decision/action boundary: ${required}`);
  }
});

test("Cowork library migration and refresh preserve conflicts, identity and truthful freshness", () => {
  const library = stakeholderLibraryInstructions().replace(/\s+/g, " ");
  for (const required of [
    "No cloud files are migrated merely by installing a plugin ZIP",
    "without changing project identity or resetting acknowledgments",
    "no-overwrite preconditions",
    "divergent user content, stop replacement",
    "do not overwrite a whole README to add one link",
    "last-verified-hash and eTag protections",
    "current bytes and eTags before each conditional refresh",
    "stable item IDs and readback verification",
    "not only the newest response",
    "Paths in `library/*.md` need `../`",
    "reject unsafe schemes and never retain signed URLs",
    "Do not publish placeholders or links to missing navigation pages",
    "Write the manifest last",
    "optional local `stakeholderLibrary` block",
    "not HVE deliverables or additional MCP inputs",
    "first writable checkpoint/recovery record and the user response",
    "A fresh dashboard must not conceal stale child pages",
    "it never advances bridge acknowledgments",
    "ask the native question first",
  ]) {
    assert.ok(library.includes(required), `Missing library refresh safeguard: ${required}`);
  }
});

test("Cowork library is wired into creation, resume, decision-only and failed-turn checkpointing", () => {
  const skillRoot = join(root, "cowork", "skills", "hve-project-manager");
  for (const file of [
    "SKILL.md", "references/project-contract.md",
    "references/execution-protocol.md", "references/artifact-sync.md",
  ]) {
    assert.ok(readFileSync(join(skillRoot, file), "utf8").includes("stakeholder-library.md"),
      `Missing library protocol wiring in ${file}`);
  }
  const execution = executionInstructions().replace(/\s+/g, " ");
  for (const required of [
    "Missing pages are not missing deliverables",
    "Refresh the stakeholder decision inbox",
    "Include decision-only updates and held/failed outcomes",
    "Do not delay a live `humanInput` native question behind library generation",
    "only after manifest readback verifies the write",
    "Lead with the verified Start here link",
    "For navigation-only repair, use steps 1-2 and 6; do not invoke HVE tools",
  ]) {
    assert.ok(execution.includes(required), `Missing lifecycle wiring: ${required}`);
  }
});

test("Cowork validator and packer require the stakeholder library protocol", () => {
  const fixture = mkdtempSync(join(root, ".cowork-library-contract-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    for (const replacement of ["", "stakeholder-library-protocol: references/artifact-sync.md"]) {
      writeFileSync(skillPath,
        original.replace("stakeholder-library-protocol: references/stakeholder-library.md", replacement),
        "utf8");
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.stakeholder-library-protocol=references/stakeholder-library.md"),
      ));
    }
    writeFileSync(skillPath, original, "utf8");
    assert.deepEqual(validateSkillPackage(fixture, manifest), []);
    const packer = readFileSync(join(root, "cowork", "pack.ps1"), "utf8");
    assert.ok(packer.includes("'references/stakeholder-library.md'"));
    assert.ok(packer.includes("'stakeholder library' = '(?m)^\\s+stakeholder-library-protocol:\\s+references/stakeholder-library\\.md\\s*$'"));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork synchronizes every response with a prompt live-question handoff exception", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  const execution = executionInstructions().replace(/\s+/g, " ");
  assert.ok(execution.includes("[references/artifact-sync.md](references/artifact-sync.md)"));
  assert.ok(execution.includes("before another poll or ordinary handoff"));
  for (const required of [
    "after every `squad_run` or `squad_status` response",
    "queued, running, held, failed, cancelled, expired, and completed runs",
    "An omitted stage, empty response artifact array",
    "not evidence that no artifacts exist",
    "not just each stage's primary artifact",
    "exact accepted partition",
    "Unknown provenance stays unknown",
    "run-1` must not capture `run-10",
    "Follow previously verified same-run paths on every poll",
    "partial-unaccepted",
    "Keep active activities `in-progress`",
    "History reads confer no bridge acknowledgment",
    "Never start a new run or call maintenance/memory writes",
    "entire accepted projection verified",
  ]) {
    assert.ok(sync.includes(required), `Missing partial-run synchronization rule: ${required}`);
  }
});

test("Cowork full retrieval handles spills, legacy caps, page integrity, and changing source versions", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const required of [
    'op: "index"', 'op: "list"', 'op: "read"',
    "Follow every advertised listing cursor",
    "500 entries without pagination",
    "coverage as unknown/pending, not empty",
    "spilled into a host resource/file",
    "that exact returned reference and exhaust its pages",
    "`offset: 0`",
    "`nextOffset` exactly until null",
    "UTF-16 characters, not bytes",
    "without gaps/overlap",
    "same project, path, updatedAt, totals, and whole-file hash",
    "Verify each page hash",
    "total characters, UTF-8 byte length, and whole SHA-256",
    "restart from zero once",
    "64,000 characters",
    "Reject truncated content as a complete artifact",
    "Never invent paging support",
    "never a mixed-version file",
    "no added BOM",
  ]) {
    assert.ok(sync.includes(required), `Missing full-read safeguard: ${required}`);
  }
});

test("Cowork negotiates opt-in paging without requiring optional source fields or unnecessary spills", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const required of [
    "prefer opt-in paging to the legacy no-offset preview",
    "The paged machine JSON supplies `path`, `content`, `offset`, `nextOffset`",
    "`totalChars`, `totalBytes`, `sha256` (full UTF-8 content), `pageSha256`, and `updatedAt`",
    "Do not require `etag`, `endOffset`, or `truncated` fields",
    "Page content has no appended truncation marker",
    "each later offset equals the previous `nextOffset`",
    "positive progress",
    "including the valid empty-file case",
    "When `offset` is not advertised, do not send it",
    "never mirror a truncated preview at the canonical path",
    "Small exact inline outputs need no spill",
    "content matches the source SHA-256",
    "Never reconstruct content from prose or normalize it to make a hash match",
  ]) {
    assert.ok(sync.includes(required), `Missing capability-dependent retrieval rule: ${required}`);
  }
});

test("Cowork decodes one exact page envelope and uses full inventory rather than bounded projection", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const required of [
    "`trackingUpdatePaths` describes a bounded projection, not a complete artifact manifest",
    "Always fall back to full read-only history listing for inventory",
    "history lists 16",
    "coverage remains pending",
    "An inline envelope need not be materialized as a local file",
    "host explicitly exposes raw tool-result capture for this current task",
    "another optional exact-content source, not a required transport",
    "matching the actual history call id and its verified project/run context",
    "Never hardcode a capture filename or directory",
    "search other sessions/tasks, scan logs broadly",
    "Extract only the artifact payload",
    "missing spill or task-local capture does not block an otherwise exact hash-verified inline artifact",
    "verify the destination hash against the source receipt",
    "JSON in `content[0].text` and as the identical `structuredContent` object",
    "Do not append both equivalent representations as duplicate pages",
    "If both are available but disagree, block",
    "validate it equals `offset` plus the exact content's UTF-16 length",
    "final `endOffset` must equal `totalChars`",
    "source `etag` and full `sha256` to remain stable across all pages",
    "including the last page when offset is greater than zero",
    "Do not use `truncated: false` as the completion criterion",
    "`nextOffset: null`",
    "assembled `totalBytes` and full `sha256`",
  ]) {
    assert.ok(sync.includes(required), `Missing envelope/inventory safeguard: ${required}`);
  }
});

test("Cowork identity mapping mirrors only actual canonical paths, including BRDs under plans", () => {
  const sync = artifactSyncInstructions();
  const rows = new Map(
    [...sync.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)]
      .map((match) => [match[1], match[2]]),
  );
  const sources = [
    ".copilot-tracking/research/2026-09-19/R-research.md",
    ".copilot-tracking/plans/2026-09-19/R/artifact.md",
    ".copilot-tracking/details/2026-09-19/R/phase-details.md",
    ".copilot-tracking/reviews/2026-09-19/R/plan-critique.md",
    ".copilot-tracking/plans/2026-09-19/R/brd/artifact.md",
    ".copilot-tracking/squad/members/product/plans/R/brd/reviews/quality.md",
    "docs/architecture/R/design.md",
    ".copilot-tracking/backlog/R/items.json",
    "docs/decisions/R/adr.md",
    ".copilot-tracking/changes/R/change.md",
    "outputs/R/report.pdf",
  ];
  for (const source of sources) {
    assert.equal(rows.get(source), source, `Canonical path was remapped: ${source}`);
  }
  assert.equal(rows.size, sources.length);
  assert.equal(new Set(rows.values()).size, rows.size, "Example mappings must not collide");
  const normalized = sync.replace(/\s+/g, " ");
  assert.ok(normalized.includes("Create artifact parent folders on demand only for actual validated persisted files"));
  assert.ok(normalized.includes("A plan to write a BRD remains a plan"));
  assert.ok(normalized.includes("byte-identical to the verified source version"));
  assert.ok(normalized.includes("there is no alternate filesystem fallback"));
  assert.ok(normalized.includes("Unknown-provenance files remain pending"));
  assert.doesNotMatch(sync, /<category>\/runs|deliverables\/runs|Both copies|Additional visible copy/);
});

test("Cowork separates result, call-input and context budgets without inventing host limits", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const rule of [
    "do not invent numeric Cowork platform limits",
    "Per-result limit", "Call-input limit", "Conversation/context budget",
    "Smaller writes do not repair a clipped source result",
    "Offset support alone does not imply adjustable page size",
    "Never invent `limit`, `maxChars`, byte-range, export, or download parameters",
    "not universal limits",
    "A transient model/session error is not proof of a size limit or HVE run failure",
    "Bound the batch by total transport payload and calls, not only file count",
    "Leave capacity for page read-back, durable checkpoint and handoff",
    "rather than repeating the same oversized call",
  ]) assert.ok(sync.includes(rule), `Missing interaction-budget rule: ${rule}`);
});

test("Cowork discovers genuine transfer capabilities without assuming scripted HVE access", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const rule of [
    "Discover the source and destination capabilities independently",
    "actually exposed native file/resource handle",
    "A URL string, preview or suggested API is not a working transfer",
    "Never persist credential-bearing/signed handles",
    "not a durable cross-session checkpoint",
    "not necessarily callable inside its workspace scripting runtime",
    "Do not collect all remaining file bodies in conversation before writing them",
    "Authorized deterministic byte-copy, hashing and assembly helpers are transport only",
    "never run project/artifact-provided code",
    "or add dependencies to bypass missing access",
  ]) assert.ok(sync.includes(rule), `Missing capability/transport rule: ${rule}`);
});

test("Cowork per-file recovery ledger is valid metadata-only JSON with an uncommitted initial cursor", () => {
  const sync = artifactSyncInstructions();
  const section = sync.split("### Durable per-file transfer ledger")[1];
  assert.ok(section);
  const json = section.match(/```json\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(json);
  const ledger = JSON.parse(json);
  assert.equal(ledger.schemaVersion, 1);
  for (const field of ["syncId", "projectId", "project", "runId", "sourcePath", "nextAction"]) {
    assert.equal(typeof ledger[field], "string", `Missing transfer identity: ${field}`);
  }
  assert.deepEqual(Object.keys(ledger.storage).sort(), ["driveId", "folderItemId", "provider"]);
  assert.deepEqual(Object.keys(ledger.sourceVersion).sort(), ["sha256", "totalBytes", "totalChars", "updatedAt"]);
  assert.equal(ledger.phase, "retrieving");
  assert.equal(ledger.nextOffset, 0);
  assert.deepEqual(ledger.pages, []);
  assert.equal(ledger.assembly, null);
  assert.equal(ledger.destination.path, ledger.sourcePath);
  assert.equal(ledger.destination.itemId, null);
  assert.equal(ledger.destination.lastVerifiedMirrorSha256, null);
  assert.doesNotMatch(json, /"content"\s*:|"body"\s*:|"token"\s*:|"uploadUrl"\s*:/);
});

test("Cowork live-probe guidance does not overstate offset-only or single-file capabilities", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const evidence of [
    "there is no `limit`, `pageSize` or `length` field",
    "exact server-chosen page, not a caller-sized page",
    "`core-RunScript`'s `aether_tools` discovery",
    "`squad_history not exposed`",
    "not a direct HVE-to-workspace script bridge",
    "historical observations are not current tool authority",
    "not a multi-page test or a numeric Cowork hard limit",
    "never extrapolate success",
  ]) assert.ok(sync.includes(evidence), `Missing probe-evidence boundary: ${evidence}`);
});

test("Cowork stages exact chunks before advancing cursors and publishes only a whole verified file", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const rule of [
    "Read at the last durably verified",
    "no-overwrite precondition",
    "split losslessly at valid Unicode boundaries",
    "Never append blindly",
    "no BOM, newline, wrapper or transcript text",
    "verify its source `pageSha256`",
    "do not paste all chunks into a new invocation",
    "Never advance `nextOffset` before verified staging and durable ledger read-back",
    "A failed ledger commit leaves the page uncommitted",
    "do not duplicate it or repeat an uncertain append",
    "assemble all verified pages in order outside the model context",
    "Verify `totalChars`, `totalBytes` and full `sha256`",
    "including empty files and Unicode content",
    "Never publish a partial canonical file",
    "A returned upload/item id alone is insufficient",
  ]) assert.ok(sync.toLowerCase().includes(rule.toLowerCase()), `Missing staged-persistence rule: ${rule}`);
  assert.ok(sync.indexOf("Read back the fragment/chunks") < sync.indexOf("save/read back the page receipt"));
  assert.ok(sync.indexOf("Only then set phase `assembled`") < sync.indexOf("Promote/upload the complete assembly"));
});

test("Cowork resumes bounded sync from durable metadata without replaying work or bypassing gates", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  const execution = executionInstructions().replace(/\s+/g, " ");
  const contract = readFileSync(join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"), "utf8").replace(/\s+/g, " ");
  for (const rule of [
    "activity/sync/<syncId>/",
    "hve-project.json.syncRecovery",
    "Do not embed artifact bodies in that queue, the manifest, or handoff messages",
    "Reuse verified unchanged pages",
    "reconcile orphaned writes if checkpointing failed",
    "never mix versions or overwrite the last verified canonical copy with fragments",
    "metadata-only handoff",
    "Carry no artifact bodies or credential handles",
    "verified mirrors, pending pages/files, conflicts and unknown coverage separately",
    "never use `squad_run`, answer a question, or release a gate to repair transport",
    "an older source version is not itself a human-edit conflict",
    "A newer server ledger is a safe managed refresh",
  ]) assert.ok(sync.includes(rule), `Missing durable-continuation rule: ${rule}`);
  assert.ok(execution.includes('journal `purpose: "artifact-sync"`'));
  assert.ok(execution.includes("For sync-only recovery, use steps 1-2 and 5-6 with the existing run; skip work submission"));
  assert.ok(execution.includes("File-sync consent never answers or approves a gate"));
  assert.ok(execution.includes("A fresh Cowork session resumes this transport ledger, not HVE execution"));
  assert.ok(execution.includes("For live `humanInput`"));
  assert.ok(contract.includes("retaining unchanged `schemaVersion: 2`"));
  assert.ok(contract.includes("Staging fragments are not `artifacts[]` verified mirrors or library deliverables"));
  assert.ok(contract.includes("They do not change `contextBridge` accepted/projection acknowledgments"));
});

test("Cowork requires shared bytes and ledger before promising cross-session survival", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const rule of [
    "Local workspace chunks may not survive a fresh Cowork task",
    "temporary staging only, never durable resume evidence",
    "BOTH staged chunks (or a completed verified canonical file) AND the cursor/ledger",
    "A shared ledger pointing only at local files is not resumable",
    "leave the durable cursor at its last shared verified boundary",
    "After shared fragment persistence",
    "never an old task's local filesystem path",
    "last contiguous verified shared boundary",
    "Do not promise multi-page survival until an actual interrupted/resumed transfer",
  ]) assert.ok(sync.includes(rule), `Missing shared-storage durability rule: ${rule}`);
});

test("Cowork native retrieval delegation is capability-gated metadata-only transport", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const rule of [
    "distinct route from calling HVE inside workspace scripting",
    "Never guess a native delegation tool name",
    "verify capability with a bounded existing-file retrieval",
    "a progress label is not a successful transfer",
    "disjoint file assignments",
    "No child may start `squad_run`, choose HVE workers",
    "answer questions, approve gates, broaden access or recursively delegate",
    "Children return metadata only",
    "Never return artifact bodies",
    "the parent alone commits the shared queue, manifest and canonical promotion",
    "Revalidate bytes and source receipts independently",
    'A host "shared workspace" may still be task-local',
    "before a fresh-task handoff or durable cursor advance",
    "fall back to bounded serial pages",
    "neither delegated transport nor its completion releases a pending human gate",
    "Use host defaults for model, context and reasoning settings unless the user explicitly specifies them",
  ]) assert.ok(sync.includes(rule), `Missing bounded native-delegation rule: ${rule}`);
});

test("Cowork records the verified native workaround without claiming untested paging or tail completeness", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const rule of [
    "one synchronous probe first",
    "bounded background retrieval workers while the parent performed independent work",
    "loaded the deferred `squad_history` definition",
    "It did not call HVE through `aether_tools`",
    "metadata confirmation, not complete content retrieval",
    "never blindly subtract two characters across a surrogate pair",
    "Use offset zero for empty/very short files",
    "Do not append this tail to the staged file",
    "mistake `pageSha256` for the whole hash",
    "`nextOffset: null` on a tail read as proof of full retrieval",
    "All 30 unique artifacts in that recovery, totaling 341,853 bytes",
    "Every file fit one source page",
    "not multi-page assembly",
    "No actual size/page-cap error was returned",
  ]) assert.ok(sync.includes(rule), `Missing live-workaround evidence boundary: ${rule}`);
});

test("Cowork canonical accounting deduplicates stale overlap instead of inventing a missing file", () => {
  const sync = artifactSyncInstructions();
  const normalized = sync.replace(/\s+/g, " ");
  const section = sync.split("### Unique inventory and disjoint transfer states")[1]?.split("## 2.")[0];
  assert.ok(section);
  assert.deepEqual(
    [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]),
    ["verified", "absent", "stale", "conflict", "unverified", "withheld"],
  );
  for (const rule of [
    "`(projectId, accepted partition, sourcePath)`",
    "not basename, display label, table row, source run or version",
    "These states are mutually exclusive",
    "Inventory coverage is separate",
    "16 + 15 - 1 = 30 unique paths, not 31",
    "two versions of one canonical file",
    "Do not invent a missing 31st file or a disappearance",
    "do not silently rewrite historical audit entries",
  ]) assert.ok(normalized.includes(rule), `Missing unique-path accounting rule: ${rule}`);
  const equation = section.match(/(\d+) \+ (\d+) - (\d+) = (\d+) unique paths/);
  assert.ok(equation);
  const [, existing, pending, overlap, unique] = equation.map(Number);
  assert.equal(existing + pending - overlap, unique);
});

test("Cowork creates only minimal bridge metadata and preserves legacy folders without multiplying copies", () => {
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  );
  const initialTree = contract.match(/```text\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(initialTree);
  for (const forbidden of [
    ".copilot-tracking/", "research/", "plans/", "reviews/", "architecture/",
    "backlog/", "decisions/", "deliverables/",
  ]) {
    assert.ok(!initialTree.includes(forbidden), `Artifact folder scaffolded: ${forbidden}`);
  }
  assert.ok(initialTree.includes("activity/"));
  assert.ok(initialTree.includes("artifact-index.md"));
  for (const required of ["START-HERE.md", "library/", "deliverables.md", "decisions.md", "next-steps.md"]) {
    assert.ok(initialTree.includes(required), `Missing stakeholder navigation: ${required}`);
  }
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const required of [
    "Do not routinely duplicate artifacts into a second category tree",
    "Do not auto-delete, move, rename, refresh, or multiply legacy copies",
    "`legacy-copy`",
    "Do not infer a canonical source by reversing an old category path",
    "Backfill a missing canonical mirror only from a complete verified server read",
    "Cleanup requires separate explicit user authorization",
    "keep existing decision records at their saved paths and resume them there",
    "No synthetic server ledger",
  ]) {
    assert.ok(sync.includes(required), `Missing canonical-only migration safeguard: ${required}`);
  }
});

test("Cowork refresh protects cloud identity, divergent user edits, and exact mirror receipts", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const required of [
    "provider, driveId, folderItemId",
    "Never merge an identity-conflicting response",
    "Only `.copilot-tracking/`, `docs/`, and `outputs/` source roots",
    "absolute/drive/UNC paths, backslashes, dot or empty segments",
    "encoded traversal or separators",
    "case-insensitive/Unicode-equivalent destination collisions",
    "Do not follow shortcuts/links out of that boundary",
    "Do not read or copy other runs' artifacts",
    "withhold it from verbatim mirroring",
    "compare the newly read complete source SHA-256",
    "current hash equals that destination's last verified mirror hash",
    "conditional writes with the current eTag",
    "no-overwrite precondition",
    "never authorizes overwriting divergent user edits",
    "Do not blindly retry",
    "Read back the canonical destination",
    "sourceVersion", "sourceSha256", "sourceByteLength", "mirrorSha256",
    "itemId", "eTag", "stageStatus",
    "keep last verified hashes separately from pending new hashes",
  ]) {
    assert.ok(sync.toLowerCase().includes(required.toLowerCase()), `Missing refresh safeguard: ${required}`);
  }
});

test("Cowork PM index consolidates verified inventory with bridge metadata and links real artifacts", () => {
  const sync = artifactSyncInstructions().replace(/\s+/g, " ");
  for (const required of [
    "`artifact-index.md` at the project root",
    "Link it from `README.md`, `state.md`, and `next-actions.md`",
    "Consolidate the PM's checkpoint/activity metadata with the verified server inventory",
    "link to its actual canonical mirror only after verification",
    "never link a nonexistent local file as saved",
    "status/receipt only",
    '`acceptance: "partial-unaccepted"`',
    "independently of content completeness",
    "Failed index/checkpoint writes leave reconciliation-required",
    "four independent states",
    "Do not advance `lastAcknowledgedRevision` or `lastAcknowledgedSequence`",
    "stage accepted, run terminal, and full tracking projection acknowledged",
  ]) {
    assert.ok(sync.includes(required), `Missing index/acceptance safeguard: ${required}`);
  }
});

test("Cowork validator and packer require synchronization and server-canonical layout contracts", () => {
  const fixture = mkdtempSync(join(root, ".cowork-artifact-sync-contract-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    for (const replacement of ["", "artifact-sync-protocol: references/project-contract.md"]) {
      writeFileSync(
        skillPath,
        original.replace("artifact-sync-protocol: references/artifact-sync.md", replacement),
        "utf8",
      );
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.artifact-sync-protocol=references/artifact-sync.md"),
      ));
    }
    for (const replacement of ["", "artifact-layout: category-copies"]) {
      writeFileSync(
        skillPath,
        original.replace("artifact-layout: server-canonical", replacement),
        "utf8",
      );
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.artifact-layout=server-canonical"),
      ));
    }
    const packer = readFileSync(join(root, "cowork", "pack.ps1"), "utf8");
    assert.ok(packer.includes("'references/artifact-sync.md'"));
    assert.ok(packer.includes("'artifact synchronization'"));
    assert.ok(packer.includes("'canonical artifact layout'"));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork plugin combines one project skill with v1.29 runtime MCP discovery", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual(validateSkillPackage(join(root, "cowork"), manifest), []);
  assert.equal(manifest.manifestVersion, "1.29");
  assert.deepEqual(manifest.agentSkills, [
    { folder: "./skills/hve-project-manager" },
  ]);

  const remote = manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.ok(remote);
  assert.equal(
    Object.prototype.hasOwnProperty.call(remote, "mcpToolDescription"),
    false,
  );
  assert.equal(
    existsSync(join(root, "cowork", "tools", "hve-squad-tools.json")),
    false,
  );
  assert.equal(
    existsSync(
      join(root, "cowork", "skills", "hve-project-manager", "SKILL.md"),
    ),
    true,
  );
});

test("Cowork project contract uses a OneDrive-safe activity filename", () => {
  const contract = readFileSync(
    join(
      root,
      "cowork",
      "skills",
      "hve-project-manager",
      "references",
      "project-contract.md",
    ),
    "utf8",
  );

  assert.match(contract, /activity\/000001-20260101T000000Z\.json/);
  assert.doesNotMatch(contract, /activity\/[^`\r\n]*T00:00:00Z\.json/);
});

test("Cowork project skill bounds orchestrator context and avoids blind retries", () => {
  const skill = executionInstructions();

  assert.match(skill, /at most 32,000\s+serialized characters/);
  assert.match(skill, /Call it once unless the server rejects the input before execution/);
  assert.match(skill, /retry once/i);
});

test("Cowork project skill negotiates schema-v2 project context and tracking updates", () => {
  const skill = executionInstructions();
  const contract = readFileSync(
    join(
      root,
      "cowork",
      "skills",
      "hve-project-manager",
      "references",
      "project-contract.md",
    ),
    "utf8",
  );

  assert.equal(manifest.version, "11.0.21");
  assert.match(skill, /projectContext\.schemaVersion/);
  assert.match(skill, /structuredContent\.contextBridge/);
  assert.match(skill, /trackingUpdates/);
  assert.match(contract, /"schemaVersion": 2/);
  assert.match(contract, /\.copilot-tracking\/squad\/history/);
  assert.match(contract, /Schema 1 migration/);
});

test("Cowork routes every managed work request through the server orchestrator", () => {
  const skill = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "SKILL.md"),
    "utf8",
  );

  assert.match(skill, /tools\/list/);
  assert.match(skill, /nextCursor/);
  assert.match(skill, /inputSchema/);
  assert.match(skill, /orchestrator-entry-tool:\s+squad_run/);
  assert.match(skill, /status-tool:\s+squad_status/);
  assert.match(skill, /output-read-tool:\s+squad_history/);
  assert.match(skill, /approval-tool:\s+squad_approve/);
  assert.match(skill, /human-response-tool:\s+squad_respond/);
  assert.match(skill, /version:\s+"1.21"/);
  assert.match(skill, /responsibility:\s+project-io-bridge/);
  assert.match(skill, /squad_run` is the only work-producing HVE capability/);
  assert.match(skill, /squad_status` may be invoked only with a real run id returned by\s+`squad_run`/);
  assert.match(skill, /Never choose or infer HVE workers, roles, stages, stage order/);
  assert.match(skill, /do not substitute\s+another HVE tool/s);
  assert.match(skill, /Cowork does not choose dependent HVE stages/);
  assert.doesNotMatch(skill, /smallest sufficient combination|compose focused capabilities/);
  assert.doesNotMatch(skill, /\bsquad_(?!run\b|status\b|history\b|approve\b|respond\b)[a-z0-9_]+\b/);
});

test("Cowork blocks on orchestrator failures and avoids duplicate execution", () => {
  const skill = executionInstructions();

  assert.match(skill, /Tool not found.*required entry point is unavailable/s);
  assert.match(skill, /does not authorize a\s+direct-tool fallback/s);
  assert.doesNotMatch(skill, /genuine operator decision|almost always a dropped connection/);
  assert.match(skill, /Retry `squad_run` at most once/);
  assert.match(skill, /recover by run id with\s+`squad_status` first/s);
  assert.match(skill, /Disconnect can be a no-op/);
  assert.match(skill, /refresh or upgrade the plugin connection/);
  assert.match(skill, /A plan to produce an artifact is\s+not the artifact/);
  assert.match(skill, /A chat "approve" does not release this gate/);
  assert.match(skill, /Do not call `squad_run` again to signal approval/);
});

test("Cowork preserves orchestrator results and verifies tracking before checkpointing", () => {
  const skill = executionInstructions();
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  );

  assert.match(skill, /Save text verbatim,\s+structured results as lossless\s+JSON/);
  assert.match(skill, /summaries, formatting transformations.*separate/s);
  assert.match(skill, /Persist after every `squad_run` or `squad_status` response/);
  assert.match(skill, /unfinished\s+run id or pending decision/);
  assert.match(skill, /from the current activity record/);
  assert.match(skill, /trackingStatus.*unavailable.*not-configured/s);
  assert.match(skill, /status response that does not\s+advertise that contract/);
  assert.match(skill, /explicit memory-write or maintenance tools/);
  assert.match(contract, /eTag\/conditional write/);
  assert.match(contract, /"sourceTool": "squad_run"/);
  assert.match(contract, /"entryTool": "squad_run"/);
  assert.match(contract, /Cowork never\s+pre-populates a stage plan/);
  assert.match(contract, /sourceTool: "cowork-native"/);
  assert.match(contract, /do not prove that a Git repository was\s+changed/);
});

test("Cowork separates current capability evidence from historical run failures", () => {
  const skill = executionInstructions().replace(/\s+/g, " ");
  assert.match(skill, /run-scoped historical evidence/);
  assert.match(skill, /originating run id and timestamp/);
  assert.match(skill, /Do not promote a prior run's blocker into the current run's diagnosis/);
  assert.match(skill, /content-policy rejection.*does not test skill resolution or artifact-writing capability/);
  assert.match(skill, /capability not verified by this run/);
  assert.match(skill, /Public MCP `tools\/list` describes the Cowork-facing API, not the private tools/);
  assert.match(skill, /Do not invoke these internal names as public MCP tools/);
  assert.match(skill, /Do not count runs with different failures as repeated confirmations/);
  assert.match(skill, /historical; current status unverified/);
  assert.match(skill, /does not prove that a BRD was produced/);
  assert.match(skill, /do not start diagnostic work runs, retry filtered input/);
});

test("Cowork relays human decisions without confusing local answers with gate release", () => {
  const skill = executionInstructions().replace(/\s+/g, " ");
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  ).replace(/\s+/g, " ");

  assert.ok(skill.includes("show the actual server question in Cowork"));
  assert.ok(skill.includes("Ask one focused question"));
  assert.ok(skill.includes("store the exact human response"));
  assert.ok(skill.includes("Distinguish `answered` from `submitted`"));
  assert.ok(skill.includes("keep the saved approval with submission `blocked`"));
  assert.ok(skill.includes("The current `squad_status` schema polls only"));
  assert.ok(skill.includes("do not invent a squad verdict from the source brief"));
  assert.ok(contract.includes('"status": "awaiting-human"'));
  assert.ok(contract.includes('"serverDecisionId": null'));
  assert.ok(contract.includes('"acknowledgement": null'));
  assert.ok(contract.includes("keep the answer pending and report the integration blocker"));
});

test("Cowork submits verified saved approvals through discovered operator MCP control", () => {
  const skill = executionInstructions().replace(/\s+/g, " ");
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  ).replace(/\s+/g, " ");

  const steps = [
    "**Capture and persist:**",
    "**Discover the submission action:**",
    "**Submit from the saved record:**",
    "**Check the result:**",
    "**Resume and retrieve:**",
  ];
  let previous = -1;
  for (const step of steps) {
    const position = skill.indexOf(step);
    assert.ok(position > previous, `Required ordered step: ${step}`);
    previous = position;
  }
  assert.ok(skill.includes("Save and read back the approval contract before submission"));
  assert.ok(skill.includes("Map `sourceRunId` to `runId`"));
  assert.ok(skill.includes("requires `Squad.Operate`"));
  assert.ok(skill.includes("must contain `approved: true` and the matching `runId`"));
  assert.ok(skill.includes("This plugin does not deploy the server, grant consent, or provision an external action"));
  assert.ok(skill.includes("prefer the actual `squad_approve` MCP tool"));
  assert.ok(skill.includes("only when the HTTP pipeline is enabled and the token has `Squad.Operate`"));
  assert.ok(skill.includes("admin-consented delegated `Squad.Operate`"));
  assert.ok(skill.includes("reconnect/token refresh and verified rediscovery"));
  assert.ok(skill.includes("local simple OAuth issuer cannot mint operator scope"));
  assert.ok(skill.includes('send `decision: "approve"`'));
  assert.ok(skill.includes("`runId` must be a UUID"));
  assert.ok(skill.includes("`projectId` MUST match persisted `projectContext.projectId`"));
  assert.ok(skill.includes("include it from the saved approval, never a slug"));
  assert.ok(skill.includes("server derives tenant and subject from authentication"));
  assert.ok(skill.includes("MCP `structuredContent` must contain `approved: true`"));
  assert.ok(skill.includes("Repeat same-run approval returns the original receipt without a new run or model work"));
  assert.ok(contract.includes('"sourceFileVersion": null'));
  assert.ok(contract.includes('"submittedInputs": null'));
  assert.ok(contract.includes('`{"runId": "<saved sourceRunId>"}`'));
});

test("Cowork handles unavailable, rejected, changed, and uncertain approval submissions", () => {
  const skill = executionInstructions().replace(/\s+/g, " ");

  assert.ok(skill.includes("keep the saved approval with submission `blocked`"));
  assert.ok(skill.includes("before retrying; do not blindly resubmit"));
  assert.ok(skill.includes("mark `unknown`"));
  assert.ok(skill.includes("never call an approve-only action for a rejection"));
  assert.ok(skill.includes("Reconfirm if the run, requested action, or saved decision changed"));
  assert.ok(skill.includes("An old or edited approval file alone is not new human consent"));
  assert.ok(skill.includes("Do not request secrets in chat"));
  assert.ok(skill.includes("Do not call `squad_run` again to signal approval"));
  assert.doesNotMatch(skill, /Do not call `\/admin\/approve`,/);
  assert.ok(skill.includes("Missing discovery may mean an old server, disabled pipeline, or missing permission"));
  assert.ok(skill.includes("possibly with an earlier") || skill.includes("may carry an earlier `decisionId`"));
});

test("Cowork negotiates authoritative GUID identity and persists canonical partitions", () => {
  const skill = executionInstructions().replace(/\s+/g, " ");
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.ok(skill.includes("`2` only when the live input schema advertises support for `2`"));
  assert.ok(skill.includes("otherwise retain schema `1` compatibility"));
  assert.ok(skill.includes("all are mandatory for schema `2`"));
  assert.ok(skill.includes("Never fabricate M365 ids"));
  assert.ok(skill.includes("`ack.project` is the server-resolved canonical partition"));
  assert.ok(skill.includes("new projects use `project-${uuid}`"));
  assert.ok(skill.includes("`ack.storage.provider`, `driveId`, and `folderItemId`"));
  assert.ok(skill.includes("compare UUIDs in canonical lowercase"));
  assert.ok(skill.includes("stateless folder-binding rejection is a blocker, not permission to downgrade"));
  assert.ok(skill.includes("save and read back the server-returned partition in `contextBridge.project` before any subsequent polls/history"));
  assert.ok(skill.includes("Never regenerate the existing UUID or alter storage ids to bypass a conflict"));
  assert.ok(contract.includes('unchanged `schemaVersion: 2`'));
  assert.ok(contract.includes("Renaming the same folder keeps its UUID"));
  assert.ok(contract.includes("A copied/new folder gets a new UUID"));
  assert.ok(contract.includes("Existing matching GUID/storage retains legacy history through server mapping"));
});

test("Cowork relays actual human input with matching receipt before same-run polling", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  ).replace(/\s+/g, " ");
  for (const required of [
    '`reason: "awaiting human input"`',
    "`{questionId, question, purpose, choices?, notice?}`",
    "`purpose` is `clarification` or `confirmation`",
    "Display notice and question verbatim",
    "Loading a notice is not displaying it",
    "Record `presentedAt` only after actual user-visible presentation",
    "It uses `Squad.Run`, NOT `Squad.Operate`",
    "Send `{runId, questionId, answer, projectContext?}`",
    "`sourceRunId`, server `questionId`, immutable `projectId`",
    "require `accepted: true`, matching `runId` and `questionId`",
    "`respondedAt` and `respondedBy` from the server",
    "Save the actual receipt unchanged and read it back",
    "poll the SAME run with `squad_status`",
    "Never start a replacement `squad_run` to deliver the answer",
  ]) {
    assert.ok(instructions.includes(required), `Missing human handoff safeguard: ${required}`);
  }
  for (const field of ['"questionId": null', '"notice": null', '"presentedAt": null', '"purpose": null']) {
    assert.ok(contract.includes(field));
  }
  assert.ok(contract.includes("Keep `decision` null for this handoff"));
  assert.ok(contract.includes("an answer is not an operator approval"));
});

test("Cowork discovers a lossless native question schema and invokes it for one server question", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  for (const required of [
    "MUST invoke the discovered native selectable-question tool",
    "Do not infer availability from this document",
    "`core-AskUserQuestion`",
    "`questions` (maximum 4)",
    "`question`, `header`, `options` (2-4 entries with `label` and `description`), and `multiSelect`",
    "Send exactly one question object",
    "Copy the server `question` verbatim",
    "each `label` is the exact original choice string, in original order",
    "repeat that exact choice string as `description`",
    "Display the exact `notice`/caution immediately before the native card",
    "`multiSelect: false` for a single-answer question",
    "only when the server explicitly permits multiple selections",
    "Never add fake choices",
    "A four-question capacity is not permission to batch server questions",
  ]) {
    assert.ok(instructions.includes(required), `Missing native-question mapping rule: ${required}`);
  }
});

test("Cowork permits chat fallback only for evidenced capability limits or explicit preference", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  for (const required of [
    "No native question tool discovered",
    "No choices, one choice, or more than four choices",
    "Text limits, duplicate labels, or answer encoding",
    "Native tool invocation fails or is denied",
    "Explicit user preference for chat",
    "record and display the concrete fallback reason",
    "convenience, latency, token budget, or fewer tool cards are not fallback reasons",
    '"Surface immediately"',
    "does not mean skip native choices",
    "Never split one server question into multiple cards",
    "do not truncate, paraphrase, reorder, or drop choices",
  ]) {
    assert.ok(instructions.includes(required), `Missing fallback boundary: ${required}`);
  }
});

test("Cowork checkpoints the bound hold before native presentation without draining the mirror backlog", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  const capture = instructions.indexOf("0. **Minimal bound hold capture:**");
  const present = instructions.indexOf("1. **Present:**", capture);
  const answer = instructions.indexOf("2. **Capture:**", present);
  assert.ok(capture >= 0 && present > capture && answer > present);
  for (const required of [
    "Do not enumerate history, download artifacts, or queue bulk upload cards before presenting the question",
    "Retain known pending paths and unknown inventory coverage as a mirror backlog",
    "does not finalize the activity or advance projection acknowledgments",
    "fresh manifest/decision eTags and conditional writes",
    "If safe capture fails, report the checkpoint blocker",
    "do not submit any answer until persistence and identity checks succeed",
    "An identity conflict blocks the handoff itself",
    "never reset its saved answer, presentation timestamps, or receipt",
    "Resume the retained mirror backlog after presentation/answer handling",
  ]) {
    assert.ok(instructions.includes(required), `Missing prompt-handoff ordering rule: ${required}`);
  }
  for (const reference of ["artifact-sync.md", "project-contract.md"]) {
    const text = readFileSync(
      join(root, "cowork", "skills", "hve-project-manager", "references", reference),
      "utf8",
    ).replace(/\s+/g, " ");
    assert.ok(text.includes("live `humanInput`"), `${reference} must carry the handoff exception`);
    assert.ok(text.includes("minimal bound hold capture"), `${reference} must preserve hold capture`);
    assert.ok(text.includes("bulk mirroring"), `${reference} must not gate presentation on bulk mirroring`);
  }
  assert.doesNotMatch(instructions, /response, before the next poll or human handoff/);
  assert.doesNotMatch(artifactSyncInstructions(), /Execute it before the next poll, human handoff/);
});

test("Cowork preserves native response provenance without treating UI submission as server acceptance", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  for (const required of [
    "Save the native user-answer payload unchanged in `presentation.rawResponse`",
    "Map a returned option id/index only through the exact displayed server choices",
    "do not silently join, normalize, or summarize selections",
    "A dismissed, cancelled, or empty native response is not an answer",
    "Native UI completion is not a `squad_respond` acceptance receipt",
    "Record `presentedAt` only after actual user-visible presentation",
    "Save the actual receipt unchanged and read it back",
  ]) {
    assert.ok(instructions.includes(required), `Missing native response safeguard: ${required}`);
  }
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  );
  for (const field of ['"presentation": {', '"mode": null', '"tool": null', '"fallbackReason": null', '"rawResponse": null']) {
    assert.ok(contract.includes(field), `Missing presentation provenance field: ${field}`);
  }
});

test("Cowork blocks missing/stale/uncertain handoffs without invented consent or gate bypass", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  for (const required of [
    "If notice/question/identity changed",
    "answered record without that receipt remains pending/unknown",
    "only for the same questionId and with its actual matching acceptance receipt",
    "A new question id needs a new explicit answer",
    "retain the answer with submission `blocked`",
    "record `unknown` and reconcile the same run",
    "Do not blindly resubmit",
    "Do not invent answers",
    "auto-sign off phases",
    "Operator `squad_approve` cannot answer human questions",
    "Never execute project code or deploy natively",
    "does not prove all provider integrations exist",
  ]) {
    assert.ok(instructions.includes(required), `Missing negative-case safeguard: ${required}`);
  }
});

test("Cowork distinguishes queued runs, same-run recovery, and new server-directed handoffs", () => {
  const skill = executionInstructions().replace(/\s+/g, " ");

  for (const reason of ["queued", "queued_for_worker", "run_already_in_flight"]) {
    assert.ok(skill.includes(`\`${reason}\``));
  }
  assert.ok(skill.includes("Limit to three polls per managed turn"));
  assert.ok(skill.includes("both `project` and the current `projectContext` checkpoint"));
  assert.ok(skill.includes("its current revision and the new activity sequence"));
  assert.ok(skill.includes("If the server directs a new orchestrator turn and the user authorizes it"));
  assert.ok(skill.includes("This is a new handoff, not a retry of an unfinished run"));
  assert.ok(skill.includes("Do not start a new run when the server only asked for operator approval"));
});

test("Cowork retrieves complete server files without flattening paths or inventing provenance", () => {
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  ).replace(/\s+/g, " ");

  assert.ok(contract.includes('`op: "index"`'));
  assert.ok(contract.includes('`op: "list"`'));
  assert.ok(contract.includes('`op: "read"` only for validated returned paths'));
  assert.ok(contract.includes("exact accepted `contextBridge.project`"));
  assert.ok(contract.includes("`<project>/.copilot-tracking/docs/brd.md`, not `deliverables/brd.md`"));
  assert.ok(contract.includes("Preserve folder nesting, filenames, extensions, and content exactly"));
  assert.ok(contract.includes("project-wide, not run-filtered"));
  assert.ok(contract.includes("Reject truncated content as a complete artifact"));
  assert.ok(contract.includes("64,000 characters"));
  assert.ok(contract.includes("500 entries"));
  assert.ok(contract.includes("Never invent offset/cursor parameters"));
  assert.ok(contract.includes("History calls do not advance bridge acknowledgments"));
});

test("Cowork package validation rejects loss or substitution of the output retrieval contract", () => {
  const fixture = mkdtempSync(join(root, ".cowork-output-contract-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    assert.deepEqual(validateSkillPackage(fixture, manifest), []);
    for (const replacement of ["", "output-read-tool: squad_memory_write"]) {
      writeFileSync(
        skillPath,
        original.replace("output-read-tool: squad_history", replacement),
        "utf8",
      );
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.output-read-tool=squad_history"),
      ));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork validation and packer require approval control-plane metadata", () => {
  const fixture = mkdtempSync(join(root, ".cowork-approval-contract-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    for (const replacement of ["", "approval-tool: squad_run"]) {
      writeFileSync(skillPath, original.replace("approval-tool: squad_approve", replacement), "utf8");
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.approval-tool=squad_approve"),
      ));
    }
    const packer = readFileSync(join(root, "cowork", "pack.ps1"), "utf8");
    assert.ok(packer.includes("'approval control' = '(?m)^\\s+approval-tool:\\s+squad_approve\\s*$'"));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork defers collaborative decisions without answering and verifies authorized same-run return", () => {
  const instructions = executionInstructions().replace(/\s+/g, " ");
  const contract = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "references", "project-contract.md"),
    "utf8",
  ).replace(/\s+/g, " ");
  for (const required of [
    "server is already durably held until an explicit response",
    "No public deferral action is needed",
    'decision `status: "awaiting-input"` and `collaboration.status: "deferred"`',
    "keep `answer` and `answeredAt` null",
    "do not mark the decision failed, cancelled, or answered",
    "Stop polling and model work",
    'Never submit "I don\'t know", "ask later", an empty answer, or a placeholder',
    "explicitly confirms it is the completed requested decision",
    "Do not require the original user to answer",
    "Existing tenant/project authorization still applies",
    "Call same-run `squad_status` to verify",
    "exact questionId and content plus project binding",
    "Record the decision author separately from the authenticated submitter",
    "Do not claim the server verified stakeholder authority",
    "Never promise indefinite resumption",
    "top-level `expiresAt`, it is epoch milliseconds",
    "save its exact value in `collaboration.runExpiresAt`",
    "Do not interpret it as epoch seconds",
    "No replacement run without explicit user choice",
  ]) {
    assert.ok(instructions.includes(required), `Missing collaborative safeguard: ${required}`);
  }
  assert.ok(contract.includes('"decisionAuthor": null'));
  assert.ok(contract.includes('"deferredAt": null'));
  assert.ok(contract.includes('"runExpiresAt": null'));
  assert.ok(contract.includes('`status: "awaiting-input"`'));
  assert.ok(contract.includes('"authorityVerified": false'));
});

test("Cowork validator and packer reject loss or substitution of the human response contract", () => {
  const fixture = mkdtempSync(join(root, ".cowork-human-response-contract-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    for (const replacement of ["", "human-response-tool: squad_approve"]) {
      writeFileSync(skillPath, original.replace("human-response-tool: squad_respond", replacement), "utf8");
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes("metadata.human-response-tool=squad_respond"),
      ));
    }
    const packer = readFileSync(join(root, "cowork", "pack.ps1"), "utf8");
    assert.ok(packer.includes("'human response control' = '(?m)^\\s+human-response-tool:\\s+squad_respond\\s*$'"));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork main skill fits the upload limit and requires its companion protocols", () => {
  const skill = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "SKILL.md"),
    "utf8",
  );
  assert.ok(skill.length <= 20_000, `SKILL.md contains ${skill.length} characters`);
  assert.match(skill, /Before any run or poll, read and follow\s+\[references\/execution-protocol\.md\]/);
  assert.match(skill, /If either reference cannot be read, checkpoint the blocker and do not proceed/);
  assert.match(skill, /\[references\/project-contract\.md\]\(references\/project-contract\.md\)/);

  const fixture = mkdtempSync(join(root, ".cowork-required-references-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    for (const reference of ["project-contract.md", "execution-protocol.md", "artifact-sync.md", "stakeholder-library.md", "context-preflight.md"]) {
      const path = join(fixture, "skills", "hve-project-manager", "references", reference);
      const original = readFileSync(path, "utf8");
      rmSync(path);
      assert.ok(validateSkillPackage(fixture, manifest).some(
        (problem) => problem.includes(`missing references/${reference}`),
      ));
      writeFileSync(path, original, "utf8");
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork skill character validation accepts the limit and rejects one character over", () => {
  const fixture = mkdtempSync(join(root, ".cowork-skill-size-"));
  try {
    cpSync(join(root, "cowork", "skills"), join(fixture, "skills"), { recursive: true });
    const skillPath = join(fixture, "skills", "hve-project-manager", "SKILL.md");
    const original = readFileSync(skillPath, "utf8");
    assert.ok(original.length < 20_000);
    for (const length of [19_999, 20_000, 20_001, 28_117]) {
      writeFileSync(skillPath, original.padEnd(length, "x"), "utf8");
      const problems = validateSkillPackage(fixture, manifest);
      if (length <= 20_000) {
        assert.deepEqual(problems, []);
      } else {
        assert.deepEqual(problems, [
          `Agent Skill ./skills/hve-project-manager/SKILL.md contains ${length} characters; maximum is 20000.`,
        ]);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Cowork validation rejects pinned tool metadata and duplicate skills", () => {
  const pinned = clone(manifest);
  const remote = pinned.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.ok(remote);
  remote.mcpToolDescription = { file: "tools/hve-squad-tools.json" };
  pinned.agentSkills = [
    { folder: "./skills/hve-project-manager" },
    { folder: "./skills/hve-project-manager" },
  ];

  const problems = validateManifest(pinned);
  assert.ok(problems.some((problem) => problem.includes("omit mcpToolDescription")));
  assert.ok(problems.some((problem) => problem.includes("Duplicate Agent Skill folder")));
});

test("Cowork distinguishes the Entra resource URI from the HTTPS MCP endpoint", () => {
  const configured = clone(manifest);
  const remote = configured.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.ok(remote);
  remote.mcpServerUrl = "https://example.azurecontainerapps.io/mcp";
  remote.authorization = { type: "OAuthPluginVault", referenceId: "test-entra-registration" };
  assert.deepEqual(validateManifest(configured), []);
  remote.mcpServerUrl = "api://auth-registration/resource-client-id";
  assert.ok(validateManifest(configured).some((problem) => problem.includes("HTTPS /mcp URL")));
});

test("Cowork validation requires the project-manager skill", () => {
  const noProjectManager = clone(manifest);
  noProjectManager.agentSkills = [];

  const problems = validateManifest(noProjectManager);
  assert.ok(problems.some((problem) => problem.includes("At least one agentSkill")));
  assert.ok(problems.some((problem) => problem.includes("./skills/hve-project-manager")));
});

test("Cowork validation rejects a declared skill with no SKILL.md", () => {
  const missingSkill = clone(manifest);
  missingSkill.agentSkills = [{ folder: "./skills/missing-skill" }];

  const problems = validateSkillPackage(join(root, "cowork"), missingSkill);
  assert.ok(problems.some((problem) => problem.includes("missing SKILL.md")));
});

test("Cowork validation rejects manifest versions before dynamic agent connectors", () => {
  const legacy = clone(manifest);
  legacy.manifestVersion = "1.28";
  legacy.$schema =
    "https://developer.microsoft.com/json-schemas/teams/v1.28/MicrosoftTeams.schema.json";

  const problems = validateManifest(legacy);
  assert.ok(problems.some((problem) => problem.includes("requires manifestVersion 1.29")));
  assert.ok(problems.some((problem) => problem.includes("must target the Teams 1.29 schema")));
});
