# HVE Squad project-management plugin for Microsoft Copilot Cowork

This Cowork plugin combines one project-management Agent Skill with the remote
HVE Squad MCP connector. The skill manages a user-selected OneDrive or
SharePoint project folder, while Cowork discovers the server's enabled tools at
runtime.

The package deliberately contains:

- one `agentConnectors` entry;
- one `agentSkills` entry for `hve-project-manager`;
- no pinned `mcpToolDescription`.

With app manifest v1.29, Cowork connects to the server, sends `initialize`, and
calls `tools/list`. Tool additions, removals, descriptions, schemas, and safety
annotations therefore come from the deployed server rather than a copied file in
the plugin.

## Why this shape

The previous package projected the squad into one dispatcher skill plus ten stage
skills and pinned a generated tool-description file. That introduced two sources
of routing truth and required repackaging whenever the MCP surface changed.

The current package separates two kinds of authority:

1. The project-manager skill owns the stable project lifecycle: create or open a
   folder, load its checkpoint and `.copilot-tracking` projection, negotiate its
   identity/revision with the server, call the appropriate live tools, save
   artifacts, materialize returned tracking deltas, and commit the next checkpoint.
2. The operator enables server features.
3. The server exposes only those tools from `tools/list`.
4. Cowork validates and activates the discovered definitions.
5. Tool names, descriptions, schemas, and annotations remain server-owned, so
   tool changes do not require regenerating the skill.

This does not reproduce the Copilot Studio parent/child-agent topology. It gives
Cowork one orchestration skill that combines its native Microsoft 365 file
capabilities with the same coarse MCP tools.

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
|       `-- references/project-contract.md
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
- Cowork invokes `squad_research`;
- the response carries the embedded squad result.

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

### Phase 2: prove the list is dynamic

1. Enable one optional server feature, such as
   `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true` together with its required configured
   `SQUAD_MCP_MODEL_ENDPOINT`.
2. Deploy the server without changing or repackaging the Cowork plugin.
3. Start a new Cowork session.
4. Ask for a business plan and confirm Cowork can select
   `squad_business_plan`.
5. Disable the feature, redeploy, and confirm a new session no longer exposes it.

The plugin passes only if the tool surface follows the server without a manifest
change.

### Phase 3: gated runs

`squad_run` and `squad_federate` return a run id and pause at the Human Gate.
Cowork cannot call `/admin/approve`; an operator approves out of band. Supply the
run id explicitly when asking Cowork to call `squad_status`.

For runs longer than the HTTP budget, enable the server-side worker and durable
Table run state. Do not keep a Cowork tool call open while waiting for approval.

## Security and governance

- The connector uses `OAuthPluginVault`; every user completes consent.
- The agent receives ordinary `Squad.*` tool scopes, never `Squad.Operate`.
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
- The folder is authoritative. Server memory is partitioned by authenticated
  tenant plus the explicit project slug, and project id/storage conflicts are
  rejected before inference.
- Cowork must materialize every returned tracking update before advancing the
  manifest revision. A truncated or unavailable tracking delta requires
  reconciliation rather than silent continuation.
- All tools returned for the signed-in user are visible to Cowork. The skill
  names the tools it uses, but the server still controls the live surface.
- Clear, truthful runtime descriptions are essential. Cowork now consumes the
  descriptions served by the HTTP MCP endpoint.
- Feature changes are normally visible in a new session, after runtime validation.
- A synchronous tool still needs to finish within Cowork's tool-call budget.
- Approval remains external and cannot be inferred from a user prompt or tool
  output.
- HVE's remote tools are advisory. Repository changes, tracker writes, and
  deployments require separately configured Cowork or connector capabilities.
