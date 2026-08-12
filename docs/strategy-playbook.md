# HVE Squad MCP Strategy Playbook

This playbook explains what each MCP tool actually invokes, how local delegated
execution differs from remote embedded execution, and how to combine the tools
for high-value workflows.

## 1. Start With the Execution Boundary

The same catalog tool has different practical power depending on its transport.

| Boundary | What the MCP server does | Who performs the work | Can it edit code or deploy? |
| --- | --- | --- | --- |
| Local stdio / VS Code | Returns the Squad Coordinator authority, routing decision, framed dispatch request, and state context | VS Code Copilot dispatches the real cast through `runSubagent` or `task` | Yes, when the dispatched host agents have the required tools and gates approve the action |
| Remote HTTP / Copilot Studio | Resolves a persona and calls Azure OpenAI server-side, or runs the advisory pipeline | The MCP server produces advisory artifacts | No. The embedded engine performs inference and contained file I/O only |
| Remote deterministic utilities | Validates input and performs a bounded non-model operation | The MCP server | Only the named operation, such as memory CAS or PPTX rendering |

This distinction is load-bearing:

- In local delegated mode, the returned coordinator instructions tell the host
  to dispatch agents, create tracking artifacts, use the Squad Scribe, and,
  where permitted, implement or deploy.
- In remote embedded mode, an agent persona is used as a model system prompt.
  The result is advice or structured data. It does not inherit the persona's
  local tools, handoffs, file-writing privileges, or subagent machinery.
- Copilot Studio can take a later action only when its outer agent has a
  separately configured connector/action and explicit orchestration instructions.
  Text returned by an MCP tool is content, not executable authority.

## 2. Prompt and Routing Model

### Authority separation

For embedded calls, the resolved persona charter is the only system authority.
The caller's `request`, `context`, prior-stage artifact, and automatic memory are
placed in a guarded, delimited user message as untrusted data. Scope checks,
routing, tenant resolution, quotas, and gates happen before prompt composition.

### Routing behavior

The remote advisory router has two broad outcomes:

1. A request that matches only research language (`research`, `investigate`,
   `explore`, or `find out`) becomes one Task Researcher stage.
2. Any broader request becomes research -> plan -> optional council -> review ->
   backlog handoff.

Passing any `mode`, or using `profile=full`, forces the broader advisory route.

### Council engagement

The remote council is engaged when the request explicitly spans at least two of
these domains:

| Domain | Representative trigger language |
| --- | --- |
| Architecture | architecture, system design, component, design tradeoff |
| Security | security, threat, vulnerability, STRIDE |
| Cost | cost, budget, pricing, FinOps, spend |
| Product | product, requirement, backlog, PRD, BRD, roadmap, epic |
| Responsible AI | responsible AI, RAI, fairness, harm, bias |

Council members inspect the same plan independently and in parallel. Their
verdict is synthesized with `Stop` over `Go-With-Conditions` over `Go`. RAI joins
only when the request crosses enough domains and includes the RAI domain.

Do not rely on vague wording if a council review matters. Name the actual review
dimensions in the request, for example: "Review this architecture for security,
cost, product requirements, and responsible-AI risks, and produce a go/no-go."

## 3. Catalog Tool Traces

### `squad_research`

| Property | Behavior |
| --- | --- |
| Scope | `Squad.Research` over HTTP |
| Persona | Task Researcher |
| Canonical charter | `host/cast/.github/agents/task-researcher.agent.md` |
| Local workflow | Coordinator dispatches Task Researcher, which delegates investigation to Researcher Subagent and consolidates evidence under `.copilot-tracking/research/` |
| Remote workflow | One model completion using the compact embedded Task Researcher charter |
| Output | Local: delegated dispatch package and host-created research artifact. Remote: concise evidence-based research markdown |
| Side effects | None remotely; local host may write research tracking files |

Use it when facts, repository evidence, constraints, alternatives, or unknowns
must be established before a decision. It is the cheapest and safest first move
for ambiguous work.

Best request shape:

```text
Investigate <specific question>. Establish the current state from <sources>,
compare <options>, identify constraints and unknowns, and recommend one approach.
Do not plan implementation yet.
```

