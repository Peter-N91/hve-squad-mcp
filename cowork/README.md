# HVE Squad dynamic MCP plugin for Microsoft Copilot Cowork

This is a connector-only Cowork plugin. It registers the remote HVE Squad MCP
server and lets Cowork discover the enabled tools at runtime.

The package deliberately contains:

- one `agentConnectors` entry;
- no `agentSkills`;
- no pinned `mcpToolDescription`.

With app manifest v1.29, Cowork connects to the server, sends `initialize`, and
calls `tools/list`. Tool additions, removals, descriptions, schemas, and safety
annotations therefore come from the deployed server rather than a copied file in
the plugin.

## Why this shape

The previous package projected the squad into one dispatcher skill plus ten stage
skills and pinned a generated tool-description file. That introduced two sources
of routing truth and required repackaging whenever the MCP surface changed.

Dynamic discovery makes the MCP server authoritative:

1. The operator enables server features.
2. The server exposes only those tools from `tools/list`.
3. Cowork validates and activates the discovered definitions.
4. Cowork selects tools from their names, descriptions, schemas, and annotations.

This does not reproduce the Copilot Studio parent/child-agent topology. It gives
Cowork direct access to the same coarse MCP tools instead.

## Layout

```text
cowork/
|-- manifest.json   # M365 app manifest v1.29; dynamic remote MCP connector
|-- color.png       # 192x192 icon
|-- outline.png     # 32x32 icon
|-- pack.ps1        # substitutes tenant values and writes the uploadable zip
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

### Phase 1: prove the list is dynamic

1. Enable one optional server feature, such as
   `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true`.
2. Deploy the server without changing or repackaging the Cowork plugin.
3. Start a new Cowork session.
4. Ask for a business plan and confirm Cowork can select
   `squad_business_plan`.
5. Disable the feature, redeploy, and confirm a new session no longer exposes it.

The plugin passes only if the tool surface follows the server without a manifest
change.

### Phase 2: gated runs

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
- Memory writes advertise `destructiveHint`; advisory and read tools advertise
  `readOnlyHint`; gated runs and rendering remain unclassified so the host does
  not treat them as read-only.

## Known constraints

- All tools returned for the signed-in user are visible to Cowork; there is no
  per-skill tool scoping because the package has no skills.
- Clear, truthful runtime descriptions are essential. Cowork now consumes the
  descriptions served by the HTTP MCP endpoint.
- Feature changes are normally visible in a new session, after runtime validation.
- A synchronous tool still needs to finish within Cowork's tool-call budget.
- Approval remains external and cannot be inferred from a user prompt or tool
  output.
