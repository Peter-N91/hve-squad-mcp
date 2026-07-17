# hve-squad MCP server

An outbound [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes the **hve-squad** as coarse, model-invocable tools (five per-role intent tools plus `squad_federate` for the opt-in federation of sub-squads) so MCP hosts can call the squad directly.

This is the outbound inverse of the squad's existing inbound MCP template (`squad-src/.github/skills/squad/mcp.template.json`, which registers servers the squad *consumes*). This package ships the squad's *own* server, which other hosts consume.

## Status — what works today (read this first)

This server has **two execution modes**, at different maturity levels. Be precise about which one a claim refers to.

| Mode | Host | State | Behaves as the full APM package? |
| --- | --- | --- | --- |
| **Delegated** (stdio) | VS Code GitHub Copilot (local) | Works | **Yes** — VS Code dispatches the real deployed cast. Needs the built package + `apm install` of the cast; the npm package is currently `private`/unpublished. |
| **Embedded advisory hero tools** (`squad_research`, `squad_review`, `squad_plan`, `squad_architect`) | Copilot Studio (remote HTTP) | Works, deployable via [host/RUNBOOK.md](host/RUNBOOK.md) | **Advisory parity.** Each runs one server-side dispatch via Azure OpenAI, resolving the **real from-disk persona from the full bundled cast** (98 agents), under Entra auth, gates, tenant isolation and cost caps. Advisory (text) output only — no code execution or deploy. |
| **Embedded async advisory pipeline** (`squad_run`, `squad_status`) | Copilot Studio (remote HTTP) | **Works end-to-end; single-replica (file) or multi-replica (Azure Table)** | **Advisory parity — full cast, full advisory stages.** Data-driven routing runs research → plan → council → review → backlog over the real cast. Advisory (text) only; code-executing implement/deploy is a deferred execution expansion. |
| **Deterministic render** (`squad_render_pptx`) | Copilot Studio (remote HTTP) | Opt-in (`SQUAD_MCP_ENABLE_RENDER_PPTX=true`) | **First file-output tool.** Renders content YAML to a `.pptx` with in-image `python-pptx` and returns a short-lived Azure Blob **user-delegation SAS** download link (tenant-scoped path, SAS never logged, `Squad.Render` fail-closed scope, caller YAML is DATA). No model call. |

**The async pipeline (`squad_run`) runs the full advisory squad** — data-driven routing over the full bundled cast, sequencing research → plan → (council) → review → backlog-handoff and producing a finished, sectioned advisory artifact. It is **advisory parity**: finished text deliverables, not code-executing implement/deploy (that is a separate, deferred execution expansion). Specifics:

- **Off by default** (`SQUAD_MCP_REMOTE_PIPELINE_ENABLED=false`); the default remote surface is the advisory hero tools. Enabling the async pipeline requires a durable run-state backend.
- **Full cast + routing.** Requests are routed to the real roster roles (researcher → lead → council members → tester) resolved from the SHA-pinned 98-agent cast bundle; the council synthesizes a most-restrictive-wins Council Verdict (Go / Go-With-Conditions / Stop). It honors `mode` (interactive pauses per stage; `autopilot`/`autonomous` run to one compiled artifact).
- **Releasable by an operator.** `squad_run` holds at a non-bypassable Human Gate; an operator with the distinct `Squad.Operate` app role releases a held run via the out-of-band `POST /admin/approve` route (never a `tools/call`), after which a `squad_status` poll drives it to completion. Approvals are audited (approver + timestamp) and tenant-scoped.
- **Two run-state backends** (`SQUAD_MCP_RUN_STATE_BACKEND`): `file` (single-replica, local dir) or `table` (Azure Table Storage, cross-replica ETag compare-and-swap). The `table` backend + a store-backed approval channel make release visible across replicas, so a **multi-replica / scale-to-zero** deployment is supported (WI-06). Per-stage artifacts, the Council Verdict, and caller `request`/`context` are AES-256-GCM encrypted at rest when a key is configured.
- **Long runs (>240s)** are handled by an optional background **worker** (an ACA Job): with `SQUAD_MCP_WORKER_ENABLED=true` the status poll is read-only and the worker drives approved runs off the request path (WI-1b4-WORKER).

**Bottom line:** a consumer can deploy this and get the **full package locally in VS Code**, the **advisory hero tools in Copilot Studio today**, and — with the pipeline enabled — the **full advisory squad (routing + full cast + council) working end-to-end** as an async pipeline, single-replica (file) or multi-replica (Azure Table) with a background worker for long runs. Advisory scope is text deliverables only; **code-executing implement/deploy (a real tool-calling backend and a persistent workspace) is a deferred execution expansion** — do not represent that part as available.

> Distribution: local **stdio** (delegated) targets VS Code; the remote Streamable HTTP + Entra path (embedded) reaches Copilot Studio and is deployed per [host/RUNBOOK.md](host/RUNBOOK.md). M365 Copilot and Cowork are not targeted yet.

## The tools

Each per-role tool maps 1:1 to a routing-table intent row in `squad-routing.instructions.md` (not to one of the ~200 agents); `squad_federate` maps to the Squad Federation Coordinator and drives the opt-in federation meta layer. The Squad Coordinator owns routing; these tools are shortcuts into it.

| Tool | Routing intent | Primary role | Tier |
| --- | --- | --- | --- |
| `squad_research` | research, investigate, explore | Task Researcher | auto |
| `squad_plan` | plan, break down, sequence | Task Planner | confirm |
| `squad_review` | review, validate, check quality (+ council go/no-go) | Task Reviewer (+ council) | auto / confirm |
| `squad_architect` | architecture, system design, components | System Architecture Reviewer | auto |
| `squad_run` | full classify-and-dispatch pipeline (catch-all) | Squad Coordinator | confirm + gates |
| `squad_federate` | federation meta layer: route across named sub-squads (catch-all) | Squad Federation Coordinator | confirm + gates |

Every tool's input mirrors the `/squad` prompt arguments: `request` (required), plus optional `profile`, `tier`, `owner`, `mode`, and `context`. All tools also accept an optional `squad` sub-squad name to target a federation sub-squad; `squad_federate` additionally accepts `init` to build a federation.

### Federation (sub-squads)

`hve-squad@0.10.x` added an opt-in **federation**: one repository can host several named sub-squads (for example a `product` sub-squad for the business team and an `azure` sub-squad for the architects), each an ordinary squad rooted at `.copilot-tracking/squad/members/<name>/`. The server surfaces this two ways:

- **`squad_federate`** maps to the **Squad Federation Coordinator**. It reads the federation registry (`federation.md`) and meta-routing (`meta-routing.md`), routes the request to the matching sub-squad(s) — or the explicit `squad=<name>` — and runs each scoped to its own root. Pass `init` to build a federation (propose → confirm → create).
- **The `squad` input** on the five coarse tools targets a single sub-squad directly (`squad_research` with `squad=azure` scopes to `members/azure/`).

Federation is additive: on a plain repository (no `federation.md`) the `squad` input is simply omitted and every tool behaves as before. Autonomy modes are forwarded to a single targeted sub-squad; with `mode=autopilot` and no `squad=` target, `squad_federate` runs a coordinated **federation-wide autopilot** meta-pipeline across sub-squads (ordered inner autopilot runs, federation-level gates attributed to the raising sub-squad, one aggregate `cost-ceiling`, and a single consolidated final-outcome validation).

## Execution model — delegated (local VS Code)

The Step 0.1 delegated-drive spike validated this path (Question A = PASS): VS Code Copilot auto-invokes the tool and drives its own in-host dispatch loop. The spike was a disposable de-risking exercise; it is **not** shipped with the package (it is git-ignored — see `.gitignore`). In the delegated (local) mode the server runs **no model**; it returns:

- `systemPrompt` — the Squad Coordinator persona plus the squad instruction context relevant to the matched intent;
- `matchedRouting` — the routing row (role, tier, council, gates);
- `framedRequest` — the request framed as a dispatch instruction (do not answer inline; dispatch the matched role);
- `stateContext` — the squad state root and per-turn inputs.

The VS Code host ingests this and runs its own `runSubagent`/`task` loop to dispatch the cast — the same path the squad uses today, now reachable as a model-invocable tool instead of only the `/squad` slash command.

## Execution model — embedded (remote / Copilot Studio)

Over the remote Streamable HTTP `/mcp` boundary the server runs the squad stage **server-side** (embedded) and returns a finished, `squad-guided / embedded` artifact. This is the mode a Copilot Studio agent consumes. Deploy it with [host/RUNBOOK.md](host/RUNBOOK.md).

- **Hero tools** (`squad_research`, `squad_review`) — each runs a single server-side dispatch through the operator-configured Azure OpenAI endpoint, behind Entra audience-bound auth (SEC-1), per-tool scopes (SEC-2), strict Origin allow-list (SEC-8), identity-bound sessions, a per-tenant ephemeral workspace with guaranteed teardown (SEC-4), charter-injection containment (SEC-5), and per-tenant concurrency + monthly cost caps (SEC-9 / COST-2). **This path works and is deployable.**
- **Async pipeline** (`squad_run` → held run id; `squad_status` → poll) — exposed only when the operator sets `SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true` with a durable run-state backend (`file` local dir, or `table` = Azure Table Storage for multi-replica). `squad_run` holds at a non-bypassable Human Gate; an operator releases a held run out-of-band via `POST /admin/approve` (distinct `Squad.Operate` role), then `squad_status` drives it to completion. Cross-replica release uses the Table backend's ETag compare-and-swap + a store-backed approval record; long runs (>240s) are driven by an optional worker ACA Job (`SQUAD_MCP_WORKER_ENABLED=true`). See the [status section](#status--what-works-today-read-this-first) for the remaining limit (2-stage slice).

The embedded and delegated modes share the same router, tool schema, and persona source of truth behind one `CoordinatorEngine` seam; the security model is enforced in `src/transports/http-core.ts`, `src/auth/`, and `src/engine/` and proven by the conformance suites under `test/conformance/`.

## Build and run

Requirements: Node.js >= 20 (developed on Node 24).

```bash
cd squad-mcp
npm install
npm run build      # tsc -> dist/
npm test           # router + delegated + generator unit tests
npm run generate   # regenerate generated/mcp-tools.schema.json (drift-fails on mismatch)
```

To start the server manually on stdio (it speaks JSON-RPC; logs go to stderr):

```bash
node dist/src/server.js
```

## Register in VS Code (delegated / local mode)

1. Build once (`npm install && npm run build`).
2. Copy the `servers` entry from `squad-src/.github/skills/squad/mcp-server.template.json` into your workspace `.vscode/mcp.json`.
3. Choose the command form:
   - published package: `npx -y @hve-squad/mcp`;
   - local build: `node` with an absolute path to `squad-mcp/dist/src/server.js`.
4. Reload VS Code. Ask Copilot to "research X with the squad"; the `squad_*` tools become available, and `squad_research` returns the delegated charter for Copilot to dispatch.

The package never writes your `.vscode/mcp.json` — the template is an example you copy.

## The manifest generator (drift check)

`generators/build-manifests.ts` reads the authored catalog plus the deployed squad sources — `squad-routing.instructions.md`, `squad-roster.instructions.md`, and the `*.agent.md` personas — all **read-only**, validates them against each other, and emits the runtime descriptor `generated/mcp-tools.schema.json`.

The build **fails (exit non-zero)** when a catalog tool maps to a routing intent that is not a real routing row, or to a role/council agent that is not an installed agent. Run it with `npm run generate`; wire it into CI to catch catalog/cast drift.

## Project layout

```text
squad-mcp/
  tools.catalog.yml             # SOURCE OF TRUTH for the 5-tool surface
  src/
    server.ts                   # entrypoint: catalog -> router -> engine -> transport
    paths.ts                    # locate package root + squad .github root
    catalog/catalog.ts          # parse + type the catalog
    router/router.ts            # tools/list + Ajv JSON Schema validation
    transports/stdio.ts         # stdio adapter (only per-transport code in P0)
    engine/
      coordinator-engine.ts     # the CoordinatorEngine seam (delegated | embedded)
      delegated.ts              # DelegatedCoordinator (local; no model)
      embedded.ts               # EmbeddedCoordinator (remote; server-side execution + async run)
      dispatch-loop.ts          # sequential multi-role pipeline over the model backend
      persona-loader.ts         # from-disk *.agent.md persona loader (single-source invariant)
      durable-run-state.ts      # durable run-state store (async run + status; single-replica)
      gates.ts                  # Human Gate, quota caps, auditable approval channel
      persona.ts                # paraphrased Coordinator persona + gate instructions
    transports/
      stdio.ts                  # stdio adapter (delegated / local mode)
      http-core.ts              # Streamable HTTP /mcp handler (auth, exposure, routing)
    auth/                       # Entra audience-bound auth + per-tool scopes
    config/operator-config.ts   # operator-controlled config (never caller-influenced)
  host/                         # remote deploy: Containerfile, ACA Bicep IaC, RUNBOOK, cast snapshot
  generators/build-manifests.ts # catalog <-> cast drift check + descriptor emit
  generated/                    # committed, regenerable runtime descriptor + Copilot Studio connector
  test/                         # unit + conformance (security) suites
```

## Additive-only

Everything here is new. The generator reads the existing squad sources read-only and never duplicates agent logic; no existing agent, prompt, instruction, or skill is edited. The single source of truth for tool descriptions and routing remains the deployed `.agent.md` personas and the `squad-*` instructions.

## Design references

- Remote deploy runbook: [host/RUNBOOK.md](host/RUNBOOK.md) (ACA + Entra + Copilot Studio connector).
- Dual-mode decision record: [docs/planning/adrs/0001-dual-mode-mcp-exposure-delegated-vs-embedded.md](../docs/planning/adrs/0001-dual-mode-mcp-exposure-delegated-vs-embedded.md) (delegated vs embedded, trust boundary, ARCH-1/ARCH-2).
- IaC: [host/infra/main.bicep](host/infra/main.bicep) · connector: [generated/copilot-studio-connector/README.md](generated/copilot-studio-connector/README.md).
- Conformance (security) proof: `test/conformance/` (auth rejection, cross-tenant, gate carry-through, remote async, pipeline exposure).