Best next tools: `squad_architect` for design implications, `squad_plan` for an
implementation sequence, or `squad_review` to challenge the findings.

Avoid using it for a request that already needs a complete delivery sequence;
use `squad_run` or explicitly chain research into planning.

### `squad_plan`

| Property | Behavior |
| --- | --- |
| Scope | `Squad.Plan` over HTTP |
| Persona | Task Planner |
| Canonical charter | `host/cast/.github/agents/task-planner.agent.md` |
| Local workflow | Grounds a plan in research, creates plan/details/log artifacts, identifies parallel phases, and delegates validation to Plan Validator |
| Remote workflow | One model completion using the real Task Planner charter |
| Output | An implementation-oriented plan; remote output is advisory text only |
| Side effects | None remotely; local host may create planning artifacts |

Use it when the problem and selected direction are already sufficiently known.
Pass prior research or architecture decisions in `context`; separate calls do
not automatically thread artifacts unless automatic memory has captured them.

Best request shape:

```text
Create an implementation-ready plan for <outcome>. Use the attached research as
the evidence base. Separate user requirements from derived objectives, identify
dependencies and parallel phases, and include focused and final validation.
```

Best next tools: `squad_review` for plan validation or local `squad_run` for
execution. In remote mode, `squad_run` will create another plan rather than
execute this plan, so pass the plan in `context` and ask for review/refinement.

Avoid planning directly from an underspecified idea. Use `squad_research` or
`squad_business_plan` first.

### `squad_review`

| Property | Behavior |
| --- | --- |
| Scope | `Squad.Review` over HTTP |
| Persona | Task Reviewer |
| Canonical charter | `host/cast/.github/agents/task-reviewer.agent.md` |
| Local workflow | Reviews plan/change/research artifacts, dispatches phase validators and an Implementation Validator, runs validation commands, and produces a severity-ordered review log |
| Remote workflow | One Task Reviewer model completion |
| Direct-tool council behavior | Local delegated instructions may add council for go/no-go or multi-domain requests. Remote direct `squad_review` does not run the parallel council; use `squad_run` for the implemented remote council stage |
| Side effects | None remotely; local host may create review artifacts and run checks |

Use it after there is a concrete artifact to inspect: a plan, design, change set,
requirements document, or result. Put that artifact or a precise reference in
`context` and state the acceptance criteria.

Best request shape:

```text
Review the supplied <plan/change/design> against <requirements and standards>.
Lead with severity-ordered findings, cite evidence, state a verdict, and identify
the smallest corrective actions. Do not redesign unrelated areas.
```

Use `squad_run` instead when a remote, multi-domain council verdict is required.

Avoid asking for a "review" without supplying the reviewed object and criteria.
The local charter expects tracking artifacts; remote inference cannot discover
an external artifact unless it is included in the call context.

### `squad_architect`

| Property | Behavior |
| --- | --- |
| Scope | `Squad.Architect` over HTTP |
| Persona | System Architecture Reviewer |
| Canonical charter | `host/cast/.github/agents/system-architecture-reviewer.agent.md` |
| Local workflow | Discovers constraints, confirms two or three review focus areas, evaluates relevant well-architected pillars, compares tradeoffs, and can hand off ADR creation or planning |
| Remote workflow | One model completion using the real architecture charter |
| Output | Architecture review and recommendations; no remote ADR write |
| Side effects | None remotely; local host may create ADRs through a handoff |

Use it for system boundaries, integration choices, deployment topology, data
stores, reliability, performance, operational design, or major technology
decisions. Supply scale, team maturity, budget, compliance, and the motivating
decision in `context`; the charter is intentionally context-hungry.

Best request shape:

```text
Review the architecture for <system>. Constraints: <scale, budget, compliance,
team, existing decisions>. Focus on <2-3 concerns>. Compare viable options,
recommend one, state consequences, and identify decisions that require ADRs.
```

Best next tools: `squad_plan`, then `squad_run` for a multi-domain council review.

Avoid treating `squad_architect` as a generic diagram generator or detailed
implementation planner. Its strength is decision quality and tradeoff analysis.

### `squad_run`

