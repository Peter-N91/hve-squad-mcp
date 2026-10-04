---
bump: patch
type: Added
---

- **Cowork plugin 11.0.6 / project skill 1.9** negotiates GUID-based schema-2
  project context bound to verified M365 provider, drive, and folder identifiers.
  It saves the server's canonical or safely mapped legacy partition before
  polling/history, preserves existing UUIDs and history, and retains schema-1
  compatibility only when required by live discovery.
- **Operator-authorized in-Cowork approval** prefers discovered `squad_approve`
  using saved/read-back explicit consent and same-run receipt verification.
  Project-bound approvals include the saved project UUID. Operator-only
  `Squad.Operate` remains required, with admin-consented delegated permission
  and a refreshed Entra connection; the package grants no consent and deploys
  no server. Rejection and ambiguous answers never approve; `squad_status`
  remains polling-only and `/admin/approve` remains an authorized alternative.
- Validation and packaging enforce approval-tool metadata and the unchanged
  20,000-character skill ceiling; detailed safeguards remain in required
  companion protocols.
