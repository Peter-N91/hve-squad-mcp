---
bump: patch
type: Fixed
---

- **Every cast pin bump released a minor, whatever hve-squad actually did.** The bump workflow hardcoded `--bump minor`, so a patch upstream became a minor here and the two version lines drifted apart - and it contradicted `CONTRIBUTING.md`, which already classes a cast pin move as a `patch`. The fragment now mirrors the level hve-squad moved: `0.12.7 -> 0.12.8` is a patch, `0.12.8 -> 0.13.0` is a minor, `0.13.0 -> 1.0.0` is a major. A version either side cannot parse resolves to `patch` rather than guessing upward.
