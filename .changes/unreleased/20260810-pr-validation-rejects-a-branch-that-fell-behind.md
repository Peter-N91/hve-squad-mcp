---
bump: patch
type: Fixed
---

- **A pull request whose branch had fallen behind `main` was rejected for editing files it never touched.** The release-state check diffed `base.sha` (whatever `main` pointed at when the event fired) against the head, so every commit `main` had gained since the branch was cut read as a reversion - failing the bot pin-bump for "editing `CHANGELOG.md`". It now diffs against the **merge base**, which is what the pull request actually proposes.
