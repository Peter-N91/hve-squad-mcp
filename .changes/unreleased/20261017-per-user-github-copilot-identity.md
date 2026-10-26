---
bump: minor
type: Added
---

- **Run remote Copilot work as the signed-in user.** Cowork and Copilot Studio share a validated Entra tenant/object identity, a separately consented encrypted GitHub account link, private run and artifact partitions, account lifecycle guards, and generated host packages. Per-user mode is opt-in and requires explicit trust, durable state and operator provisioning; existing service and local modes remain supported. See the deployment runbook for host validation and migration boundaries.
