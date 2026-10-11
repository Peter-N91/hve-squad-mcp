---
bump: minor
type: Added
---

- Expand Copilot execution with the byte-exact 97-skill, 1682-file HVE Squad
  v0.19.0-pre bundle at a8d863a9715f0738f69711421b1897269911f68f.
  New Copilot projects use the full upstream coordinator after explicit user
  initialization. Existing native projects and their schemas remain unchanged.
- Offer ranked, economy and manual fixed-model routing at Init. Persist the
  chosen mode/model in the project binding and preserve it across runs and
  resumes. All modes retain availability checks, roster floors, review and
  approval gates. Legacy explicit economy confirmations remain compatible.
- Honor the economy-only upstream rate seeder: ranked/manual use the pinned
  Scribe cold seed and read-only genuine ledger validation with explicit
  native-Scribe provenance, never a temporary mode override or fabricated script
  receipt. Preserve existing calibration and operator rates.
- Port the isolated PowerShell/storage bridge, exact timestamp handling,
  chunked hash-verified transport, no-ceiling preflight semantics, controlled
  handoffs and partial-commit recovery receipts.
- Port named research/critique helpers, complete-source critique coverage,
  exact-hash independent review, bounded correction/rereview and read-only
  artifact hashing. Missing required capabilities remain explicit blockers.
- Add a full Linux sandbox with pinned/locked specialist prerequisites and
  scoped Markdown-to-DOCX and DOT-to-PNG conversions. Publish verified binary
  outputs through server-owned Blob storage and authenticated history chunks;
  keep credentials, external integrations and arbitrary scripts out of the
  sandbox's authority.
- Preserve SDK usage event IDs, surface accounting persistence failures and
  record service-reported Copilot credits separately from configured USD
  estimates. Add run-scoped deduplicated billing/value projections without
  treating partial totals or provider stop events as complete acceptance.