| Property | Local stdio | Remote HTTP |
| --- | --- | --- |
| Scope | Local trust boundary | `Squad.Run` |
| Authority | Full Squad Coordinator charter | Server-side advisory router and resolved stage personas |
| Workflow | Coordinator can run intake -> research -> plan -> council -> implement -> review -> final validation, subject to host tools and gates | research -> plan -> optional council -> review -> backlog handoff; no implementation |
| Gate | Coordinator's local gate protocol | Always starts held; operator releases via `POST /admin/approve` with `Squad.Operate` |
| Result | Host-executed artifacts and potentially code changes | Compiled advisory artifact |

Use it when the request is genuinely end-to-end, benefits from cross-stage
artifact threading, or needs the remote council. It is more expensive and slower
than a focused tool, so do not use it as the default for every question.

Remote modes:

- No mode normalizes to interactive stage behavior inside the advisory
  orchestrator, though the durable HTTP run is still controlled through the
  held-run/status workflow.
- `mode=autopilot` runs the advisory stages to one compiled artifact after
  operator release.
- `mode=autonomous` currently follows the same remote advisory advance behavior;
  it does not gain a code-executing validator loop over HTTP.

Best remote request shape:

```text
Produce an end-to-end advisory package for <outcome>: research the current state,
create a delivery plan, review the plan for architecture, security, cost, and
product fit, synthesize a go/no-go council verdict, validate the result, and
produce a backlog handoff. Constraints: <...>.
```

After starting a remote run, retain the returned run ID, wait for an operator to
approve it out of band, then call `squad_status` until terminal.

Avoid claiming that remote `squad_run` implemented or deployed anything. It did
not. Also avoid invoking it when one specialist call would answer the question.

### `squad_federate`

| Property | Local stdio | Remote HTTP |
| --- | --- | --- |
| Scope | Local trust boundary | `Squad.Federate` |
| Persona | Full Squad Federation Coordinator | Federation Coordinator advisory persona/directive |
| Workflow | Routes to real sub-squads and runs each scoped coordinator protocol | Produces a federation routing decision, per-sub-squad work plan, dependencies, risks, and gates as text |
| Gate | Confirmation rules in the local coordinator | Same held-run/operator-approval workflow as `squad_run` |
| Side effects | Local `init`/`promote` can mutate squad state after confirmation | No federation state mutation; advisory only |

Use it only when one repository truly has independently owned domains or teams
that need separate rosters, state, decisions, and routing. Prefer a single squad
until ownership or specialization makes the extra coordination worthwhile.

Inputs:

- `squad=<name>` pins one registered sub-squad.
- `init=true` proposes a new federation, or expands an existing one.
- `promote=true` proposes adoption of an existing single squad.
- `mode=autopilot` without a pinned squad requests federation-wide sequencing.

Best request shape:

```text
Coordinate <outcome> across the product, platform, and security sub-squads.
Assign ownership, order dependencies, identify cross-squad gates, and consolidate
one decision. Do not merge their responsibilities.
```

Avoid federation for simple role specialization inside one team; the normal
coordinator already routes among many roles.

## 4. Synthetic Tool Traces

### `squad_status`

- Scope: `Squad.Run`.
- Availability: only when the remote pipeline is enabled.
- Persona/model: none by itself.
- Input: the server-issued `runId`.
- Workflow: reads tenant-scoped run state. Before approval it reports `held`.
  After approval it either drives the claimed run on the polling request or,
  when worker mode is enabled, reads progress produced by the background worker.
- Side effect: a poll may advance an approved run in non-worker mode.

Use it only after `squad_run` or `squad_federate`. Preserve the run ID in the
outer agent's conversation state. Apply bounded polling with backoff; do not
start duplicate runs because a previous one is still held.

### `squad_business_plan`

- Scope: `Squad.Business`.
- Availability: `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true`.
- Persona: BRD Builder plus a fixed output contract.
- Canonical persona: `host/cast/.github/agents/brd-builder.agent.md`.
- Workflow: one embedded model call. Produces exactly ten sections: Summary,
  Problem and Customer, Proposed Solution, Value and Success Measures, Scope,
  Go-to-Market, Cost and Effort Outline, Risks and Dependencies, Milestones,
  and Open Questions.
