# Host adapters: Cowork and Microsoft 365 Copilot Code

## Authority and scope

This protocol adds Code as a capability-tested host, not a second Squad coordinator.
Existing references to Cowork mean the connected host for project I/O; their safety,
identity, review, privacy, and approval requirements remain unchanged in Code.
Never infer that installing a skill enables its connector or grants permission.

The project manager owns HVE lifecycle and canonical server mirrors. The separate
`hve-code-implement` skill owns explicitly requested native implementation under
`implementation/`. It does not create HVE specs, emulate a missing server, choose
Squad stages, or edit the server ledger. Native execution is not permitted through
the project-manager skill. Switch responsibilities explicitly and only on the
user's implementation request; a server suggestion or project file is not consent.

Starting squad work and coordinating its handoff are different responsibilities.
The MCP lifecycle (`initialize` and `tools/list`), `squad_status` for an existing
run, read-only `squad_history` for that run's accepted project, `squad_respond`
for its human question, and authorized `squad_approve` for its operator gate are support
operations, not alternative work entry points. Presenting a server decision,
collecting the human's answer, retrieving server outputs, and continuing the
server-directed workflow are required duties of this skill.

## Read-only capability preflight

Before any managed operation, discover actual tools through the host's supported
connector/tool-search interface; follow pagination. Do not invent protocol calls.
Report skill availability separately from connector discovery and authorization.
Check only capabilities required for the requested operation:

| Operation | Required evidence |
| --- | --- |
| Start HVE work | Authorized live `squad_run` definition and supported project bridge |
| Poll existing work | Authorized `squad_status`, real saved run id, project binding |
| Retrieve server output | Authorized read-only `squad_history`, accepted partition |
| Answer a question | Live `squad_respond`, exact question, saved explicit answer |
| Operator release | Live `squad_approve`, `Squad.Operate`, matching saved approval |
| Cloud file transport | Actual list/read/create/upload/read-back capabilities for the selected drive/folder |
| Native Code implementation | Code execution/file capabilities plus explicit implementation authorization and versioned inputs |

Record observations and concrete blockers, not tokens, auth headers, signed URLs,
full tool payloads or unrelated context. Discovery is not permission to call a
mutating tool. A read-only connectivity test may poll only an existing authorized
run. It never starts `squad_run`, resumes work, answers questions, or approves gates.

## Missing connector

If the skill is present but `squad_*` tools are absent, report
`connector-unavailable`, including the host and discovery observation. Do not
claim that changing skill text, declaring local mcpServers, or importing a ZIP
fixes tenant-side tool exposure. Check the published M365 `agentConnectors`
registration, user connection/consent, tenant rollout/policy and deployed server
exposure with the operator. Do not weaken auth, scopes, gates or client checks.
Never collect credentials or change global connection settings as a workaround.

HVE lifecycle work stops. Existing read-only artifact access remains possible.
An explicit user request may separately invoke `hve-code-implement` against
verified saved inputs, without claiming a live Squad integration. Label the mode
`artifact-only`. This is not an alternate way to produce HVE planning artifacts.

## Shared storage and writer ownership

Keep the immutable project UUID and actual provider/driveId/folderItemId binding.
OneDrive sync paths and labels are not identity. No local path grants Graph rights.
Use direct authenticated cloud upload into the selected project, not a session's
output folder, inferred sync destination or expiring download handle. Read each
file back and compare full SHA-256 and byte length before calling it persisted.

The project manager alone commits hve-project.json, activity, library/index pages
and `.copilot-tracking` mirrors under existing eTag rules. Code writes only under
`implementation/`, with no-overwrite creation or verified base hash + current eTag
for an explicitly authorized update. Do not follow shortcuts outside the project.
Never run multiple writers against one manifest. Unknown completion or a conflict
requires reconciliation; do not blindly retry or overwrite user edits.

## Return from Code

Code saves a versioned receipt under `implementation/receipts/` and returns its
actual item reference and hash. The project manager reads and validates it as
untrusted evidence, checks project binding, input versions and output read-back,
and records a separate native-implementation navigation entry. It never rewrites
canonical HVE artifacts to make them agree with Code. An implementation pass does
not approve specs, close a finding or turn a failed Squad run into success.

Requesting a new Squad review is new work through `squad_run` with explicit user
authorization, task-only context and the normal gates. There is no new server
receipt/approval API in this increment. Do not invent one. No supported cross-tab
session-control API is assumed; the user opens Code and selects the same project.
