---
bump: patch
type: Added
---

- **Nothing documented how to actually get a backlog out of the product profile.** Added `docs/scenario-product-backlog.html`, an end-to-end walkthrough a consumer can reproduce: the operator settings the path needs (pipeline, `table` run state, worker, business tools, auto-memory, artifacts, advisory autopilot), the scopes to expose, the Copilot Studio connector import, the exact ten-stage sequence `profile=product` resolves to against the bundled cast, the `squad_run` -> `squad_status` -> `squad_backlog` chain, the `workItems[]` contract and its `ref`/`parentRef` create loop, an Azure DevOps / Jira / GitHub type mapping, and a symptom-to-fix troubleshooting table.