- Side effects: no business-system write; automatic memory may archive the result.

Use it to turn an idea, opportunity, meeting outcome, or rough brief into a
sponsor-readable decision artifact. Explicitly ask it to mark assumptions and
decision gaps.

Best sequence: `squad_research` for market/technical evidence ->
`squad_business_plan` with that evidence -> stakeholder decision ->
`squad_backlog`.

Do not use it as an architecture design or detailed delivery plan.

### `squad_backlog`

- Scope: `Squad.Backlog`.
- Availability: `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true`.
- Persona: Functional Planner plus a strict JSON output contract.
- Canonical persona: `host/cast/.github/agents/functional-planner.agent.md`.
- Workflow: one embedded model call followed by server-side JSON extraction,
  validation, normalization, hard caps, and depth-first flattening.
- Output: `summary`, hierarchical `epics`, and ordered `workItems` with stable
  `ref` and `parentRef` identifiers.
- Side effects: none in Azure DevOps or Jira.

Use it only after scope is settled enough to decompose. Feed it the approved
business plan, architecture decisions, non-functional requirements, definition
of done, and explicit exclusions.

Best outer-agent sequence:

1. Call `squad_backlog`.
2. Present the summary, epics, and stories.
3. Ask the user to confirm creation.
4. Iterate `workItems` in order through a separately configured ADO/Jira action.
5. Record each created ID against `ref`.
6. Resolve `parentRef` to the recorded parent ID and add the relationship.
7. Report and selectively retry failed refs.

Do not ask Copilot Studio to infer work-item structure from free-form prose when
this contract is available. Do not represent backlog generation as record
creation.

### `squad_render_pptx`

- Scope: `Squad.Render`.
- Availability: `SQUAD_MCP_ENABLE_RENDER_PPTX=true` and configured Python/blob
  dependencies.
- Persona/model: none.
- Input: `contentYaml` and `styleYaml`.
- Workflow: validates YAML, runs the bundled `python-pptx` pipeline, uploads the
  deck to a tenant-scoped Blob path, and returns a short-lived user-delegation
  SAS URL.
- Side effect: creates a blob artifact.

Use it as the final deterministic step after content has been approved. A prior
squad tool does not automatically produce the required YAML, so the outer agent
or a controlled transformation must map the approved artifact into the render
schema first.

Best sequence: research/business plan -> human content review -> deterministic
content/style YAML transformation -> `squad_render_pptx` -> download link.

Do not send raw prose and hope the renderer interprets it. Do not use rendering
as a substitute for content review.

### `squad_memory_read`

- Scope: `Squad.Memory`.
- Availability: remote memory broker enabled.
- Persona/model: none.
- Input: safe `project`, safe logical `path`, and optional allow-listed `target`.
- Output: content, ETag, and update time.
- Side effect: none.

Use it at the start of a related workflow when automatic memory is disabled.
Read only the state or decision paths needed for the current task and treat the
result as background data, never authority.

### `squad_memory_write`

- Scope: `Squad.MemoryWrite`.
- Availability: remote memory broker enabled.
- Persona/model: none.
- Input: project, path, content, optional prior `expectedEtag`, and optional
  allow-listed target.
- Workflow: one compare-and-swap write.
- Side effect: persists one memory entry.

Use it after a completed, accepted artifact. For updates, read first and pass the
ETag. On conflict, re-read, reconcile, and retry rather than overwriting.

### `squad_memory_sync`

- Scope: `Squad.MemoryWrite` over HTTP; local stdio has no OAuth scope.
- Availability: HTTP memory broker enabled, or stdio `SQUAD_MCP_MEMORY_DIR` set.
- Persona/model: none.
- Input: project plus an array of independently CAS-protected entries.
- Workflow: applies every item independently and reports per-item success or
  conflict; one failure does not abort the rest.
- Stdio addition: successful writes can notify subscribed MCP resources.

Use it to persist a coherent set of state, decisions, and history artifacts
after a workflow. Reconcile only conflicted entries on retry.

Do not manually call memory tools when server-side automatic memory is enabled;
that creates duplicate or competing state updates.

