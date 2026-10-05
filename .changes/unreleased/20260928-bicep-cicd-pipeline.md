---
bump: minor
type: Added
---

- **There was no automated CI/CD path for the Azure Bicep deployment; every build/deploy was a manual RUNBOOK step.** Added `.github/workflows/infra-validate.yml` (credential-free lint/build-params/contract-diff, then a gated `what-if` as `ciPlanIdentity` on every PR/push touching a deploy-affecting path) and `.github/workflows/infra-deploy.yml` (a credential-free `resolve` job that independently re-verifies the deploy SHA, a pre-approval `what-if`, an approval-gated, digest-pinned `build`/`deploy` behind the `prod` GitHub Environment and the `INFRA_DEPLOY_ENABLED` kill switch, and an advisory post-deploy smoke check).
- Added `.github/scripts/whatif-gate.mjs` (a dependency-free what-if JSON gate with a normalized change signature and a same-digest comparison policy) and `.github/scripts/export-infra-vars.mjs` (forwards only non-empty `SQUAD_INFRA_*` GitHub variables to the job environment, so an unset optional value never overrides its `main.bicep` default).
- Added `.github/scripts/setup-prod-environment.sh`, an idempotent, operator-run checklist for the `prod` GitHub Environment's protection rules.
- Added `.github/CODEOWNERS` covering the workflow/script/infra-test surface.
- Deprecated `host/oidc/deploy-aca.workflow.yml` in place (it cannot run from this repository) with a banner naming its insecure patterns, and rewrote `host/oidc/README.md` to point at the real bootstrap-based identity setup and the two new workflows.
- `host/RUNBOOK.md` gained a pipeline section documenting the variable/secret inventory, the kill-switch enablement procedure, and the redeploy/rollback path; nothing changes for an operator who never flips `INFRA_DEPLOY_ENABLED`.
