---
bump: patch
type: Changed
---

- **Every Dependabot pull request failed validation, and the cast-bump workflow stranded a branch while reporting success.** Dependabot silently drops a label the repository does not define, so the `skip-changelog` it was configured to apply never landed and each bump was asked for a change fragment it cannot write; validation now also exempts `dependabot[bot]` by author, so a missing label cannot wedge it again. The bump workflow guarded on the BRANCH existing rather than on an open pull request, so a run that pushed the branch and then failed at `gh pr create` left the bump invisible while every later run exited clean (`.github/workflows/pr-validation.yml`, `.github/workflows/bump-on-package-release.yml`).