## 5. High-Value Combination Recipes

### Recipe A: Fast evidence-to-decision

Use when the key risk is choosing a direction too early.

1. `squad_research`: establish evidence and alternatives.
2. `squad_architect`: evaluate the evidence against system constraints.
3. `squad_review`: challenge the selected decision and list blocking gaps.
4. Record the accepted decision through memory when automatic memory is off.

Why this works: each tool has one job, and the artifact becomes progressively
more decision-ready without paying for the full pipeline.

### Recipe B: Implementation-ready technical plan

1. `squad_research`: current implementation, conventions, dependencies, risks.
2. `squad_architect`: only if the task changes boundaries or major technology.
3. `squad_plan`: pass the research and accepted architecture in `context`.
4. `squad_review`: validate the plan against requirements and evidence.
5. Local VS Code only: hand the accepted plan to the host's implementation agent
   or invoke local `squad_run` under its gates.

Remote HTTP stops after step 4. It cannot implement the plan.

### Recipe C: Governed multi-domain proposal

1. Call remote `squad_run` with `mode=autopilot`.
2. Name at least two genuine council dimensions in the request.
3. Operator releases the held run out of band.
4. Poll with `squad_status`.
5. Inspect the Council Verdict and all conditions before downstream action.

Use this for architecture/security/cost/product decisions where a single
specialist would create blind spots.

### Recipe D: Idea to approved delivery backlog

1. `squad_research`: evidence, users, constraints, and comparable approaches.
2. `squad_business_plan`: convert evidence into a decision-ready plan.
3. Human decision: resolve open questions and approve scope.
4. `squad_backlog`: create validated epics, stories, tasks, and refs.
5. Human confirmation: approve record creation.
6. Outer Copilot Studio agent calls native ADO/Jira actions deterministically.
7. Persist the approved plan and resulting IDs in governed memory if appropriate.

This is the strongest Copilot Studio scenario because the boundary between
planning and action is structured and explicit.

### Recipe E: Executive deck from governed content

1. Produce content with `squad_business_plan`, `squad_research`, or `squad_run`.
2. Review and approve the content.
3. Transform the approved content into the renderer's YAML contract.
4. Call `squad_render_pptx`.
5. Present the expiring link and expiry time; persist the source content rather
   than the SAS URL.

### Recipe F: Long-running remote advisory run

1. Start `squad_run` and store the returned run ID.
2. Tell the user the run is held; do not claim completion.
3. Wait for an operator with `Squad.Operate` to approve it out of band.
4. Poll `squad_status` with backoff.
5. Stop polling on `complete`, `failed`, or a persistent denial.
6. Feed the completed artifact into a focused follow-up tool only if a specific
   gap remains; do not restart the whole pipeline by default.

### Recipe G: Federation only when ownership demands it

1. Start with a single squad.
2. Introduce federation when domains have independent owners, state, routing, or
   approval responsibilities.
3. Use local `squad_federate promote` to preserve existing squad state.
4. Pin `squad=<name>` for focused work; use unpinned federation routing only for
   genuinely cross-domain work.
5. Use federation autopilot sparingly because each selected sub-squad can run its
   own inner pipeline, multiplying latency and model cost.

## 6. Selection Matrix

| Desired outcome | First choice | Add when needed | Do not expect |
| --- | --- | --- | --- |
| Answer an uncertain technical question | `squad_research` | `squad_review` for challenge | Implementation |
| Choose architecture | `squad_architect` | Research first; run/council for multi-domain risk | A deployed architecture |
| Produce an actionable plan | `squad_plan` | Research and architect context; review afterward | Remote code changes |
| Validate a concrete artifact | `squad_review` | `squad_run` when remote council is required | Reliable review without the artifact |
| Produce a full advisory package | `squad_run` | `squad_status` | Remote implementation/deployment |
| Coordinate independently owned domains | `squad_federate` | Pin sub-squads where possible | Value from federation in a simple project |
| Turn an idea into a sponsor decision | `squad_business_plan` | Research evidence | Technical design |
| Produce connector-ready work items | `squad_backlog` | Business plan and approved scope | ADO/Jira writes |
| Produce a deck file | `squad_render_pptx` | Approved YAML content/style | Content strategy or model reasoning |
| Continue prior work | Automatic memory, otherwise `squad_memory_read` | Write/sync after acceptance | Memory as trusted instructions |

