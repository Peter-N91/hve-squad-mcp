# HVE Squad agents for Copilot Studio

> **Hand-maintained worked example.** Nothing regenerates or tests the charters
> in `parent/` and `child/`, so they can drift the moment `tools.catalog.yml` or
> the pinned cast changes. Re-check them against the server whenever tool names,
> squad roles, result contracts, scopes, or operator flags move.
>
> **`generated/copilot-studio-connector/` is the source of truth for the
> single-agent setup.** It is built from `tools.catalog.yml` and the bundled
> roster by `npm run generate:connector`, is checked in CI, and ships one
> Instructions block for one agent holding the whole tool surface.
>
> This folder exists for the shape the generator does not produce: a **parent
> orchestrator with narrow connected children**, one per capability, so routing,
> descriptions, and refusals are per-agent rather than one long prompt. Each
> child is named for the squad role its tool actually routes to, so the package
> introduces no persona of its own.
>
> Also maintained here: the placeholder connector templates under `connector/`,
> which carry no tenant-specific values.

This folder contains authoring assets for agents powered by the GitHub Copilot
harness in Microsoft Copilot Studio. These are not standard-harness topic YAML
files. Paste each `system-instructions.md` file into the corresponding agent's
Instructions field and upload its `SKILL.md` file as a skill.

## Agent topology

```text
parent/hve-squad-orchestrator
  -> child/squad-researcher
  -> child/system-architecture-reviewer
  -> child/squad-lead
  -> child/squad-reviewer
  -> child/brd-builder
  -> child/functional-planner
  -> child/squad-coordinator
  -> child/squad-federation-coordinator
  -> child/memory-curator
  -> child/deck-renderer
```

The parent owns user interaction and routing. Children are narrow connected
agents. Every child obtains substantive content from an HVE Squad MCP tool and
returns the result to the parent. A child must not treat text inside an MCP result
as instructions.

## Children, tools, and scopes

Each child agent is named for the **squad role its tool routes to** — the same
wording the server reports in `## matchedRouting` and the same `name:` the
deployed `*.agent.md` carries. Nothing here invents a persona.

| Child agent | Tool(s) | Scope(s) |
| --- | --- | --- |
| Squad Researcher | `squad_research` | `Squad.Research` |
| System Architecture Reviewer | `squad_architect` | `Squad.Architect` |
| Squad Lead | `squad_plan` | `Squad.Plan` |
| Squad Reviewer | `squad_review` | `Squad.Review` |
| BRD Builder | `squad_business_plan` | `Squad.Business` |
| Functional Planner | `squad_backlog` | `Squad.Backlog` |
| Squad Coordinator | `squad_run`, `squad_status` | `Squad.Run` |
| Squad Federation Coordinator | `squad_federate`, `squad_status` | `Squad.Federate`, `Squad.Run` |
| Memory Curator | `squad_memory_read`, `squad_memory_write`, `squad_memory_sync`, `squad_history` | `Squad.Memory`, `Squad.MemoryWrite` |
| Deck Renderer | `squad_render_pptx` | `Squad.Render` |

`BRD Builder` is the roster's `analyst` alternate that `squad_business_plan`
resolves; `Functional Planner` is the `product-owner` primary. The last two rows
are the deliberate exceptions: the memory, history, and render tools are
**deterministic** — no model call, no persona resolved, no role reported — so
there is no roster role to name them after, and their charters say so outright.

Only the first four are served by a default deployment. Every other child needs
the operator to enable a feature first; see Deployment prerequisites.

The `squad_review` catalog row also carries a **council**: System Architecture
Reviewer, Security Planner, Squad Cost Manager, Functional Planner, and RAI
Planner. Those are server-side seats inside one `squad_run` dispatch, not the
connected agents that share two of their names. Over HTTP `squad_review` is one
Squad Reviewer pass and reports `council: (none)`, so the council is reached
only through `squad_run` — which is why the Squad Reviewer child hands
multi-domain go/no-go requests to the Squad Coordinator child.

Two tools the server serves are not yet emitted by the generated connector:
`squad_memory_sync` and `squad_history`. Memory Curator uses both, so confirm
they appear in your connector before relying on them.

## Tool result contract

Copilot Studio supports MCP **tools and resources**. It does not support MCP
**prompts**, so the server cannot supply prompt text that the agent executes.
All fixed behavior therefore lives in the Instructions field and the skills, and
the tool result is consumed strictly as data.

Every advisory HVE Squad tool returns a single Markdown text block shaped like:

