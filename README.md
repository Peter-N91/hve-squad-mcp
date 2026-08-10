<p align="center">
  <img src="docs/assets/logo.svg" alt="hve-squad-mcp logo" width="120" height="120" />
</p>

# hve-squad MCP server

An outbound [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes the **hve-squad** as coarse, model-invocable tools (five per-role intent tools plus `squad_federate` for the opt-in federation of sub-squads) so MCP hosts can call the squad directly.

This is the outbound inverse of the squad's existing inbound MCP template (`squad-src/.github/skills/squad/mcp.template.json`, which registers servers the squad *consumes*). This package ships the squad's *own* server, which other hosts consume.

**Documentation:** <https://peter-n91.github.io/hve-squad-mcp/> · **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) · **License:** [MIT](LICENSE)

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
| `squad_research` | research, investigate, explore | Squad Researcher | auto |
| `squad_plan` | plan, break down, sequence | Squad Lead | confirm |
| `squad_review` | review, validate, check quality (+ council go/no-go) | Squad Reviewer (+ council) | auto / confirm |
| `squad_architect` | architecture, system design, components | System Architecture Reviewer | auto |
| `squad_run` | full classify-and-dispatch pipeline (catch-all) | Squad Coordinator | confirm + gates |
| `squad_federate` | federation meta layer: route across named sub-squads (catch-all) | Squad Federation Coordinator | confirm + gates |

Every tool's input mirrors the `/squad` prompt arguments: `request` (required), plus optional `profile`, `tier`, `owner`, `mode`, and `context`. All tools also accept an optional `squad` sub-squad name to target a federation sub-squad; `squad_federate` additionally accepts `init` to build a federation (or add a sub-squad to an existing one) and `promote` to adopt an existing single squad into a federation as its first sub-squad.

`init` and `promote` are always **confirmation-gated** here: they propose, and a human confirms. The squad also has an unattended bootstrap — Watch Mode auto-promotes or auto-expands a federation and seeds an event-named sub-squad (`issue-123`, `pr-456`) without asking — but that waiver is bounded by things only a repository event supplies: a `squad/*` label or `/squad` keyword opt-in, a write-collaborator check, and a name derived purely from event metadata. This server is not that trigger, so no MCP call can take that path, and a request claiming event provenance confers nothing.

Beside these six catalog tools the remote surface serves **synthetic** tools that are not squad routing intents (so they are not in `tools.catalog.yml` and do not participate in the generator drift check). Each has its own least-privilege scope and its own operator flag:

| Tool | Scope | Enabled by | What it does |
| --- | --- | --- | --- |
| `squad_status` | `Squad.Run` | `SQUAD_MCP_REMOTE_PIPELINE_ENABLED` | Poll an async run by id. |
| `squad_render_pptx` | `Squad.Render` | `SQUAD_MCP_ENABLE_RENDER_PPTX` | Render content YAML to a `.pptx` download link. |
| `squad_memory_read` / `_write` / `_sync` | `Squad.Memory` / `Squad.MemoryWrite` | `SQUAD_MCP_ENABLE_MEMORY` | Read / CAS-write / batch-flush the project's own squad memory. |
| `squad_business_plan` | `Squad.Business` | `SQUAD_MCP_ENABLE_BUSINESS_TOOLS` | A plain-language business plan for a non-technical stakeholder. |
| `squad_backlog` | `Squad.Backlog` | `SQUAD_MCP_ENABLE_BUSINESS_TOOLS` | A **validated JSON** backlog contract for the native ADO/Jira connectors. |

### Federation (sub-squads)

`hve-squad@0.10.x` added an opt-in **federation**: one repository can host several named sub-squads (for example a `product` sub-squad for the business team and an `azure` sub-squad for the architects), each an ordinary squad rooted at `.copilot-tracking/squad/members/<name>/`. The server surfaces this two ways:

- **`squad_federate`** maps to the **Squad Federation Coordinator**. It reads the federation registry (`federation.md`) and meta-routing (`meta-routing.md`), routes the request to the matching sub-squad(s) — or the explicit `squad=<name>` — and runs each scoped to its own root. Pass `init` to build a federation (propose → confirm → create) on a fresh project or to add a sub-squad to an existing federation (Expansion Mode: seed `members/<new>/` and register it in `federation.md` + `meta-routing.md`), or `promote` to adopt an existing single squad (a top-level `team.md`) into a federation as its first sub-squad, relocating its state intact (propose → confirm → migrate → seed → route).
- **The `squad` input** on the five coarse tools targets a single sub-squad directly (`squad_research` with `squad=azure` scopes to `members/azure/`).

Federation is additive: on a plain repository (no `federation.md`) the `squad` input is simply omitted and every tool behaves as before. Autonomy modes are forwarded to a single targeted sub-squad; with `mode=autopilot` and no `squad=` target, `squad_federate` runs a coordinated **federation-wide autopilot** meta-pipeline across sub-squads (ordered inner autopilot runs, federation-level gates attributed to the raising sub-squad, one aggregate `cost-ceiling`, and a single consolidated final-outcome validation).

**Federation over the remote boundary.** `squad_federate` is reachable from Copilot Studio when the operator enables the gated pipeline (`SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true`). It is the same safety class as `squad_run` — a gated catch-all — so it inherits the same rules: it holds at the non-bypassable Human Gate, returns a run id, and is released out-of-band via `POST /admin/approve` before `squad_status` drives it to a finished federation decision. It requires its own **`Squad.Federate`** scope, deliberately separate from `Squad.Run`, and its `squad` / `init` / `promote` / `mode` inputs are persisted with the run so they survive the approve → poll cycle. Server-side it runs as a Federation Coordinator advisory stage: the routing decision, the per-sub-squad plan, dependencies, and federation-level gates as finished text. The scoping directive is composed only from validated inputs; the caller's free text stays delimited DATA.

### Requirements intake gate

`hve-squad@0.10.3` added a conditional **intake gate**: when a run is grounded in requirement or input artifacts (a PRD, BRD, spec, user story, design doc, transcript, or a referenced file), the coordinator validates those inputs for completeness, clarity, testability, consistency, and scope **before** it plans or builds, recording an `## Intake Readiness Verdict` (`Ready`, `Ready-With-Gaps`, `Not-Ready`) in `decisions.md`. On `Not-Ready` it runs a bounded auto-remediation loop (dispatch the analyst/product-owner to fill the blocking gaps, then re-validate; capped at two cycles) and escalates when a gap needs a human decision.

The server surfaces the gate in the **delegated (local VS Code)** path: the coordinator persona's gate context now instructs the host to run the intake gate ahead of the Implementation Gate whenever a request is requirements-driven. The gate maps to a new `intake-validator` role that reuses existing agents by input type (Product Manager Advisor by default; PRD/BRD Quality Reviewer; Squad Challenger), shipped with the `product` and `full` profiles. The gate is conditional and additive &mdash; with no input artifacts in scope it is a silent no-op.

The **embedded/advisory pipeline** (`squad_run`) now carries the gate too: `route()` prepends an intake stage for any profile that seeds `intake-validator` (`product`, `full`), and the pipeline records an `## Intake Readiness Verdict` before dispatching a downstream role. A `Not-Ready` verdict **halts the run** (`reason: "intake_not_ready"`) rather than letting the plan and deliverable stages build on inputs the validator just rejected; an unreadable verdict line degrades to `Ready-With-Gaps` rather than to `Ready`.

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

## Squad memory — automatic, and portable beyond Azure

The shared-state broker exposes the project's own `.copilot-tracking/squad/` memory as tenant-isolated MCP resources plus compare-and-swap write tools (`SQUAD_MCP_ENABLE_MEMORY=true`). Two additions make it usable by a business user in Copilot Studio.

**Automatic continuity (`SQUAD_MCP_MEMORY_AUTO_ENABLED=true`).** Memory used to work only if the agent remembered to call the memory tools with a project name it invented — unreliable under generative orchestration, and different every session. With auto-memory on, the server does it: before each embedded dispatch it reads the resolved project's `state` and `decisions` and injects them as **delimited DATA** (never authority, so memory cannot act as instructions); after a completed dispatch it writes the artifact to `history/<toolId>-<runId>` and appends a digest line to `state` under CAS with a bounded retry. The partition comes from a pinned federation sub-squad, else `SQUAD_MCP_MEMORY_DEFAULT_PROJECT` — never from caller free text, so continuity is reproducible and a caller cannot land memory in an arbitrary partition. Reads are capped so unbounded history cannot blow the context window, and a memory outage degrades the run to "no continuity" rather than failing it.

**Choose where memory lives.** `SQUAD_MCP_MEMORY_BACKEND` accepts:

| Backend | Persistence | CAS | Notes |
| --- | --- | --- | --- |
| `file` | local directory | in-file version+hash | single-replica / dev |
| `table` | Azure Table Storage | ETag | multi-replica / production |
| `graph` | **SharePoint document library or OneDrive** via Microsoft Graph | native `eTag` + `If-Match` | one readable `.md` per entry at `<rootPath>/<tenantId>/<project>/<path>.md` |

The `graph` backend keeps content **plaintext by default** — the point of a SharePoint target is that a human can open, review, and search the file — so encryption there is an explicit opt-in (`SQUAD_MCP_MEMORY_GRAPH_ENCRYPT=true`). The app identity needs an application permission on the target drive; [host/infra/graph-memory-permissions.bicep](host/infra/graph-memory-permissions.bicep) provisions it as least privilege — `Sites.Selected` (which grants no site access on its own) plus a write grant on the single designated site — so the server can reach only the library the operator chose. It is a separate, admin-run deployment so routine app deploys never need Graph admin rights.

A deployment can offer **several destinations at once** with `SQUAD_MCP_MEMORY_TARGETS` (a JSON array of named destinations) plus `SQUAD_MCP_MEMORY_DEFAULT_TARGET`. The memory tools then accept an optional `target` naming one of them. The operator owns every credential-bearing field — drive ids, storage accounts, directories — and the caller only ever sees an opaque name, the same allow-list pattern already used for model endpoints. An undeclared name is rejected before any I/O and never silently falls back to the default. Tenant isolation is unaffected: selecting a target changes *where* memory is written, never *whose* memory is reachable.

## Business-user surface (Copilot Studio and Teams)

`SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true` adds two tools aimed at non-technical users:

- **`squad_business_plan`** — turns an idea or brief into a fixed-section, plain-language business plan (summary, problem and customer, proposed solution, value and success measures, scope, go-to-market, cost outline, risks, milestones, open questions). The fixed section order means successive runs are comparable and the agent can quote a section back to the user.
- **`squad_backlog`** — turns a request, business plan, or requirements document into a **validated JSON backlog contract**: epics → user stories with Given/When/Then acceptance criteria → tasks, plus a flattened `workItems[]` carrying stable `ref` / `parentRef` ids.

`squad_backlog` is the piece that makes the Azure DevOps / Jira flow reliable. The native connector needs one call per work item with typed fields, so a prose handoff forces the orchestrator to parse English — the dominant failure mode (one giant work item, lost acceptance criteria, invented parents). With the JSON contract the agent iterates `workItems` in order, creates parents first, and links children by matching `parentRef` against the ids it recorded — no title matching, no guessing. The server validates and normalizes the model's JSON and fails cleanly if it cannot, so the agent never receives half-parsed output.

**The trust boundary is unchanged.** Neither tool writes to Azure DevOps or Jira. This server produces the plan; the certified native connector performs every write on the end user's own connection, under that connector's auth, DLP, and throttles. See [.copilot-tracking/changes/2026-07-24/scenario-a-copilot-studio-ado-jira-runbook.md](.copilot-tracking/changes/2026-07-24/scenario-a-copilot-studio-ado-jira-runbook.md) for the operator runbook, and the generated [agent-instructions.md](generated/copilot-studio-connector/README.md) for the paste-ready Copilot Studio instructions block.

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
- Dual-mode decision record: [docs/planning/adrs/0001-dual-mode-mcp-exposure-delegated-vs-embedded.md](docs/planning/adrs/0001-dual-mode-mcp-exposure-delegated-vs-embedded.md) (delegated vs embedded, trust boundary, ARCH-1/ARCH-2).
- IaC: [host/infra/main.bicep](host/infra/main.bicep) · connector: [generated/copilot-studio-connector/README.md](generated/copilot-studio-connector/README.md).
- Conformance (security) proof: `test/conformance/` (auth rejection, cross-tenant, gate carry-through, remote async, pipeline exposure).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The short version: never edit `CHANGELOG.md` or the `version` in `package.json` — add a fragment with `npm run change` instead, and CI resolves the release from the fragments on `main`.

This repository is **public**. Never commit a tenant id, subscription id, resource endpoint, or secret. Report a vulnerability privately through [GitHub Security Advisories](https://github.com/Peter-N91/hve-squad-mcp/security/advisories/new), not a public issue.

## License

MIT — see [LICENSE](LICENSE). The bundled cast under `host/cast/.github/` is redistributed content and each file remains under the license of its originating project; see [NOTICE](NOTICE).
