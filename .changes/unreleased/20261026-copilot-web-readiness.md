---
bump: patch
type: Fixed
---

- Probe Copilot web deployments through SDK-aware readiness every ten seconds, exercising the runtime connection during idle periods and withholding traffic from unready replicas. Builtin deployments retain their existing probe configuration.
