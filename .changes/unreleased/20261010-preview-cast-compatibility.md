---
bump: minor
type: Added
---

- Pin HVE Squad v0.19.0-pre to immutable commit
  5408860baaa91f92b23da2fb31509f0325928a05, whose package manifest declares
  0.18.1. Bundle inert roster/model-routing references and load the split roster
  catalog consistently in runtime routing, profiles and manifest generation.
  Native orchestration remains authoritative; upstream PowerShell skills are
  not executed.
- Add opt-in Copilot economy model routing through
  SQUAD_MCP_COPILOT_ROUTING=economy, defaulting to off. Intersect pinned fit/cost
  tables with verified model availability and roster floors. Protected roles
  retain fit-first ranking; only eligible implementation roles use cost-first
  picks. Apply selections to stage sessions and delegates and record provenance
  and roster model picks without weakening pipeline or approval gates.
- Unrostered delegate workers inherit the parent's ranked model without lowering
  its floor. Unavailable known-role delegates are omitted and explicitly refused,
  with reasons retained in source manifests.
- Give text-only reports 32 tool calls, 16 model calls and 180 seconds, subject
  to lower operator limits. Reserve finalization calls, name current-run inputs,
  and require explicit gap reporting rather than unsaved chat-only reports.
- Isolate product-owner handoffs and source manifests below the run's
  plans/handoff subtree in both executors, preserving the Lead plan and evidence.
- Clarify independent advisory review: canonical reports retain mandatory
  evidence citations and honest pending-review status without predicting future
  approval. Substantive source, accuracy, accessibility and safety findings remain
  enforced.
