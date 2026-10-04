# HVE Squad project-management plugin for Microsoft Copilot Cowork

This Cowork plugin combines one project-management Agent Skill with the remote
HVE Squad MCP connector. The skill manages a user-selected OneDrive or
SharePoint project folder and relays work to the server-owned Squad Coordinator.
Cowork discovers the server's enabled tools at runtime, but project work always
starts through `squad_run`.

The package deliberately contains:

- one `agentConnectors` entry;
- one `agentSkills` entry for `hve-project-manager`;
- no pinned `mcpToolDescription`.

With app manifest v1.29, Cowork connects to the server, sends `initialize`, and
calls `tools/list`. Tool additions, removals, descriptions, schemas, and safety
annotations therefore come from the deployed server rather than a copied file in
the plugin.

## Before-model context preflight

Plugin 11.0.20 / skill 1.21 selects a versioned, task-only context packet before
starting new HVE work. It keeps business facts, accepted decisions, constraints,
open questions and relevant source references; diagnostic journals, old prompts
and unrelated history stay in the project rather than being copied into each
model request. Selection is recorded without excluded bodies or secrets.

The backend must also be updated: it enforces packet validation and pre-model
checks, including later tool results and resumed turns. A blocked call is not
sent to the provider and returns a safe, explicit preflight receipt. This is not
a keyword-removal workaround and does not certify future provider acceptance.
The plugin cannot intercept the Cowork host's own internal model calls; it
controls the payload handed to HVE. See
[context preflight](skills/hve-project-manager/references/context-preflight.md).

## Responsible-AI blocks

A provider content-policy rejection is a visible terminal blocker, not a hidden
failure or an approval gate. Updated servers return
`reason: "model_backend_content_policy"` and a safe `responsibleAi` receipt in
status/results. The project manager explains supplied stage/correlation/filter
metadata, explicitly labels unknown details, preserves existing work and human
responses, and offers review/correction, stop, or false-positive escalation.
Neither acknowledgment nor plugin consent bypasses the provider. No automatic
unchanged retry, filter weakening, model evasion or false completion is allowed.
The failed run is not resumable; any corrected new work needs explicit user
authorization. See the terminal Responsible-AI contract in
`skills/hve-project-manager/references/execution-protocol.md`.

Backend deployment and plugin installation are separate. Updated backend text
and structured receipts are immediately available from the server, while the
durable Cowork project-management instructions require installing the updated
plugin package. Neither update backfills missing diagnostics in historical runs.

## Why this shape

The previous package projected the squad into one dispatcher skill plus ten stage
skills and pinned a generated tool-description file. That introduced two sources
of routing truth and required repackaging whenever the MCP surface changed.

The current package separates two kinds of authority:

1. The project-manager skill owns the stable project lifecycle: create or open a
   folder, load its checkpoint and `.copilot-tracking` projection, negotiate its
   identity/revision with the server, relay one request to `squad_run`, save the
   returned artifacts, materialize tracking deltas, and commit the next checkpoint.
2. The operator enables server features.
3. The server exposes enabled tools authorized for the caller through `tools/list`.
4. Cowork validates and activates the discovered definitions.
5. Tool names, descriptions, schemas, and annotations remain server-owned, so
   tool changes do not require regenerating the skill.

The project manager is deliberately not an orchestrator. `squad_run` is its only
work-producing HVE call; `squad_status` is allowed only to poll or recover a run
that `squad_run` already started. Read-only `squad_history` retrieves the
orchestrator's outputs in the accepted project. Discovered `squad_approve` is
an operator-authorized control-plane exception, not new work. `squad_respond`
is a separate same-run answer handoff authorized by `Squad.Run`.
The skill never chooses specialist tools,
workers, roles, profiles, stages, stage order, council members, or parallelism.
If `squad_run` is unavailable, the turn blocks rather than falling back to a
direct research, planning, architecture, review, business, federation, memory,
or rendering tool.

