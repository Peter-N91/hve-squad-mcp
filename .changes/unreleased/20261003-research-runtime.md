---
bump: minor
type: Added
---

- **Advisory stages now run as server-owned tool loops instead of single model
  completions.** The embedded engine executes each stage through a research
  runtime that scopes every read and write to the actor, records the content
  hash of every source it reads as server-issued evidence, and refuses
  completion until the cited evidence was actually retrieved. Model calls, tool
  calls, cost, and stage deadlines are bounded per stage and per run. Research
  follows the hve-squad v0.17 contract: delegated `RPI Researcher` workers are
  read-only and return unverified source suggestions, and the parent must read
  and cite sources itself (`src/engine/research-runtime.ts`).
- **Research, plan, and BRD artifacts are gated on structure and independent
  review.** Research and plan artifacts are validated against the pinned RPI
  template structure, a plan needs phase details plus one fresh independent
  critique, and a BRD needs a passing review of its current, unaltered draft
  (`src/engine/advisory-contracts.ts`, `src/engine/brd-review.ts`). When the
  pinned roster defines no `brd` profile but casts `BRD Builder`, a focused
  `brd` profile is derived from it (`src/engine/profiles.ts`).
- **A run can pause to ask a person one question and resume the same run.** The
  question and checkpoint survive restarts, and a resumed stage stops rather
  than restarting when its artifacts, authority, tenant, budget, or deadline no
  longer match (`src/engine/advisory-checkpoint.ts`).
- **Model failures are diagnosable without exposing provider detail.** Requests
  are preflighted, provider responses validated, error metadata reduced to safe
  allow-listed fields, and per-attempt usage recorded with stage, actor, and
  outcome. Missing usage or pricing is reported as unknown, never as zero cost.
- **Project identity and MCP tool annotations.** Calls may bind to a durable
  project UUID (`src/engine/project-context-bridge.ts`), and `tools/list`
  publishes standard read-only/destructive annotations for remote MCP clients
  (`src/transports/remote-tool-metadata.ts`).
- **New optional operator settings; existing deployments keep their behavior.**
  `SQUAD_MCP_AUDIENCE` accepts a comma-separated list of exact-match aliases for
  one protected resource. `SQUAD_MCP_MODEL_API` (`chat-completions` default, or
  `responses`), `SQUAD_MCP_MODEL_CHAT_PROFILE`,
  `SQUAD_MCP_MODEL_MAX_OUTPUT_TOKENS`, `SQUAD_MCP_MODEL_REASONING_EFFORT`, and
  `SQUAD_MCP_MODEL_VERBOSITY` select model capabilities and fail fast on
  incompatible combinations. `SQUAD_MCP_PRICE_CACHED_INPUT_PER_MTOK` and
  `SQUAD_MCP_PRICE_CACHE_WRITE_PER_MTOK` join the existing input/output rates.
- The pinned cast bundle additionally ships the hve-squad
  `untrusted-content-boundary` instruction that the runtime loads as authority
  (`host/cast`). `undici` becomes a runtime dependency for bounded model
  transport timeouts.
