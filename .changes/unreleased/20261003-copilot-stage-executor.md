---
bump: minor
type: Added
---

- **Advisory stages can run on the GitHub Copilot agent runtime instead of the
  built-in one (opt-in).** With `SQUAD_MCP_STAGE_EXECUTOR=copilot`, each
  tool-enabled stage drives a Copilot runtime (`copilot --headless`) in a
  separate, disposable Linux sandbox through the Copilot SDK, giving HVE agents
  Copilot's model selection, shell, file and web tools. The built-in runtime
  remains the default and stays vendor-neutral; the SDK is an optional
  dependency loaded only when selected (`src/engine/copilot/`, `host/sandbox/`).
- **The project persists across sandboxes.** The server is the runtime's
  session filesystem: `view`, `create` and `edit` on `/workspace` read and
  write the project artifact store directly, within the stage's write scope,
  create-only for unseen files and compare-and-swap after a read; server-side
  `list_project_files` and `search_project_files` find earlier artifacts; text
  files `bash` writes inside the write scope are copied back when the stage
  completes. The runtime's conversation log and checkpoints are kept in a
  server-side session-state store, so a stage that fails part-way resumes the
  same session in a new sandbox and can still cite evidence issued before.
- **The server keeps ownership of evidence and permissions.** Project reads
  earn `server_store` receipts hashed by the server, other tool output earns
  `sandbox_tool_output` receipts, and drafts, writes, failed commands and
  `bash` reads of project paths earn none; completion requires a stored primary
  artifact citing server-issued receipts. A deny-by-default permission handler
  admits only public `https` URLs (optionally an operator host allow-list),
  screens shell commands for metadata, private-network and credential paths,
  and never grants a sandbox bypass. A deadline, a model-call budget, bounded
  abort/disconnect calls, and a runtime liveness probe end the stage
  fail-closed.
- **Stages fan out pinned agents as parallel Copilot sub-agents.** A
  coordinator stage dispatches the agents its charter permits (read-only RPI
  Researcher lanes for research) through Copilot's `task` tool, and independent
  dispatches run side by side. The server attributes every sub-agent tool call
  through the tool hooks and keeps the built-in delegation rules: only pinned
  agents, at most six dispatches, the parent's artifact first, each writing
  sub-agent confined to its own delegate folder, no shell and no further
  fan-out for sub-agents, per-agent evidence and usage, no receipt for a
  sub-agent's reply, and no completion while a sub-agent runs or with an
  unreported gap. Set `SQUAD_MCP_COPILOT_SUBAGENTS=false` to turn it off.
- **The server owns the Copilot sign-in, so sandboxes never log in.** One
  server-held GitHub identity is supplied to every session through the SDK
  token provider and never enters the sandbox environment, logs, readiness
  responses, or stored session state. The server proves Copilot entitlement
  before it listens and refuses to start with a missing or rejected token; an
  unreachable sandbox only delays readiness, retried every 30 seconds. The
  identity is re-verified in the background, runtime token refreshes re-read
  the source so rotation needs no restart, a dropped sandbox connection is
  re-established, and stages are refused with `copilot_identity_unavailable`
  while the identity is not verified.
- **Platform probes.** `GET /healthz` reports liveness and `GET /readyz`
  answers 200 only when the Copilot identity is verified and the sandbox
  answers (503 otherwise), with per-check booleans only. With the built-in
  executor the instance is always ready. Logs also redact anything shaped like
  a GitHub token.
- **The sandbox image strips platform-injected variables.** Its entrypoint
  starts the Copilot runtime from an allowlisted environment, so identity
  endpoints and secret headers a hosting platform injects into every container
  never reach the agent's shell.
- **Cowork testing deployment.** `host/infra/main.bicep` gains an opt-in
  `enableCopilotSandbox` that runs the sandbox as a sidecar in the Container
  App, reads the GitHub token from the Key Vault secret `copilot-github-token`
  for the server only, gates traffic on a `/readyz` readiness probe, and pins a
  single replica. See "Optional: run agentic stages on GitHub Copilot" in
  `host/RUNBOOK.md` for the build, deploy and verification steps and the
  arrangement's limits.
- New settings: `SQUAD_MCP_COPILOT_CLI_URL` and a required 32-character
  `SQUAD_MCP_COPILOT_CONNECTION_TOKEN`; a required identity source, one of
  `SQUAD_MCP_COPILOT_GITHUB_TOKEN_COMMAND` (for example `gh auth token`),
  `SQUAD_MCP_COPILOT_GITHUB_TOKEN_FILE`, or `SQUAD_MCP_COPILOT_GITHUB_TOKEN`
  (selected with `SQUAD_MCP_COPILOT_GITHUB_TOKEN_SOURCE` when several are set);
  plus optional `SQUAD_MCP_COPILOT_IDENTITY_REVERIFY_MS`,
  `SQUAD_MCP_COPILOT_MODEL`, `SQUAD_MCP_COPILOT_TOOLS`,
  `SQUAD_MCP_COPILOT_ALLOW_SHELL`, `SQUAD_MCP_COPILOT_SUBAGENTS`,
  `SQUAD_MCP_COPILOT_ALLOWED_HOSTS`,
  `SQUAD_MCP_COPILOT_SANDBOX_WORKSPACE`, and
  `SQUAD_MCP_COPILOT_SESSION_STATE_DIR`. A sandbox binds to the first server
  that connects, so restart it with the server. Hosted multi-tenant use still
  needs a per-run sandbox, a replicated session-state store, an egress proxy,
  and per-user credentials; see `host/sandbox/README.md`.
