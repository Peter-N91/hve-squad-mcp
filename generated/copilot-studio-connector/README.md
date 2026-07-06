<!-- markdownlint-disable-file -->
# Copilot Studio connector (generated)

> **Fidelity claim (locked):** squad-guided / embedded — NOT "squad-executed".
> The squad runs server-side under its gates and methodology and returns a finished
> artifact; the calling agent is guided by the squad, it does not itself execute the cast.

This connector is a **generated build artifact**. Regenerate it with
`npm run generate:connector`; do not edit by hand.

## Exposed tools (Phase 1b.4)

- `squad_research` — Squad Research (scope: `Squad.Research`)
- `squad_plan` — Squad Plan (scope: `Squad.Plan`)
- `squad_review` — Squad Review (scope: `Squad.Review`)
- `squad_architect` — Squad Architect (scope: `Squad.Architect`)
- `squad_run` — Squad Run (scope: `Squad.Run`)
- `squad_status` — Squad Status (scope: `Squad.Run`)
- `squad_render_pptx` — Squad Render PPTX (scope: `Squad.Render`)

> `squad_run` is the gated async pipeline: it returns a run id and pauses at the
> Human Gate. Poll `squad_status` with that run id to advance the run after an
> out-of-band approval and to retrieve the finished artifact. `squad_plan` and
> `squad_architect` are synchronous advisory tools (single-stage, no impactful action).

## Not targeted in the thin slice

- M365 / Agent 365 (deferred to Phase 1b — PROD-4)
- Microsoft Cowork (deferred to Phase 1b pending verification — PROD-3)

## Import

1. Replace `<SQUAD_MCP_HOST>`, `<ENTRA_TENANT_ID>`, `<ENTRA_CLIENT_ID>`, and
   `<SQUAD_MCP_AUDIENCE>` in `apiDefinition.swagger.json` / `apiProperties.json`.
2. In Copilot Studio, add a custom connector from the OpenAPI file (or use the MCP
   onboarding wizard) and complete the Entra OAuth 2.0 connection.
3. Enable generative orchestration on the agent so it can call the MCP tools.

See `host/RUNBOOK.md` for the full deploy + import steps and where real spend begins.
