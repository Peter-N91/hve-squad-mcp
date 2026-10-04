# Copilot stage sandbox

`SQUAD_MCP_STAGE_EXECUTOR=copilot` runs tool-enabled HVE Squad stages through
the [GitHub Copilot SDK](https://github.com/github/copilot-sdk) instead of the
server's built-in runtime. The Copilot runtime runs here, in a disposable Linux
container acting as the agent's desktop. The MCP server stays outside it and
keeps the project.

```text
MCP server (trusted)                              copilot-sandbox (untrusted, per run)
  CopilotStageExecutor  ── JSON-RPC/TCP ──────►   copilot --headless :4321
    permission handler + tool hooks                 bash, glob, grep  -> scratch disk
    session filesystem provider  ◄── file I/O ───   view, create, edit -> /workspace
      /workspace/<path>  = project artifact store
      everything else    = runtime session state
    project tools, finish_stage, copy-back
```

The built-in runtime remains the default and stays vendor-neutral. This
executor is opt-in.

## The project survives every sandbox

The sandbox holds no project state. The Copilot runtime routes its file tools
and its own session state through a server-provided session filesystem, so:

| Agent operation | Where it lands |
|---|---|
| `view`, `create`, `edit` on `/workspace/<path>` | The project artifact store, directly. Reads are served by the server; writes are saved immediately, limited to the stage's write scope |
| `list_project_files`, `search_project_files` | Server-side tools over the same store |
| `bash`, `glob`, `grep` | The sandbox's scratch disk, which starts empty and is discarded |
| Text files `bash` writes under the write scope | Copied into the project by the server when the stage completes, unless a file tool already wrote the same path |
| Conversation log, checkpoints | The server's session-state store (`SQUAD_MCP_COPILOT_SESSION_STATE_DIR`) |

A later stage, or a later run, therefore sees earlier artifacts in a fresh
sandbox. A stage that fails part-way resumes the same Copilot session in a new
sandbox when it is rerun, and can still cite evidence issued before.

Two runtime behaviours shape the deployment, both measured against CLI 1.0.90:

* A runtime accepts **one** session-filesystem provider. One sandbox serves one
  trusted client; restart the server, start a fresh sandbox.
* The runtime exits about a minute after its last client disconnects.

## What the server still guarantees

| Guarantee | Where it is enforced |
|---|---|
| Writes only inside the stage's write scope, text artifacts only, create-only for unseen files and compare-and-swap after a read; no deletes or renames | Session filesystem provider |
| Copy-back limited to the write scope, UTF-8 text, 256 KB per file, 20 files, using server-built commands | Executor (`shell.executeUserRequested`) and provider |
| Completion requires a stored primary artifact citing server-issued evidence IDs | `finish_stage` handler |
| Evidence: project reads are `server_store` (hashed by the server); other tool output is `sandbox_tool_output`; drafts, writes, failed commands and `bash` reads of project paths earn nothing | Post-tool hook |
| Deny-by-default permissions: public `https` URLs only, screened shell commands, no sandbox bypass | Permission handler |
| Deadline, model-call budget, and bounded abort/disconnect | Executor |
| A runtime that stops answering fails the stage promptly | Liveness probe (`ping`) |

`sandbox_tool_output` evidence records what a sandbox tool returned; the
server does not re-fetch it, so it is weaker than the built-in runtime's
server-side retrieval.

## Run it locally

Requires Docker (for example in WSL) and a GitHub account with Copilot.

```bash
export COPILOT_CONNECTION_TOKEN=$(openssl rand -hex 32)
docker compose -f host/sandbox/compose.yaml up --build
```

Keep that command attached. On WSL the VM shuts down once no `wsl.exe` process
is attached, which kills the sandbox mid-stage; the executor's liveness probe
then fails the stage with `stage_runtime_unavailable` instead of hanging.

A runtime binds to the first client that registers as its session filesystem
and never accepts another, even after that client disconnects or its process
dies. Restart the sandbox whenever the server restarts (deploy them as one
unit, for example a sidecar in the same pod), and do not point the smoke script
at a sandbox the server is using. The server reports this case in its log with
that advice.

Then point the server at it:

| Variable | Value |
|---|---|
| `SQUAD_MCP_STAGE_EXECUTOR` | `copilot` |
| `SQUAD_MCP_COPILOT_CLI_URL` | `127.0.0.1:4321` |
| `SQUAD_MCP_COPILOT_CONNECTION_TOKEN` | the same token (at least 32 characters) |
| `SQUAD_MCP_COPILOT_GITHUB_TOKEN_COMMAND` | identity source: a command printing the token, run without a shell (for example `gh auth token`) |
| `SQUAD_MCP_COPILOT_GITHUB_TOKEN_FILE` | identity source: a file holding the token, re-read on rotation (for example a mounted secret) |
| `SQUAD_MCP_COPILOT_GITHUB_TOKEN` | identity source: the token itself |
| `SQUAD_MCP_COPILOT_GITHUB_TOKEN_SOURCE` | optional `env`, `file`, or `command` when several are set |
| `SQUAD_MCP_COPILOT_IDENTITY_REVERIFY_MS` | how often the identity is re-verified (default 600000) |
| `SQUAD_MCP_COPILOT_MODEL` | optional model id |
| `SQUAD_MCP_COPILOT_TOOLS` | optional built-in tool list |
| `SQUAD_MCP_COPILOT_ALLOW_SHELL` | `false` to remove `bash` |
| `SQUAD_MCP_COPILOT_SUBAGENTS` | `false` to stop stages fanning out pinned agents as sub-agents |
| `SQUAD_MCP_COPILOT_ALLOWED_HOSTS` | optional public host allow-list |
| `SQUAD_MCP_COPILOT_SESSION_STATE_DIR` | durable directory for runtime session state (default under the OS temp dir) |

The executor also requires `SQUAD_MCP_ENABLE_ARTIFACTS`,
`SQUAD_MCP_ENABLE_MEMORY`, `SQUAD_MCP_MEMORY_AUTO_ENABLED`, and exactly one
usable identity source.

## Sub-agent fan-out

A stage can fan out work to the pinned agents its charter permits, the same
set the built-in runtime allows: a research stage gets read-only RPI Researcher
lanes, and any other stage gets the agents listed in its `agents:` frontmatter.
Each one is registered as a Copilot custom agent. The coordinator dispatches
them with Copilot's `task` tool, and independent dispatches run in parallel in
the same sandbox, each as its own agent loop with its own context.

Copilot reports which sub-agent made a tool call only to the tool hooks; the
filesystem, permission and custom-tool callbacks all report the stage session.
The server therefore decides per-agent scope in the pre-tool hook, and refuses
any call it cannot attribute:

| Rule | Enforced by |
|---|---|
| Only the charter's pinned agents can be dispatched; Copilot's generic agents are refused | pre-tool hook on `task` |
| The coordinator writes its own artifact before dispatching | pre-tool hook on `task` |
| At most 6 dispatches per stage; an agent that writes files runs one instance at a time, read-only lanes run side by side | pre-tool hook on `task` |
| A writing sub-agent writes only `<stage folder>/delegates/<agent>/` (the BRD Quality Reviewer writes `<stage folder>/reviews/brd-quality-reviewer.md`); a research lane writes nothing | pre-tool hook on `create`/`edit` |
| The coordinator cannot write a sub-agent's paths; `bash` output there is not copied back | pre-tool hook, copy-back |
| Sub-agents get no shell and no `task` tool, so they cannot fan out further | custom-agent tool list and pre-tool hook |
| Each sub-agent's evidence receipts and model calls are attributed to it; a sub-agent's reply earns no receipt, so the coordinator cites the sources the sub-agent read | post-tool hook, usage events |
| The coordinator cannot finish while a sub-agent runs; a sub-agent that failed or left no artifact must be reported as a gap (`ready-with-gaps`) | `finish_stage` |

Each lane (agent, status, timing, writes and artifact hash) is recorded in the
stage's `.sources.json`. Copilot cannot resume sub-agents, so after the sandbox
is replaced a lane that was still running is recorded as interrupted; the
coordinator can dispatch it again within the same bound.

## The GitHub identity

The server owns one GitHub identity and hands it to every session through the
SDK's token provider, so a fresh sandbox never signs in and the token never
appears in the sandbox environment, where the agent's shell could read it. Do
not set `COPILOT_GITHUB_TOKEN` on the container. The image's entrypoint also
starts the runtime from an allowlisted environment (`PATH`, `HOME`, the
runtime cache, the connection token and optional proxy settings), so variables
a hosting platform injects into every container, such as a managed-identity
endpoint and its secret header, never reach the agent's shell.

* **Startup.** The server reads the token and proves Copilot entitlement (the
  model list, plus remaining premium quota for the log) before it listens. A
  missing, malformed, or rejected token stops startup. An unreachable sandbox
  does not: the server listens, reports not ready, and retries every 30 seconds
  until the identity verifies.
* **Sessions.** Each session asks for the token; the runtime asks again before
  the reported lifetime ends, and that refresh always re-reads the source, so a
  rotated token or a refreshed `gh` login is used without a restart.
* **Monitoring.** The identity is re-verified in the background. A revoked or
  expired login turns the instance not ready and is logged; stages are refused
  with `copilot_identity_unavailable` instead of failing inside the sandbox.
* **Probes.** `GET /healthz` answers 200 while the process serves.
  `GET /readyz` answers 200 only when the identity is verified and the sandbox
  answers, else 503; its body holds per-check booleans only, and reasons go to
  the server log. Point the platform's readiness probe at `/readyz` so traffic
  reaches an instance only when agents can run.

Tokens never reach logs, readiness responses, or persisted session state, and
the log redacts anything shaped like a GitHub token. The runtime still holds
the token in memory during a session, so prefer a short-lived token. One shared
account means shared quota and attribution, and Copilot seats are licensed per
person, so treat this as a testing arrangement.

`scripts/copilot-stage-smoke.ts` runs one real persona stage against the
sandbox without the HTTP server. Set `SMOKE_TOKEN_COMMAND="gh auth token"` to
use the production identity path (verify, then the token provider), or
`SMOKE_GITHUB_TOKEN` for a static per-session token, and `SMOKE_TRACE=1` to
print session events. Reusing `SMOKE_OUTPUT_DIR` across sandboxes exercises
project persistence, and rerunning a failed `SMOKE_RUN_ID` + `SMOKE_PERSONA`
exercises resume.

## Run it in Azure for Cowork testing

`host/infra/main.bicep` can run this sandbox as a sidecar of the deployed
Container App (`enableCopilotSandbox=true`), so Cowork exercises the Copilot
executor through the same MCP endpoint. Follow "Optional: run agentic stages on
GitHub Copilot" in `host/RUNBOOK.md`. The sidecar is a testing arrangement: it
shares the replica's network with the server and runs a single replica.

## Not production-ready

This deliberately stops short of a hosted deployment. Before serving other
users, add:

* a fresh sandbox per run, destroyed afterwards, never shared across tenants;
* a durable, replicated session-state store; the file store suits one server
  instance only;
* an allow-list egress proxy and a network-layer block on the cloud metadata
  endpoint, because the executor's checks cannot see DNS resolution or what an
  arbitrary shell command does;
* a private network between server and sandbox, so the runtime port is never
  reachable from elsewhere;
* per-user GitHub credentials, or a BYOK key served through a proxy the sandbox
  cannot read, because any credential handed to the runtime is reachable from
  the agent's shell.
