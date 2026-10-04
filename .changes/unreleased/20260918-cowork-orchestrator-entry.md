---
bump: patch
type: Fixed
---

- **Cowork project work now always enters HVE Squad through the server-owned
  `squad_run` orchestrator.** The project-manager skill is limited to relaying
  bounded OneDrive or SharePoint project context, polling an existing run with
  `squad_status`, retrieving outputs through read-only `squad_history`, presenting
  human decisions in Cowork, and faithfully mirroring server files at their
  original relative paths. It coordinates server-directed follow-up with recorded
  answers and current checkpoints, but cannot release an operator gate through
  a status tool that has no approval-input contract. It no longer selects or
  composes specialist tools, roles, stages,
  profiles, or validation passes. Plugin validation and packaging now reject a
  project-manager skill that drops this orchestration boundary.
- **Saved human approvals have an explicit submission lifecycle.** Cowork now
  verifies the saved contract, discovers an authorized approval action, maps
  its inputs, checks same-run acknowledgment, and resumes the existing run.
  Rejections and uncertain submissions are handled separately. The package
  documents but does not provision the required approval integration.
- **Plugin 11.0.5 respects Cowork's 20,000-character skill limit.** Detailed
  execution and persistence instructions are preserved in a required companion
  reference. Validation and packaging reject oversized skills and missing
  references before an invalid ZIP can be uploaded.