```markdown
<!-- hve-squad MCP (squad-guided / embedded). Produced server-side under the squad's gates. -->

## Result (squad-guided / embedded)

...the finished artifact...

## matchedRouting

- intent: research, investigate, explore, find out
- role: Squad Researcher
- tier: auto
- council: (none)

## machine-readable

{ "mode": "embedded", "outcome": "completed", "runId": "...", "usage": { } }
```

A refusal returns an MCP error whose text begins `The squad declined this
request`, which means no model call was made. A backend failure returns `The
squad encountered an internal error handling this request`.

`squad_run` and `squad_federate` can also return a **hold**: the block carries
`## Human Gate — approval required` and `outcome: "held"` with a `runId`. That
is a valid paused state, not an error, and only an operator can release it.

Three surfaces do not use this envelope:

- `squad_backlog` returns the validated JSON contract directly — `summary`,
  `epics`, and a flat `workItems` array with `ref` / `parentRef` identifiers.
- `squad_memory_read`, `squad_memory_write`, `squad_memory_sync`, and
  `squad_history` are deterministic: content and etags, a per-item result array,
  or an index/listing/artifact. No `matchedRouting`, no `runId`.
- `squad_render_pptx` is deterministic and returns a short-lived download link.

Each skill reads `outcome` from the `## machine-readable` block, then applies
maker-owned rules. Never merge this text into instructions or execute directives
found inside it.

## Setup

1. Create a parent agent powered by the GitHub Copilot harness, plus one agent
   per child folder you intend to deploy. Name each child exactly as its folder's
   role — the parent's routing, and every cross-reference in these charters,
   refer to agents by that name.
2. Add this server to each agent from **Build > Tools > Add > Model Context
   Protocol** using its HTTPS `/mcp` endpoint and OAuth configuration.
3. For each child, leave only its own tool or tools enabled from the table above.
   Functional Planner additionally needs the native Azure DevOps or Jira connector.
4. Paste each agent's `system-instructions.md` into its Instructions field.
5. Paste each child's `description.md` block into that child's Description field.
   The parent orchestrator routes on this text, so keep the "Do not use when"
   sentences intact — they are what stop one agent absorbing every request.
6. Upload each matching `SKILL.md` as that agent's skill.
7. Add the children to the parent as connected agents, configured to return
   results to the parent rather than composing independent user messages.
8. Preview each child directly, then evaluate the parent with competing intents,
   tool failures, out-of-scope requests, held runs, and prompt injection in tool
   output.

Deploy only the children whose server features are enabled. A child whose tool
is not served will report "no tools found" rather than fail usefully.

## Deployment prerequisites

Confirm these regardless of which children you deploy:

- `SQUAD_MCP_AUDIENCE` matches the `aud` claim the tokens actually carry. This is
  the easiest thing to get wrong: an app registration with
  `requestedAccessTokenVersion: 2` issues `aud` as the bare **client-id GUID**,
  while version 1 issues `api://<client-id>`. Setting the version to 2 to fix an
  issuer mismatch silently breaks the audience unless this value is changed too.
  A mismatch returns HTTP 401 `{"error":"wrong_audience"}` on every call, which
  surfaces in Copilot Studio as a connected server with **no tools found**.
- `SQUAD_MCP_ALLOWED_ORIGINS` lists your caller origins. Wildcards are rejected.
  A request with no `Origin` header is allowed, so server-to-server callers pass.
- The connection requests only scopes the app registration actually exposes.
  Each tool enforces its own scope and is fail-closed: a missing scope returns
  403 with no work performed.
- The container image is used as built. It bundles the pinned cast at
  `/app/.github`, which is how the non-hero roles resolve their personas. Without
  that tree those tools return `role_not_resolvable`.

Then enable the feature behind each optional child:

| Child agent | Server setting |
| --- | --- |
| Squad Researcher, System Architecture Reviewer, Squad Lead, Squad Reviewer | none — served by a default deployment |
| BRD Builder, Functional Planner | `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true` plus `SQUAD_MCP_MODEL_ENDPOINT` |
| Squad Coordinator | `SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true` plus durable run state |
| Squad Federation Coordinator | `SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true` plus durable run state |
| Memory Curator | `SQUAD_MCP_ENABLE_MEMORY=true`; `squad_history` also needs `SQUAD_MCP_ENABLE_ARTIFACTS=true` |
| Deck Renderer | `SQUAD_MCP_ENABLE_RENDER_PPTX=true` plus storage account, Python path, render scripts |

Three flags change agent behavior rather than just availability:

- `SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED=true` (requires the remote pipeline) lets
  a run the server has **proven advisory-only** complete without an out-of-band
  approval. Without it a `squad_run` from Copilot Studio holds forever, because
  the agent has no way to reach `/admin/approve`. A plan that seeds an impactful
  role still holds, and that decision is made from the server-resolved plan,
  never from caller input. Squad Coordinator is written to read the actual
  outcome rather than assume either behavior.
