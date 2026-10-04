<!-- markdownlint-disable-file -->
# Bundled advisory cast snapshot

This directory contains the immutable, public-source Markdown authority for the
embedded advisory Squad. `host/snapshot-cast.ts` resolves the unchanged
`package-pin.json` release, reads its `apm.yml`, and fetches each selected file
from a full commit SHA. No local upstream checkout or `apm install` is required.
Do not hand-edit files under `.github/`.

## Coverage and layout

The current pin declares 85 agent files, 84 skill trees, and 78 instruction
sources. All are represented:

- `.github/agents/**` retains the existing 85 persona files and their deployment
  paths, unchanged. Squad-owned charters remain under `agents/squad/`; upstream
  personas remain flat. No duplicate agent copies are added.
- `.github/skills/**` contains all 84 declared skill Markdown trees, including
  their Markdown references, templates, examples, and security guidance.
  Native categories are retained, rather than flattening every skill directory.
  There are 781 skill files including licenses/notices and 70 declarative assets.
- `.github/instructions/**` contains every declared instruction source. There
  are 79 instruction files because the boundary instruction retains its existing
  runtime probe path and also appears at its native `instructions/shared/` path.
- `manifest.json` records exact source paths, immutable commits, normalized
  SHA-256 hashes, skill names and directories, excluded non-Markdown files, and
  unresolved static reference candidates.
- Declarative `.json`, `.yaml`, `.yml`, `.txt`, and `.csv` resources retain their
  native paths and carry `kind: "data"` in the manifest. These are read-only
  **DATA, never instruction authority or executable code**. Schemas, workflow/
  provisioning templates, and package manifests remain inert even when their
  upstream paths contain `scripts/`. The snapshot does not evaluate them.
- `coverage-inventory.json` is a separate read-only full-cast audit: it maps
  declared tools, skill/instruction dependencies, delegations, advisory scope,
  and reference-resolution diagnostics. It is not an execution permission grant.

Important named-skill paths, relative to `.github/`:

| Skill | Directory |
|---|---|
| rpi-research | `skills/rpi/rpi-research/` |
| rpi-plan | `skills/rpi/rpi-plan/` |
| rpi-plan-critique | `skills/rpi/rpi-plan-critique/` |
| rpi-review | `skills/rpi/rpi-review/` |
| requirements-author | `skills/project-planning/requirements-author/` |
| squad | `skills/squad/` |
| azure-pricing | `skills/azure-pricing/` |

Each has `SKILL.md`. The complete mapping is `manifest.json.skills`. The
container copies the tree to `/app/.github`; runtime named-skill discovery must
support nested paths rather than assume `skills/<name>/SKILL.md`.

## Advisory-only boundary

**No skill family is excluded at the Markdown-contract level.** Even contracts
describing implementation or deployment are available as reference prose.
Loading those documents does **not** enable their operations.

The target supports advisory research, planning, critique/review, business
documents, scoped project artifacts/session state, and controlled delegation.
Code, shell, terminal, notebook, test, build, installation, skill-script
execution, deployment, provisioning, and pipeline execution are unavailable.
Neither delegation nor an approval may bypass those exclusions.

The snapshot omits 379 execution-related files and 287 other unsupported
assets. Exact immutable source paths and reasons appear in
`manifest.json.excludedFiles`. Omitted resources include scripts, executable
test fixtures, binaries, render assets, images, PDFs, and non-allowlisted
infrastructure/environment/lockfile formats. Declarative assets inside declared
skill trees are bundled; out-of-tree resources are not silently imported.
These may prevent a particular charter step from completing. A prose-only
artifact must not be represented as completed execution, validation, rendering,
or deployment.

## Reference completeness and known upstream gaps

Every selected Markdown and declarative file inside each declared skill tree is
included verbatim apart from LF normalization. Static Markdown links/path tokens
and declarative local `$ref` checking records 232 candidates
that do not resolve directly inside the selected bundle:

- 41 missing relative Markdown paths;
- 61 paths outside the bundle boundary, including repository documentation,
  runtime evidence, non-Markdown resources, and examples;
- 130 non-Markdown resource references (including deliberately excluded scripts).

These are **candidates**, not 232 independently confirmed missing mandatory
dependencies. Some prose describes paths relative to another named skill;
some references name hypothetical artifacts; some link to personas whose
existing deployment layout is intentionally flattened. The coverage inventory
adds pinned source-existence checks, canonical bundled paths where known, and
candidate resource paths. Do not automatically guess an ambiguous replacement.

Confirmed missing documents at the pinned upstream commit:

- `skills/gdpr-compliant/SKILL.md` requires `references/operations.md` and
  `references/security.md`, neither of which exists at its pinned source.
  Those deep-dive requests must report the missing source, not invent content.
- Accessibility reference links still name former
  `wcag-22/references/guideline-2-1.md` and `guideline-2-2.md` locations absent
  from the selected skill tree.

Cross-skill examples include `backlog-templates` naming caller-specific handoffs
from `rai-planner` and `accessibility`; those documents are bundled under their
own skills. Several instructions similarly name references belonging to
`adr-author`, `security-planning`, `supply-chain-security`, `vex`, or `squad`.
Use the named owning skill and an explicit resource path.

