---
bump: patch
type: Fixed
---

- **The cast-bump workflow pushed a branch it could not open a pull request for.** `GH_TOKEN` fell back to `github.token`, which GitHub forbids from creating pull requests, so the job did every step and failed on the last line - leaving `0.12.7` stranded on a pushed branch. It now resolves `PACKAGE_SYNC_TOKEN` or `RELEASE_TOKEN` and checks for one **before** the branch is pushed, so a missing token fails fast with nothing to clean up and an error naming both remedies.
