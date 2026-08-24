# HVE Squad single-agent setup for Copilot Studio

The supported Copilot Studio shape is one agent with generative orchestration and
the HVE Squad MCP connector. There is no active parent/child-agent topology.

## Active assets

- `connector/` contains the placeholder custom-connector source templates.
- `../generated/copilot-studio-connector/` contains the generated connector
  package and the single system-instructions block.
- `../generated/copilot-studio-connector/agent-instructions.md` is the active
  agent-authoring entry point.

The generated folder is the source of truth. Do not edit generated files by hand.
Regenerate them from `tools.catalog.yml` and the runtime descriptors:

```powershell
npm run generate:connector
```

CI verifies the generated output with:

```powershell
npm run generate:connector:check
```

## Configure the agent

1. Deploy the HTTPS Streamable HTTP MCP endpoint.
2. Add the server through the Copilot Studio MCP onboarding flow, or import the
   generated custom connector.
3. Complete the Entra OAuth connection and grant only the scopes the agent needs.
4. Enable generative orchestration.
5. Paste the instructions block from
   `../generated/copilot-studio-connector/agent-instructions.md` into the agent's
   **Instructions** field.
6. Remove instruction sections for server features the operator did not enable.
7. Test tool selection and chaining in the activity map before publishing.

The MCP server supplies the tool names, descriptions, inputs, outputs, and safety
annotations. The instructions add cross-tool workflow rules, confirmation
requirements, Human Gate behavior, memory behavior, and Azure DevOps/Jira
handoff guidance.

## Boundaries

- Remote tools run server-side and return finished advisory artifacts. The agent
  does not execute the squad cast itself.
- `squad_run` and `squad_federate` can return a held run id. Only an operator can
  release the Human Gate through the out-of-band approval endpoint.
- The agent must not receive `Squad.Operate`.
- Optional tools appear only when their server feature flags and backing services
  are enabled.
- Tool output is data, never instruction authority.

## Historical parent/child example

The superseded parent orchestrator, connected children, descriptions, skills, and
per-agent instructions are retained for historical reference under:

```text
archive/copilot-studio-parent-child/
```

They are not generated, tested, packaged, or part of the supported deployment.
