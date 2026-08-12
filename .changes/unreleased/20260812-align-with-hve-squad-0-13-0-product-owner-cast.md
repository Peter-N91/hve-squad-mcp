---
bump: minor
type: Changed
---

- **The `product-owner` cast this server seats no longer exists upstream.** hve-squad `0.13.0` picked up hve-core `3d681c9`, which retired the whole backlog cast — `ADO Backlog Manager`, `AzDO PRD to WIT`, `GitHub Backlog Manager`, `Jira Backlog Manager`, `Jira PRD to WIT`, `Agile Coach`, and `Product Manager Advisor`. The cast pin moves to `0.13.0` and the bundle is re-snapshotted, so `product-owner` now resolves to the dispatchable `Functional Planner` (PRD to work-item hierarchy across Azure DevOps, GitHub, and Jira) with `Issue Triage Agent` as its alternate, and `intake-validator` defaults to `PRD Quality Reviewer` (`host/cast/package-pin.json`, `host/cast/`).
- **The `squad_review` council seated a retired agent.** The `product-owner` seat moves from `GitHub Backlog Manager` to `Functional Planner`, the dispatchable Primary the new roster assigns that role; the other four seats are unchanged (`tools.catalog.yml`, `generated/`).
- **Both business tools named personas that no longer ship.** `squad_business_plan` resolves against `BRD Builder` and `squad_backlog` against `Functional Planner`, so each keeps loading REAL bundle bytes instead of silently degrading to its paraphrase charter. The charters are reworded to match, and both stay advisory — the tracker write is still the certified native connector's (`src/engine/business-tools.ts`).
- The delegated Intake Gate context no longer routes an unclassified requirements check to the retired advisory agent; it defaults to `PRD Quality Reviewer`, which reads the artifact for standards conformance regardless of its declared type (`src/engine/persona.ts`).
