<!-- markdownlint-disable-file -->
# Copilot Studio connector (generated)

> **Fidelity claim (locked):** squad-guided / embedded — NOT "squad-executed".
> The squad runs server-side under its gates and methodology and returns a finished
> artifact; the calling agent is guided by the squad, it does not itself execute the cast.

This connector is a **generated build artifact**. Regenerate it with
`npm run generate:connector`; do not edit by hand.

## Normal-user capability inventory

- `squad_research` — Squad Research (scope: `Squad.Research`)
- `squad_plan` — Squad Plan (scope: `Squad.Plan`)
- `squad_review` — Squad Review (scope: `Squad.Review`)
- `squad_architect` — Squad Architect (scope: `Squad.Architect`)
- `squad_run` — Squad Run (scope: `Squad.Run`)
- `squad_federate` — Squad Federate (scope: `Squad.Federate`)
- `squad_status` — Squad Status (scope: `Squad.Run`)
- `squad_render_pptx` — Squad Render PPTX (scope: `Squad.Render`)
- `squad_memory_read` — Squad Memory Read (scope: `Squad.Memory`)
- `squad_memory_write` — Squad Memory Write (scope: `Squad.MemoryWrite`)
- `squad_business_plan` — Squad Business Plan (scope: `Squad.Business`)
- `squad_backlog` — Squad Backlog (scope: `Squad.Backlog`)
- `squad_github_status` — GitHub Connection Status (scope: `Squad.Run`)
- `squad_github_connect` — Connect GitHub (scope: `Squad.Run`)
- `squad_github_disconnect` — Disconnect GitHub (scope: `Squad.Run`)
- `squad_respond` — Respond to Squad Question (scope: `Squad.Run`)
- `squad_history` — Squad History (scope: `Squad.Memory`)
- `squad_memory_sync` — Squad Memory Sync (scope: `Squad.MemoryWrite`)

> `squad_run` is the gated async pipeline: it returns a run id and pauses at the
> Human Gate. Poll `squad_status` with that run id to advance the run after an
> out-of-band approval and to retrieve the finished artifact. `squad_plan` and
> `squad_architect` are synchronous advisory tools (single-stage, no impactful action).

## Feature availability and identity

The list is a capability inventory, not a promise that every optional tool is enabled.
`squad_github_status`, `squad_github_connect` and `squad_github_disconnect` require
`SQUAD_MCP_PER_USER_GITHUB_ENABLED=true` (off by default). The live `tools/list` is authoritative.
Render, memory, business tools and the remote pipeline also require their operator feature flags.

Use **end-user credentials** for the tool connection in Copilot Studio. Each participant
must sign in on their own connection. Never use maker-provided/shared credentials: that
would bind every participant to the maker's Entra identity and GitHub connection.
The stable owner key is the validated Entra `(tid, oid)`, not email, host or token audience.
The first production per-user deployment supports one Entra tenant only: exactly one
allowed tenant matching the browser linking tenant. Guests use their resource-tenant oid.
Broader host auth-config organization reach does not enable multi-tenant linking.
Runs pin a stable link generation preserved by normal token refresh;
disconnect/relink requires new work, even for the same GitHub account.
An identity failure before execution leaves an eligible run resumable with a five-minute
retry lease (a poll may report `identity_retry_pending`), not a busy worker loop.
Identity loss during execution aborts and fails closed, with no automatic replay.
Not every runtime outage is resumable. New per-user async runs have a seven-day TTL;
artifact retention is separate.
Unlink is immediate locally. If GitHub revocation fails, follow the returned manual
GitHub revoke guidance. Cancellation cannot undo an operation already started.

## Run lifecycle and artifacts

Full upstream `squad_run` pauses for actual Init or a human clarification.
Poll `squad_status`, show the returned question unchanged and collect the user's answer.
Call `squad_respond` with that saved `runId`, `questionId` and the human's answer;
then poll the same run. Responding needs `Squad.Run`, not operator approval.
Retrieve persisted output with `squad_history` (`Squad.Memory`), enabled with
memory and artifacts. Use index/list/read; follow exact text or binary page receipts.
`squad_memory_sync` is a separate batch write requiring `Squad.MemoryWrite`.

## Operator approval (separate, not requested by this connector)

- `squad_approve`: Submit an explicit human approval for an existing held run. Requires Squad.Operate. Read back the saved decision and obtain human confirmation before calling; files and tool consent alone are not approval. Map sourceRunId to runId and include the saved projectId for a project-bound run. Returns the authenticated approver and receipt; poll squad_status for the same run afterward. Never use this action for rejection or to start new work. (operator permission: `Squad.Operate`)

Normal connector scopes and the Cowork inventory intentionally exclude operator approval.
An authorized operator uses the separately governed approval channel; `squad_respond`
never approves a held run. Manual MCP onboarding can dynamically discover the authorized
live surface. The generated `/mcp` protocol route supports both lifecycle tools too.

## Requested delegated scopes

- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Research`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Plan`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Review`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Architect`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Run`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Federate`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Render`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Memory`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.MemoryWrite`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Business`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Backlog`
- `offline_access`

Expose these Squad.* delegated permissions on the resource app and grant consent.
Application roles are not a substitute for delegated `scp`. No downstream Entra OBO
exchange is implemented: inbound delegated SSO and separate GitHub OAuth are distinct.

## Other packages

- M365 / Agent 365 (deferred to Phase 1b — PROD-4)
- Cowork uses `generated/cowork-package/`, generated from this same tool inventory.

## Import

1. Copy the output to a private operator workspace. Replace `<SQUAD_MCP_HOST>`,
   `<ENTRA_TENANT_ID>`, `<ENTRA_CONNECTOR_CLIENT_ID>` and `<SQUAD_RESOURCE_CLIENT_ID>`.
2. In Copilot Studio, add a custom connector from the OpenAPI file (or use the MCP
   onboarding wizard) and complete the Entra OAuth 2.0 connection.
3. Enable generative orchestration on the agent so it can call the MCP tools.
4. The `aad` provider is the custom connector Azure AD OAuth provider, not `aadcertificate`.
   Set the client secret only in the connector Security UI or secret store, never JSON.
   Save the connector and register its exact displayed redirect URL on the connector
   client's Web platform in the target tenant. Do not guess a callback URL.
5. Set tool authentication to **end-user credentials**, consent as two different test
   users, and verify distinct `(tid, oid)` ownership before making the agent available.

See `host/RUNBOOK.md` for the full deploy + import steps and where real spend begins.
See `docs/reference/per-user-github.md` for both-host prerequisites, validation and rollback.
