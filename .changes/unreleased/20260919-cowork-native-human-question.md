---
bump: patch
type: Fixed
---

- Cowork plugin 11.0.17 / skill 1.18 requires a discovered native selectable
  question tool for live server humanInput when its actual schema represents
  the exact question and choices losslessly. The observed core-AskUserQuestion
  shape is mapped conditionally, one server question at a time, without fake
  options, rewritten cautions, or invented multi-select permission.
- Chat fallback records and displays a concrete capability constraint or explicit
  user preference. Urgency, convenience, and requests to avoid artifact cards
  do not waive native questions.
- Minimal identity-bound hold capture precedes prompt presentation; bulk artifact
  mirroring remains a pending backlog rather than delaying the human question.
  eTag protections, exact response persistence, matching same-run acceptance
  receipts, and unchanged incomplete-projection acknowledgments remain required.
- Instruction-contract regressions cover native mapping, fallback boundaries,
  response provenance, and handoff ordering across skill references. This is a
  plugin-only repair, not a server change, remote installation, or proof of live
  UI compliance or BRD acceptance.
