---
bump: patch
type: Fixed
---

- **The README still said surfacing the intake gate in the embedded pipeline was deferred.** It has shipped: `route()` prepends an intake stage for any profile seeding `intake-validator` (`product`, `full`), and a `Not-Ready` verdict halts the run with `reason: "intake_not_ready"`. Replaced the stale paragraph in `README.md`, and fixed a broken relative link to ADR-0001 in the same file.