Original outputs are saved faithfully and separately from Cowork summaries or
native transformations. Every orchestrator or status response and accepted
tracking delta is persisted and verified before the project checkpoint advances.
The project manager discovers persisted same-run files through read-only history
even for queued/running/held/failed runs, retrieves their full exact content,
mirrors HVE's actual storage structure at exact canonical paths, and
presents the squad's decisions to
the human in Cowork. It records answers and coordinates supported continuation;
it does not write server memory or invent an approval API.

This does not reproduce the Copilot Studio parent/child-agent topology in
Cowork. It gives Cowork one repository bridge while the MCP server remains the
single orchestration authority.

## Layout

```text
cowork/
|-- manifest.json   # M365 app manifest v1.29; dynamic remote MCP connector
|-- color.png       # 192x192 icon
|-- outline.png     # 32x32 icon
|-- pack.ps1        # substitutes tenant values and writes the uploadable zip
|-- skills/
|   `-- hve-project-manager/
|       |-- SKILL.md
|       `-- references/
|           |-- project-contract.md
|           |-- execution-protocol.md
|           |-- artifact-sync.md
|           |-- context-preflight.md
|           `-- stakeholder-library.md
|-- README.md
`-- SETUP.md         # Entra and Enterprise Token Store configuration
```

## Build and package

Validate the dynamic connector contract:

```powershell
npm run generate:cowork
```

Package it with real deployment values:

```powershell
pwsh -File cowork/pack.ps1 `
  -Fqdn "<your-app>.<region>.azurecontainerapps.io" `
  -OAuthReferenceId "<auth-config-id>"
```

Or run the package script after substituting the placeholders in
`cowork/manifest.json`:

```powershell
npm run package:cowork
```

The result is `cowork/build/hve-squad-cowork.zip`. Upload it in Cowork under
**Customize > Plugins > Upload plugin**.

Complete the Entra and token-store configuration in [SETUP.md](SETUP.md) before
testing.

## Verify dynamic discovery

### Phase 0: connection and discovery

Start a new Cowork conversation with the plugin enabled and ask:

```text
Use HVE Squad to research the Model Context Protocol. Return three sentences.
```

A pass requires:

- the server logs an MCP `initialize`;
- the server receives `tools/list`;
- Cowork invokes `squad_run`, never `squad_research`;
- Cowork records the returned run id and uses `squad_status` if the run is
  asynchronous;
- the server-selected research output is persisted without Cowork composing a
  second stage call.

If Cowork reports no tools, check the endpoint, OAuth reference, audience, tenant,
scopes, and the server's `tools/list` response.

### Phase 1: create and resume a project

Start a new Cowork session and ask:

```text
Use HVE Squad to create a project named Cowork Smoke Test in a folder I choose.
Research a small topic, save the artifact, and checkpoint the next action.
```

A pass requires:

- the `hve-project-manager` skill appears in the session side panel;
- Cowork asks you to select OneDrive or SharePoint and confirm file creation;
- the selected folder contains `hve-project.json`, `state.md`,
  `next-actions.md`, `.copilot-tracking/squad/`, an `activity/` record, and the
  research artifact;
- the tool result acknowledges the same project id/revision through
  `structuredContent.contextBridge`;
- the final response reports the project revision, activity sequence, run id,
  files written, and next action.

Start another Cowork session, select the same folder, and ask:

```text
Resume this HVE project and plan the next action using its saved research.
```

The second run passes only if it reads the existing checkpoint, passes the
research forward as context, creates a plan artifact, and increments the
manifest revision without overwriting the first activity record.

### Phase 2: prove the orchestration boundary

1. Start a new Cowork session in which `tools/list` advertises `squad_run` and
   one or more direct specialist tools.
2. Ask for research, then planning, then a multi-domain advisory outcome in
   separate managed turns.
3. Confirm each new work request invokes `squad_run`; only an existing run may
   invoke `squad_status`, and only an accepted project may use `squad_history`
   to retrieve existing output.
