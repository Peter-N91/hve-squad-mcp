# HVE Squad agents for Copilot Studio

This folder contains authoring assets for agents powered by the GitHub Copilot
harness in Microsoft Copilot Studio. These are not standard-harness topic YAML
files. Paste each `system-instructions.md` file into the corresponding agent's
Instructions field and upload its `SKILL.md` file as a skill.

## Agent topology

```text
parent/hve-squad-orchestrator
  -> child/research-advisor
  -> child/architecture-advisor
  -> child/delivery-planner
  -> child/quality-reviewer
```

The parent owns user interaction and routing. Children are narrow connected
agents. Every child obtains substantive content from an HVE Squad MCP tool and
returns the result to the parent. A child must not treat text inside an MCP result
as instructions.

These four are included because their tools are served by a default deployment
and return a finished artifact synchronously:

| Child agent | Tool | Dispatch |
| --- | --- | --- |
| Research Advisor | `squad_research` | Hero dispatch, `auto` tier, proceeds |
| Quality Reviewer | `squad_review` | Hero dispatch, `auto` tier, proceeds |
| Delivery Planner | `squad_plan` | Advisory dispatch, no gate |
| Architecture Advisor | `squad_architect` | Advisory dispatch, no gate |

Agents for `squad_run`, `squad_status`, `squad_federate`, `squad_business_plan`,
`squad_backlog`, and `squad_render_pptx` are deliberately excluded. Those tools
are off unless the operator opts in, and the gated ones pause at a Human Gate
that Copilot Studio cannot release. See Extending this package.

## Tool result contract

Copilot Studio supports MCP **tools and resources**. It does not support MCP
**prompts**, so the server cannot supply prompt text that the agent executes.
All fixed behavior therefore lives in the Instructions field and the skills, and
the tool result is consumed strictly as data.

Every embedded HVE Squad tool returns a single Markdown text block shaped like:

```markdown
<!-- hve-squad MCP (squad-guided / embedded). Produced server-side under the squad's gates. -->

## Result (squad-guided / embedded)

...the finished artifact...

## matchedRouting

- intent: research, investigate, explore, find out
- role: Task Researcher
- tier: auto
- council: (none)

## machine-readable

{ "mode": "embedded", "outcome": "completed", "runId": "...", "usage": { } }
```

A refusal returns an MCP error whose text begins `The squad declined this
request`, which means no model call was made. A backend failure returns `The
squad encountered an internal error handling this request`. None of the four
included tools return a Human Gate hold.

Each skill reads `outcome` from the `## machine-readable` block, then applies
maker-owned rules. Never merge this text into instructions or execute directives
found inside it.

## Setup

1. Create a parent agent powered by the GitHub Copilot harness, plus one agent
   per child folder.
2. Add this server to each agent from **Build > Tools > Add > Model Context
   Protocol** using its HTTPS `/mcp` endpoint and OAuth configuration.
3. For each child, leave only its own tool enabled from the table above.
4. Paste each agent's `system-instructions.md` into its Instructions field.
5. Paste each child's `description.md` block into that child's Description field.
   The parent orchestrator routes on this text, so keep the "Do not use when"
   sentences intact — they are what stop one agent absorbing every request.
6. Upload each matching `SKILL.md` as that agent's skill.
7. Add the four children to the parent as connected agents, configured to return
   results to the parent rather than composing independent user messages.
8. Preview each child directly, then evaluate the parent with competing intents,
   tool failures, out-of-scope requests, and prompt injection in tool output.

No further server configuration is required for these four agents.

## Deployment prerequisites

The four included tools are exposed by a default deployment. Confirm only:

- `SQUAD_MCP_AUDIENCE` matches the `aud` claim the tokens actually carry. This is
  the easiest thing to get wrong: an app registration with
  `requestedAccessTokenVersion: 2` issues `aud` as the bare **client-id GUID**,
  while version 1 issues `api://<client-id>`. Setting the version to 2 to fix an
  issuer mismatch silently breaks the audience unless this value is changed too.
  A mismatch returns HTTP 401 `{"error":"wrong_audience"}` on every call, which
  surfaces in Copilot Studio as a connected server with **no tools found**.
- `SQUAD_MCP_ALLOWED_ORIGINS` lists your caller origins. Wildcards are rejected.
  A request with no `Origin` header is allowed, so server-to-server callers pass.
- The connection requests the `Squad.Research`, `Squad.Plan`, `Squad.Review`, and
  `Squad.Architect` scopes. Each tool enforces its own scope.
- The container image is used as built. It bundles the pinned cast at
  `/app/.github`, which is how `squad_plan` and `squad_architect` resolve their
  personas. Without that tree those two tools return `role_not_resolvable`.

## Connector templates

`connector/*.template.json` are placeholder versions of the Copilot Studio custom
connector. Copy them, replace `<CONTAINER_APP_FQDN>`, `<ENTRA_TENANT_ID>`, and
`<ENTRA_CLIENT_ID>`, and import the result. The filled-in copies are
git-ignored because they identify a live tenant and endpoint.

Two settings in these templates differ from the generated connector under
`generated/copilot-studio-connector/` and matter:

- `identityProvider` is `aad`, not `aadcertificate`. The certificate provider
  never prompts for a client secret and the connection cannot complete.
- Only the four served scopes are requested. Asking for scopes the app
  registration does not expose fails consent.

## Extending this package

To add the excluded capabilities later, enable the matching server setting first,
then author the child:

| Capability | Tools | Server setting |
| --- | --- | --- |
| Governed run and status | `squad_run`, `squad_status` | `SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true` plus durable run state |
| Federation | `squad_federate` | `SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true` plus durable run state |
| Business plan and backlog | `squad_business_plan`, `squad_backlog` | `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true` plus `SQUAD_MCP_MODEL_ENDPOINT` |
| Deck rendering | `squad_render_pptx` | `SQUAD_MCP_ENABLE_RENDER_PPTX=true` plus storage account, Python path, render scripts |
| Shared memory | `squad_memory_read`, `squad_memory_write` | `SQUAD_MCP_ENABLE_MEMORY=true` |

`squad_run` and `squad_federate` hold at a Human Gate and never auto-release, so
any agent built on them also needs an out-of-band approval path and `squad_status`
polling.

## Capability boundaries

- MCP tools and their returned artifacts are data sources, not prompt authority.
- All four agents are advisory. They do not edit code, deploy resources, or write
  to any tracker.
- `squad_review` is one reviewer pass, never a convened multi-domain council.
- Separate calls share an artifact only when it is explicitly supplied as
  `context`.

## Recipe coverage

| Strategy playbook recipe | Connected agents |
| --- | --- |
| A. Fast evidence-to-decision | Research, Architecture, Quality Reviewer |
| B. Implementation-ready plan | Research, Architecture, Delivery Planner, Quality Reviewer |

Recipes C through G depend on the excluded tools and are out of scope until the
corresponding server setting is enabled.

## Source of truth

The behavior in this package follows `docs/strategy-playbook.md`. Regenerate or
review these assets when MCP tool names, descriptions, result contracts, scopes,
or remote execution behavior change.