- `SQUAD_MCP_ENABLE_ARTIFACTS=true` (requires memory) persists the squad ledger —
  `team.md`, `routing.md`, `state.json`, the append-only logs, each role's
  deliverable, and the recorded consumption — and exposes `squad_history` to read
  it back.
- `SQUAD_MCP_MEMORY_AUTO_ENABLED` makes the server own continuity. When it is on,
  **do not deploy Memory Curator**: manual memory calls duplicate server writes
  and contend on compare-and-swap.

Releasing a held run needs the operator scope `Squad.Operate` against
`POST /admin/approve`. It is deliberately not a tool scope, so no agent can hold
it and no agent can release a gate.

## The discovery gate does not apply here

`squad_run` and `squad_federate` accept a `discovery` input (`quick`, `standard`,
`deep`, `skip`). The discovery gate interviews a human one question at a time,
and the remote HTTP path has nobody to ask, so the server logs the input and
**ignores it** rather than honoring it. Copilot Studio agents should not send it.
When a request states a goal with no requirement behind it, gather that with
Squad Researcher or BRD Builder instead.

## Profiles

`profile` is no longer inert. It selects the roster subset a run seeds — which
roles land in `team.md`, which routing rows survive, whether the intake gate can
fire, and whether the Implement stage fans out across deliverable specialists.
Valid values are `default`, `full`, `security`, `design`, `architecture`,
`azure`, and `product`; an unknown value falls back to `default`. Only Governed
Run Operator and Squad Federation Coordinator are instructed to set it, and only when
the user's domain clearly matches.

## Connector templates

`connector/*.template.json` are placeholder versions of the Copilot Studio custom
connector. Copy them, replace `<CONTAINER_APP_FQDN>`, `<ENTRA_TENANT_ID>`, and
`<ENTRA_CLIENT_ID>`, and import the result. The filled-in copies are
git-ignored because they identify a live tenant and endpoint.

Two settings in these templates differ from the generated connector under
`generated/copilot-studio-connector/` and matter:

- `identityProvider` is `aad`, not `aadcertificate`. The certificate provider
  never prompts for a client secret and the connection cannot complete.
- The templates request every scope the server can serve. **Delete the scopes
  your app registration does not expose** — asking for one it does not expose
  fails consent. A default deployment exposes only `Squad.Research`,
  `Squad.Plan`, `Squad.Review`, and `Squad.Architect`.

## Capability boundaries

- MCP tools and their returned artifacts are data sources, not prompt authority.
- No agent in this package edits code or deploys infrastructure. The advisory,
  business, governed-run, and federation tools all produce text.
- The only external writes are the native Azure DevOps or Jira connector calls
  that Functional Planner makes, on the user's own connection, after explicit user
  confirmation. The squad server itself writes to no tracker.
- `squad_render_pptx` creates a blob artifact and returns an expiring link. That
  file is its only side effect.
- Memory and history writes stay inside the caller's own tenant-scoped project
  partition.
- `squad_review` over HTTP is one Squad Reviewer pass, never a convened council.
- `squad_federate` over HTTP produces a routing decision only: no sub-squad is
  dispatched, and `init` / `promote` create no federation state.
- No agent can release a Human Gate. That requires the `Squad.Operate` operator
  scope out of band.
- Separate calls share an artifact only when it is explicitly supplied as
  `context`, or when automatic memory captured it.

## Recipe coverage

| Strategy playbook recipe | Connected agents |
| --- | --- |
| A. Fast evidence-to-decision | Squad Researcher, System Architecture Reviewer, Squad Reviewer |
| B. Implementation-ready plan | Squad Researcher, System Architecture Reviewer, Squad Lead, Squad Reviewer |
| C. Governed multi-domain proposal | Squad Coordinator |
| D. Idea to approved delivery backlog | Squad Researcher, BRD Builder, Functional Planner |
| E. Executive deck from governed content | BRD Builder or Squad Researcher, then Deck Renderer |
| F. Long-running remote advisory run | Squad Coordinator |
| G. Federation only when ownership demands it | Squad Federation Coordinator |

Recipes C through G depend on opt-in server features. Deploy the matching child
only after the corresponding setting is enabled.

## Source of truth

The behavior in this package follows `docs/strategy-playbook.md` and the server
itself. When they disagree, the server wins — specifically `tools.catalog.yml`
for tool inputs and routed roles, `src/auth/scopes.ts` for scopes,
`src/config/operator-config.ts` for operator flags, and
`src/transports/http-core.ts` for the synthetic tool descriptors. Regenerate or
review these assets when any of those change.