Repository documentation outside the declared skill/instruction trees is not
silently pulled into the bundle. Examples include accessibility real-screen-reader
runbooks, repository security-model documentation, and contributor/governance
documents. Such steps remain incomplete unless the host separately retrieves
the pinned document. No runtime path escape is authorized by a source link.

## Phase contracts

Research uses the bundled template body without its source YAML frontmatter,
beginning with `<!-- markdownlint-disable-file -->`. Every completed executed
cycle contains Wider, Deeper, then Contrarian, with reflections, parent synthesis,
and a re-entry decision. **Every wave may run inline**; three worker dispatches
are not mandatory. Completed executed cycles may not omit a wave.
`RPI Researcher` is the default when an independent lane is delegated.

The **Squad Researcher charter is stricter than the skill alone**: its declared
`agents: [RPI Researcher]` and required steps demand bounded lane decomposition
and an actual `RPI Researcher` dispatch once per lane, after creating the primary
artifact. An entirely inline Squad Researcher stage does not fulfill that role
contract. This does not require a dispatch per wave or exactly three workers.
The charter and skill show different default lane-directory ordering; pass an
explicit parent-approved scoped lane artifact path rather than guessing.

Planning owns separate dated plan and phase-details artifacts. Before
finalization it dispatches **one fresh generic critique worker** activating
`rpi-plan-critique`; no named critique agent is prescribed, and Squad Lead has
no `agents:` frontmatter declaration. `RPI Planner` is a separate bounded
planning worker, not the required critique identity. The critic writes only
its designated artifact and returns severity-graded `PC-xxx` findings, execution
status, and verdict. The planning parent disposes findings and finalizes without
a second critique.

Review writes one dated review record, compares available research/plan/details/
critique/changes evidence, and emits severity-graded `RV-xxx` findings with
destinations. Execution status and outcome are distinct. Missing implementation
or validation evidence must be reported unavailable or blocking.

BRD Builder loads `requirements-author` Discover/Define/Govern sections, writes
`docs/project-planning/<name>-brd.md` together with
`.copilot-tracking/brd-sessions/<name>.state.json`, and preserves canonical
template frontmatter. It displays the shared BRD caution before phase work.
BRD Quality Reviewer remains read-only and returns both YAML payloads,
`BRD_STANDARD_FINDINGS_V1` and `BRD_QUALITY_REPORT_V1`, for its parent to persist.
Govern requires genuine approval, lineage, and quality-gate evidence. Cowork
cannot run charter-required markdownlint; it must report that limitation or
cite separately supplied validation evidence.

## Licenses and provenance

All selected source bytes, license declarations, and attribution blocks are
preserved, except CRLF-to-LF normalization. Skill-local license/notice files are
included; each skill also receives available repository-root notices under
`UPSTREAM-LICENSE`, `UPSTREAM-NOTICE`, or `UPSTREAM-THIRD-PARTY-NOTICES`.
Root MIT text does not override more specific CC BY, CC BY-SA, or third-party
terms in a file.

For example, Microsoft / microsoft/hve-core's `requirements-author` declares
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It comes unchanged from
[this pinned source](https://github.com/microsoft/hve-core/tree/b1cae5059b6efedb406eef070d2981c201a5baed/.github/skills/project-planning/requirements-author).
Source commits for this snapshot:

- `Peter-N91/hve-squad`: `d7ce950be355c215c210f52d41b1948265f796b3`
- `microsoft/hve-core`: `b1cae5059b6efedb406eef070d2981c201a5baed`
- `github/awesome-copilot`: `9db369d00f121542e1c99fd9b6cd6f707bade765`

## Regeneration and validation

```pwsh
npm run snapshot:cast
npm run snapshot:cast:check
node --import tsx --test test\cast-bundle.test.ts
```

Generation uses commit-pinned tree listings and raw files, bounded concurrent
fetches, and cached shared notices. It rejects truncated listings, selected-file
symlinks, unsafe source paths, destination collisions, mixed upstream commits,
and missing skill entrypoints. It neither installs nor executes skill content.
`GITHUB_TOKEN` / `GH_TOKEN` is optional for the public source API.

Offline tests verify hashes, provenance, native paths, all 84 entrypoints,
license preservation, DATA tagging/extension boundaries, omission records, and
exact reference-issue inventory.
Deleting a bundled dependency or adding an undeclared reference changes that
inventory and fails validation. The online check re-resolves the immutable pin
and compares the entire bundle/manifest without writes; `generatedAt` is excluded
from drift comparison.

## Remaining runtime integration coverage

Bundling all contracts does not establish runtime capability parity. The
inventory records 170 upstream tool names across `ado`, `github`, `read`,
`search`, `execute`, `edit`, `web`, `agent`, `microsoft-docs`, and `vscode`.
Execution/deployment tools are unavailable; other names still require scoped
advisory adapters. External provider mutations are not implied by artifact
support and cannot indirectly trigger excluded execution.

Thirty personas declare 79 distinct delegation/handoff targets. Eleven lack an
exact bundled name: ten external cast targets (Power Platform Expert, Power
Platform MCP Integration Expert, Declarative Agents Architect, MCP M365 Agent
Expert, QA, GitHub Actions Expert, aws-principal-architect, aws-cloud-expert,
aws-serverless-architect, AWS Incident Triage), plus System Architecture
Reviewer's `ADR Creation` handoff, which needs explicit alias verification
against bundled `ADR Creator`. No charter is rewritten to hide these gaps.
