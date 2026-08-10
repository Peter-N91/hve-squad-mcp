---
bump: patch
type: Fixed
---

- **Release prep assembled the release and then could not push it.** The `main` ruleset requires changes to arrive through a pull request and bypasses only repository admins, so the `chore(release):` commit was rejected with `GH013: Repository rule violations found`. The workflow had been falling back to the Actions job token when `RELEASE_TOKEN` was unset, which turned a missing secret into an error message about branch protection. It now requires the token up front and says which secret to add (`.github/workflows/release-prep.yml`).