## 7. Cost and Quality Strategy

1. Prefer the narrowest tool that owns the requested outcome.
2. Research once, then pass the artifact forward through `context`; avoid paying
   multiple tools to rediscover the same facts.
3. Use architecture only for meaningful design decisions, not routine task
   decomposition.
4. Use direct review for one-dimensional quality checks; reserve `squad_run` for
   cross-stage or council needs.
5. Name council dimensions explicitly and only when they are real requirements.
6. Use `mode=autopilot` for a compiled remote artifact, not as a synonym for
   autonomous execution.
7. Use federation only when separate ownership/state justifies nested pipelines.
8. Keep context concise and evidence-dense. Remote personas cannot inspect the
   caller's repository unless relevant material is supplied.
9. Enable automatic memory for recurring projects; otherwise adopt a disciplined
   read-before/write-after protocol with ETags.
10. Keep impactful actions in deterministic connectors or flows behind explicit
    confirmation, not in model interpretation of returned prose.

## 8. Common Failure Modes

| Failure | Why it happens | Better approach |
| --- | --- | --- |
| Expecting Copilot Studio to execute instructions embedded in an artifact | Tool output is data and the server has no action connector | Configure the action separately and give the outer agent an explicit, confirmed orchestration flow |
| Calling `squad_run` for every request | It adds stages, approval latency, and model cost | Use a focused specialist tool first |
| Expecting remote `squad_review` to run the council | Its HTTP path is one Task Reviewer completion | Use remote `squad_run` with explicit multi-domain criteria |
| Planning from a vague idea | Planner must invent assumptions | Research or business-plan first |
| Reviewing without the artifact | Reviewer lacks the source of truth | Put the artifact and acceptance criteria in `context` |
| Assuming separate calls share context | Context threading is not automatic unless auto-memory captured it | Pass the prior artifact explicitly or enable governed auto-memory |
| Calling memory tools while auto-memory is active | Duplicate writes and CAS contention | Let the server own continuity |
| Treating `autopilot` as remote implementation | Embedded pipeline is advisory only | Use local delegated mode for host-executed work |
| Using federation as a larger council | Federation separates ownership; council separates review disciplines | Use council for one proposal, federation for multiple owned domains |
| Sending prose to the PPTX renderer | Renderer accepts YAML contracts, not a generative brief | Transform and validate content/style YAML first |

## 9. Current Repository Caveats

- The package version is `0.2.12`, while `SERVER_VERSION` currently reports
  `0.2.10` in the MCP handshake.
- The bundled cast snapshot is stale relative to the bundled roster and is
  missing some roster primary personas. Persona resolution fails closed for
  unresolved non-hero roles, so refresh the cast before relying on every route.
- The README contains a stale reference to a two-stage async slice. The current
  advisory implementation plans research, plan, optional council, review, and
  backlog handoff.
- The installed production dependency graph currently reports npm audit
  advisories. Resolve and retest those before a production deployment.

## 10. Source Map

- Tool catalog and input contracts: `tools.catalog.yml`
- HTTP exposure and dispatch: `src/transports/http-core.ts`
- Delegated framing: `src/engine/delegated.ts`
- Remote engine: `src/engine/embedded.ts`
- Routing classifier: `src/engine/routing.ts`
- Advisory stage orchestration: `src/engine/advisory-pipeline.ts`
- Council synthesis: `src/engine/council.ts`
- Persona loading: `src/engine/persona-loader.ts`
- Prompt containment: `src/engine/embedded-prompt.ts`
- Business output contracts: `src/engine/business-tools.ts`
- Backlog validation: `src/engine/backlog-contract.ts`
- Tool scopes: `src/auth/scopes.ts`
- Operator flags and defaults: `src/config/operator-config.ts`
- Copilot Studio orchestration guidance:
  `generated/copilot-studio-connector/agent-instructions.md`
- Canonical cast personas: `host/cast/.github/agents/`