4. Confirm no direct specialist tool is invoked and the activity record does not
   contain a Cowork-authored stage plan or tool-selection rationale.
5. Test with `squad_run` unavailable to the signed-in user and confirm the skill
   checkpoints a blocked turn instead of substituting another advertised tool.

The plugin passes only if discovery still reads the live schema while all work
crosses the one orchestrator boundary.

### Upgrade and recover inconsistent discovery

Version **11.0.18**, skill **1.19**, adds a portable stakeholder project library
with a Start here dashboard, deliverables, pending decisions and next steps.
It preserves original artifact paths and distinguishes review drafts from
accepted work. See [Stakeholder project library](#stakeholder-project-library).
It retains discovered native selectable questions
for live human input whenever the actual schema is lossless. It captures the bound
hold promptly, then presents the exact caution/question/choices before bulk
artifact mirroring. Chat fallback requires a concrete capability limitation or
explicit user preference; "surface immediately" does not waive native choices.
Pending mirrors and projection acknowledgments remain truthful.
It retains the canonical-only artifact synchronization
phase after every run/status response. It discovers persisted intermediate
files even when projection omits them, retrieves complete version-consistent
content (including advertised pages/host spills), and refreshes the canonical
mirror by source hashes without overwriting divergent user edits. It creates
artifact parents only on demand from persisted server paths, not a generic
scaffold or duplicate category tree. It also separates
current failures from historical
capability reports. Prior-run blocker prose and public MCP discovery are not
proof of missing internal server skills or artifact tools. Current summaries
must identify their evidence and label unverified carry-forward blockers as
historical. This retains collaborative deferral and the same-run human handoff
with the existing Entra SSO registration.
It retains the app and connector identities, MCP endpoint, GUID-bound projects,
and discovered MCP approval, keeping `SKILL.md` within Cowork's
20,000-character limit. Detailed bridge, recovery,
and persistence instructions are in the required
[execution protocol](skills/hve-project-manager/references/execution-protocol.md).
Both the package validator and PowerShell packer reject oversized skills and
missing required references.

If Cowork reports **Connector not found**, upload this newer package, complete
the connection/consent flow, and verify discovery in a new Cowork task. A new
package alone does not prove the connection is restored. Reopen the existing
project and resume its saved run with the current checkpoint; do not recreate the
SharePoint/OneDrive folder, reset revisions, or start a replacement run.

The skill explicitly teaches Cowork to save
and verify a human approval contract, prefer discovered `squad_approve`,
submit from the saved record, verify acknowledgment, and resume the same run.
Orchestrator-first routing, faithful file retrieval, and current checkpoints
remain unchanged.
Preserve the existing
manifest app id, connector id, endpoint, and OAuth reference when packaging an
upgrade. Use the existing packer with `-OutputPath` to keep the previous ZIP.

A `Tool not found` error after approval is not proof that a feature is disabled.
Check the exact invocation error, live authorized discovery, feature flags, and
configured/granted scopes separately. Do not infer that all missing tools mean
an expired session either.

In the observed Cowork environment, **Disconnect** did nothing; the operator's
recovery procedure is to upload a newer plugin package. Do not repeatedly
click Disconnect or claim a successful reconnection from a click alone.
Upload the newer ZIP through Cowork's plugin upload/upgrade flow, retain the
existing app identity, and complete any required consent. Then start a new
task, verify fresh discovery, and make one small approved invocation of the
previously missing capability. A passing package check does not establish that
the live connector registry has refreshed.

Resume an existing project only after reading its manifest, activity journal,
saved outputs, and tracking projection. Recover known runs rather than repeat
completed work. Upgrading the plugin must not recreate or overwrite the project.

### Phase 3: decisions, retrieval, and continuation

Verify these scenarios in Cowork; package tests check instruction contracts, not
live model compliance:

| Server response | Expected Cowork behavior |
| --- | --- |
| `held` with reason `queued`, `queued_for_worker`, or `run_already_in_flight` | Persist run id and poll the same run, at most three times per turn; do not manufacture a human approval requirement from the generic heading. |
| `held`, reason `awaiting human input`, and `humanInput` | Save/read back a minimal bound hold, then invoke the discovered lossless native question tool with exact notice/question/choices, one server question at a time. Keep bulk mirrors pending. Save the exact answer, submit with `squad_respond`, verify the same-run/question receipt, then poll that run. |
| "Surface immediately" / avoid more artifact cards | Present the native question promptly after minimal hold capture; do not substitute prose or wait for bulk mirroring. |
| Actual native schema cannot represent the question, or user explicitly prefers chat | Display and journal the concrete reason, then show exact notice/question/choices in chat. Do not add fake choices, trim options, or use convenience as a fallback reason. |
| Missing answer action or uncertain answer receipt | Retain the saved answer as blocked/unknown and reconcile; no invented answer, phase signoff, operator-approval substitution, or replacement run. |
| User needs time or collaborators | Save the shared pending record as awaiting-input/deferred, not answered/failed/cancelled; stop polling/work. Resume later with an authorized collaborator, current same-run question verification, actual completed answer, and matching receipt. |
| Explicit approval with discovered `squad_approve` | Save/read back the approval contract, submit its run UUID, `decision: "approve"`, project UUID, and optional decision UUID; verify the same-run receipt, then poll that run. |
| Operator approval required, with no authorized approval tool/action | Save and verify the choice, mark submission blocked, and report old-server/disabled-pipeline/missing-permission possibilities without guessing the cause. Chat consent alone never releases the gate. |
| Rejection or ambiguous submission outcome | Never send a rejection to an approve-only action; reconcile uncertain submissions by status/receipt before retrying. |
| A BRD under a canonical run's `brd/` subtree | Mirror it at that exact path, even beneath `plans/`; link it from the index using verified provenance, without moving/copying it to a separate deliverables category. Never call an ordinary plan a BRD. |
| Queued/running/held/failed result or omitted stages | Discover persisted same-run files through read-only history; mirror full available versions as partial/unaccepted, without inventing stage success or finalizing active activities. |
| Truncated tracking or history output | Reconcile through read-only listing/full reads and advertised paging/spills; keep unproven coverage pending and bridge acknowledgments unchanged. |
| Resume after a checkpoint commit | Poll the original run with the current project revision and activity sequence; do not restart work or resend a stale bridge. |
| Completed step directs a new orchestrator turn | After persistence and user authorization, pass outputs and confirmed answers to a new `squad_run`, linking the previous run. |

### Bounded synchronization across Cowork turns

When Cowork reports an interaction-size limit, identify whether it applies to a
tool result, a write/script call's input, or accumulated conversation context.
These are separate constraints; this plugin does not assume a numeric Cowork
limit. The HVE history reader's own 64,000-character cap is not a host guarantee,
and an offset-only schema does not support an invented smaller-page parameter.

Discover native exact-file/resource transfer handles first. A connector available
to Cowork may be unavailable inside workspace scripting; do not assume scripts
can call HVE or require credentials to make them do so. When no supported direct
transfer exists, retrieve bounded `squad_history` pages through the actual tool,
stage each page immediately using authorized file capabilities, verify its bytes,
and checkpoint before the next page. Use smaller exact destination chunks when
needed, but never reconstruct a clipped source response. Hash/assembly helpers
must operate on verified staged bytes rather than receive the entire backlog as
a large argument. No new source export API is required by this workflow.

The [artifact-sync protocol](skills/hve-project-manager/references/artifact-sync.md)
defines a shared-project `activity/sync/<syncId>/` recovery ledger, per-file
version/hash/cursor and staged-chunk receipts, conditional refresh and full-hash
verification before canonical publication. Bound batches by payload and calls,
not merely file count. Checkpoint before context exhaustion and use metadata-only
handoffs between turns or user-authorized sessions. Never pass the remaining
project bodies through one conversation. If a source result, exact assembly,
hashing or safe upload remains unsupported, preserve partial staging and report
that concrete blocker without claiming a complete mirror.

Local workspace chunks may disappear with a fresh Cowork task. Durable
cross-session recovery requires BOTH staged bytes (or a verified complete file)
and the cursor/ledger saved and read back in the authorized shared M365 project.
A ledger pointing at temporary local paths is not a resumable transfer. Keep
staging separate from canonical artifacts; never register partial chunks as
final deliverables. Multi-page survival remains unproven until an actual
interrupted/resumed transfer and its final hash have been verified.

Resume prompt:

> Resume artifact synchronization only for the existing project and run identified
> by its saved syncRecovery ledger. Reload the verified binding and pending queue,
> transfer a small bounded batch from the last committed per-file cursor, verify
> page and complete-file hashes, and checkpoint metadata before ending this turn.
> Preserve pending decisions and user edits. Do not start HVE work or release gates.
> Report verified mirrors separately from pending files/pages and unknown coverage.

The practical workaround is bounded retrieval, immediate verified persistence
and durable continuation, not a larger prompt. It does not retroactively explain
a failed HVE run or cure a separate Cowork model-session outage. Inventories,
completed folder creation and partial copies never establish a successful sync.

Observed recovery probe: the deployed history reader exposed only `offset`, not
`limit`, `pageSize` or `length`. Its source pages are server-sized. Native
`core-RunScript`/`aether_tools` discovery did not expose `hve-squad`; a direct
history call reported `squad_history not exposed`. A 1,486-byte JSON staging and
assembly passed its expected SHA-256 check. This is single-file evidence, not
proof of multi-page/cross-session assembly or a numeric Cowork hard limit.
The documented fallback uses the actual Cowork history tool and separate native
staging; it does not require an unavailable direct script bridge. Recheck live
schemas and capabilities rather than treating this historical probe as authority.

Native delegated retrieval is another capability-gated option, distinct from
script connector access. If discovery confirms separate retrieval context and
the required HVE/file tools, assign bounded disjoint files, stage exact bytes,
and return metadata only. The parent independently verifies staged bytes and
commits shared control records/canonical promotion. Do not guess a delegation
tool name, treat progress labels as proof, or confuse a task-shared workspace
with durable shared M365 storage. Fall back to bounded serial pages when the
capability is unavailable. This coordinates file transport, never HVE workers,
new runs, decisions or approvals.

The subsequent live recovery verified this route for **30 unique one-page
artifacts totaling 341,853 bytes**, with independent local-file and destination
read-back hash/byte checks. Workers discovered deferred `squad_history` themselves;
the parent received metadata, not file bodies. A synchronous capability probe
preceded bounded background retrieval. Model/context/reasoning settings must use
host defaults unless the user explicitly chooses them; do not copy a historical
worker's override. Same-session shared workspace visibility was tested; fresh-task
durability came from SharePoint, not local directories. No multi-page test or
actual size/page-cap rejection was observed.

Count canonical paths, not overlapping index rows. In that recovery, 16 existing
and 15 pending rows shared one stale history path: **30**, not 31, unique files.
Maintain disjoint verified/absent/stale/conflict/unverified/withheld states;
deduplicate by project, accepted partition and exact canonical source path.
Versions and run attribution remain provenance, not extra current artifacts.
Regenerate index counts from current verified receipts and record count corrections
without rewriting historical activity records.

### Canonical mapping, migration, and synchronization receipts

The identity mapping and examples are in
[artifact-sync.md](skills/hve-project-manager/references/artifact-sync.md).
Map every validated persisted `<sourcePath>` solely to
`<project>/<sourcePath>`, preserving `.copilot-tracking/`, `docs/`, `outputs/`,
federation roots, nesting, dates, run ids, filenames, and extensions unchanged.
Research, plan details, reviews, and BRDs remain wherever HVE actually persisted
them. Create needed artifact parents only on demand; no generic category
scaffold, rewritten roots, or routine duplicate tree. Unknown artifact kind
is index metadata, not an alternate storage folder; unsupported paths block.

On existing projects, preserve all preexisting files and folders. Mark known old
category copies as legacy, keep their existing receipts/user edits, and stop
creating or refreshing additional category copies. Resolve canonical sources
only from verified inventory, never by guessing from a legacy path. Link real
canonical mirrors as primary navigation, with legacy records separate. Do not
delete/move legacy files automatically; cleanup requires separate authorization.
New human decision records live under `activity/decisions/` on demand; existing
decision records resume in place.

The project-root `artifact-index.md`, linked from README/state/next-actions,
consolidates minimal PM checkpoint/activity metadata with verified server
inventory and links actual canonical mirrors. It records run/stage, completeness, partial/unaccepted
status, pending/conflicting paths, and verification receipts outside the source
bytes. The manifest retains stable item ids/eTags and source/mirror SHA-256
hashes. Source changes refresh the authorized canonical mirror only if destination
hashes still match their last verified versions; conditional writes protect
user edits. Neither successful mirroring nor full retrieval implies stage
acceptance, activity completion, or a full projection acknowledgment.

This package contains instructions, not a background sync service. Actual
mirroring requires the signed-in host's authorized full reads, byte hashing,
and safe conditional M365 writes. Missing capabilities block affected writes
with truthful pending status. Plugin tests/ZIP validation do not establish
production BRD acceptance.

Retrieval is capability-dependent: when live `squad_history read` advertises
`offset`, prefer `offset: 0` followed by exact `nextOffset` values. Parse the
machine JSON's exact content and verify page hashes, contiguous UTF-16 offsets,
stable path/updatedAt/totals/full hash, and final UTF-8 byte count/SHA-256.
Source eTags and end offsets are not required fields. No-offset legacy reads
remain capped previews; unsupported paging plus truncated content means pending,
never a truncated canonical mirror. Exact hash-verified small inline output
does not need a spill merely because another larger response did.
When supplied, source eTags must stay stable and end offsets must be contiguous.
The last page can still report `truncated: true`; completion is null nextOffset,
final end equal to totalChars, and matching full bytes/hash. Extract the exact
artifact `content` from either equivalent MCP machine envelope, never both,
without requiring local materialization. Bounded `trackingUpdatePaths` are not
a complete manifest: full history listing supplies the persisted inventory.
Host-supported current-task raw result capture is an optional exact-content
source subject to the same identity/range/hash checks. It is not permission to
hardcode a local path, scan other sessions, or require a spill for inline files.

The current MCP `squad_status` schema polls only. Same-run human questions from
either `squad_run` or `squad_status` have `humanInput` containing UUID
`questionId`, verbatim `question`, `purpose: "clarification" | "confirmation"`,
optional `choices`, and optional `notice`. Cowork must actually display the
notice/question; merely loading them is not presentation. It waits for an
explicit answer, saves and reads it back, then calls discovered
`squad_respond({runId, questionId, answer, projectContext?})` with **Squad.Run**,
not **Squad.Operate**. Verify `accepted: true`, matching `runId` and `questionId`,
and server `respondedAt`/`respondedBy`; save the actual receipt and poll the SAME
run. Resume an answered record only with that same question id and actual
matching receipt. Missing discovery means blocked; ambiguous outcomes remain
unknown until reconciled, not permission to invent a receipt or blindly retry.

Users may stop to collaborate and return later: the server is already durably
held, so no deferral tool is needed. Preserve the pending question in the shared
M365 project with the same run/question/project identity, null answer, and
awaiting-input/deferred state. Never submit "I don't know", "ask later", empty
or placeholder answers unless explicitly confirmed as the substantive requested
decision rather than deferral. Stop polling/model work while deferred.

The original user or an authorized collaborator can return. Reload the pending
record and same-run `squad_status`, verify current question content/id and project,
then save/submit the actual completed answer and verify its receipt. Preserve
reported decision-author attribution separately from authenticated `respondedBy`;
server authentication does not verify stakeholder authority. Existing tenant/
project permissions apply, and no automatic sharing is performed.
Resumption is subject to configured run retention/expiry: use status top-level
`expiresAt` (epoch milliseconds), save it as `collaboration.runExpiresAt`, and
display its ISO deadline or the server-rendered ISO retention date. If absent
or invalid, say unknown; never invent a deadline or promise indefinite resumption. Preserve an
expired/unavailable run's record; no replacement run without explicit user choice.

This handoff cannot answer on the user's behalf, confer phase signoff, bypass
gates, or authorize native code execution/deployment. It does not establish
full provider integration parity. Operator approval is separate:
`squad_approve` cannot answer human questions, and `squad_respond` cannot release
operator gates. The HTTP server exposes
the actual `squad_approve` MCP tool only with pipeline enabled and a token with
`Squad.Operate`. Its required inputs are UUID `runId` and `decision: "approve"`;
optional UUID `projectId` is mandatory for a project-bound run and must match
persisted `projectContext.projectId`. Include it from the saved/read-back
approval, plus optional local UUID `decisionId`. The authenticated tenant and
subject establish authority, never a claimed approver in a file.

Require `structuredContent` with `approved: true`, matching `runId`, `approver`,
and `at`, and save optional `decisionId`. Repeat same-run approval returns the
original receipt, possibly with its original decision id; no new run/model work
occurs. Rejection or ambiguous answers never invoke this approve-only tool.
An uncertain submission is reconciled before retrying, never blindly repeated.
`POST /admin/approve` remains an authorized alternative for an operator or an
existing configured action; follow that action's own schema.

Cowork's Entra connection needs **admin-consented delegated `Squad.Operate`**
and reconnect/token refresh with verified rediscovery. Ordinary `Squad.Run`
does not suffice; the local simple OAuth issuer cannot mint operator scope.
The plugin package **does not deploy the server, grant consent, or provision an
external action**. A compatible deployed server and authorized refreshed
connection are required; a ZIP update alone cannot make approval available.

For runs longer than the HTTP budget, enable the server-side worker and durable
Table run state. Do not keep a Cowork tool call open while waiting for approval.

## Stakeholder project library

The project folder now has a stakeholder front door as well as its technical
inventory, on both OneDrive and SharePoint:

| Project page | Purpose |
| --- | --- |
| `START-HERE.md` | Available deliverables, decisions needing input, next action and project health |
| `library/deliverables.md` | Meaningful document links, version, acceptance and mirror status; supporting evidence separately |
| `library/decisions.md` | Live questions, review evidence gaps, deferred input, operator blockers and resolved history |
| `library/next-steps.md` | Supported actions, dependencies, actors and evidence; technical recovery separately |
| `artifact-index.md` | Complete technical inventory, receipts, internal artifacts and recovery diagnostics |

README, state and checkpoint action pages link to the library. The new pages
are navigation only: a BRD stays at its exact canonical server path, and no
duplicate deliverable/category tree is created. Verified drafts remain visible
even after failed review, labelled **Unapproved draft - changes requested**,
not hidden as if no document existed or presented as accepted. An answered
question, server-accepted answer, passed review and approved document remain
different facts.

Pending decisions have evidence, known ownership/dates and an actual response
path. Review recommendations are not invented live server questions; editing a
library row cannot submit approval. Unknown owners and dates remain unknown.
Views carry checkpoint/time/coverage and expose stale or incomplete mirrors.
Canonical artifacts and divergent user edits are never overwritten to improve
presentation. Native live-question presentation still precedes bulk refresh.

The packaged [stakeholder library protocol](skills/hve-project-manager/references/stakeholder-library.md)
contains initial templates, classification rules and conditional-write safeguards.
The package does **not** automatically backfill existing cloud projects. After
installing it, an existing project can be upgraded with:

> Open this existing project and rebuild its stakeholder library from the
> verified artifacts, saved decisions and current checkpoint. Create the missing
> Start here, deliverables, decisions and next-step views. Preserve original
> files, user edits, project identity and bridge acknowledgments. Do not start
> a new squad run. Report any conflicts or incomplete evidence.

Accept file-write confirmations as appropriate. Readback must verify the pages
and their links before reporting the library available. An unrelated existing
library or divergent page requires explicit reconciliation, not replacement.

### Stakeholder library acceptance checks

1. On both providers, create a project and verify README -> Start here -> all
   three views, including their return links and truthful empty states.
2. Surface a verified BRD from a failed-review run under its readable title;
   open its original file and confirm unchanged hash, draft label and separate
   review/mirror status. No plan or history log should be presented as a BRD.
3. Present a live server question promptly; defer it, then resume and answer
   through the existing same-run protocol. Verify pending versus accepted
   decision status, and that review findings never become fabricated live prompts.
4. Upgrade a populated project without a new model run. Preserve earlier valid
   deliverables and unresolved decisions. Test absent files, stale evidence,
   concurrent edits and an unrelated preexisting library; no silent overwrite.
5. Force a library write failure. Verify reconciliation-required and exact stale
   pages are reported, and bridge acknowledgments do not advance because of it.

Local instruction/validator/template tests and ZIP verification do not establish
that these live Cowork acceptance checks have passed.

## Security and governance

- The connector uses `OAuthPluginVault`; every user completes consent.
- Operator privileges are opt-in: retain operator-only `Squad.Operate` and
  explicit human confirmation. Admin-consent that delegated scope on the
  Cowork connection only for intended operators; do not widen ordinary run
  scopes to bypass a gate.
- The server remains the enforcement point for audience, tenant, scope, feature
  flags, gates, concurrency, and cost ceilings.
- Runtime-discovered or modified tools are subject to Microsoft 365 runtime RAI
  and cross-prompt-injection validation before activation.
- Memory writes advertise `destructiveHint`; project-aware advisory tools remain
  non-destructive but are not marked read-only because they advance the
  tenant/project tracking ledger.

## Known constraints

- The project folder records every interaction handled through the HVE project
  skill. Cowork turns where the skill does not activate are outside that
  journal.
- The folder is authoritative. Bridge schema `2` binds an immutable project
  UUID to actual M365 provider + driveId + folderItemId; never fabricate ids.
  Names/slugs are labels, not identity. Same-folder renames keep the UUID;
  copied/new folders get new UUIDs even with equal slugs. Conflicts are rejected
  before inference, never bypassed by regenerating an existing UUID.
- The local manifest remains schema `2`. Negotiate bridge `2` only when live
  schemas advertise it, otherwise retain schema `1` compatibility. Save and
  verify server `ack.project` in `contextBridge.project` before polls/history:
  it is the canonical (typically GUID-derived) partition or a safely mapped
  legacy partition. Matching legacy GUID/storage preserves history.
- Cowork must materialize every returned tracking update before advancing the
  manifest revision. A truncated or unavailable tracking delta requires
  reconciliation rather than silent continuation.
- Tools returned for the signed-in user are candidates for Cowork's runtime
  activation. Discovery, activation, invocation, and successful execution are
  separate checks. The project-manager skill intentionally ignores every
  work-producing entry except `squad_run`.
- Clear, truthful runtime descriptions are essential. Cowork now consumes the
  descriptions served by the HTTP MCP endpoint.
- Feature changes are normally visible in a new session, after runtime validation.
- A synchronous tool still needs to finish within Cowork's tool-call budget.
- Operator approval requires the authorized submission channel, preferably
  discovered `squad_approve`, or an authorized external admin action. Server
  acceptance must never be inferred from a saved file, chat answer, or tool
  consent.
- HVE's remote tools are advisory. Repository changes, tracker writes, and
  deployments require separately configured Cowork or connector capabilities.
