---
bump: patch
type: Fixed
---

- **Accepted Checkov findings still showed as open alerts in the Security tab.** Checkov records an inline `checkov:skip` as a SARIF `suppressions` entry and honours it in its own exit code, but GitHub Code Scanning ignores that property, so three justified suppressions sat open as warnings. Suppressed results are now dropped before the upload and reported in the job summary with their justification instead, so an accepted finding stays reviewable without training anyone to ignore the Security tab. The unfiltered SARIF is still retained as an artifact (`.github/workflows/checkov.yml`).
