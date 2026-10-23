# host/infra/tests — local IaC validation

Everything here is **local and credential-free**. Nothing deploys, runs
`what-if`, or calls Azure; the only `az` commands used are `az bicep build`,
`az bicep build-params`, `az bicep lint`, and `az bicep version`.
Build outputs go to a temp folder (default `<os tmp>/squad-bicep-validate`),
never into the repository.

## Run everything

```bash
node host/infra/tests/validate.mjs                              # baseline = HEAD
node host/infra/tests/validate.mjs --baseline-ref origin/main   # CI: the PR base
node host/infra/tests/validate.mjs --out /tmp/bicep-validate
```

Exit code `0` means every check passed. The full log is written to
`<out>/validation-report.md` and `<out>/validation-summary.json`.

| Step | What it proves | Council condition |
| --- | --- | --- |
| build | `main.bicep`, `bootstrap/bootstrap.bicep`, `bootstrap/entra-app.bicep` compile | NFR-001 |
| lint | every `*.bicep` under `host/infra` has zero error-level findings under `bicepconfig.json` | S3, NFR-003 |
| build-params | every committed `.bicepparam` and every fixture builds | NFR-002, NFR-005 |
| diff-contract | the 38 params, 11 `SquadConfig` fields, and 6 outputs are unchanged; new params are the expected defaulted set | A9, A12 |
| sec-diff | full resource inventory + SEC properties, baseline vs refactor, per fixture | S9, A2, U4 |
| fail() guards | every `fixtures/failing/*` fixture is rejected with its named message | A6, AC-A10, AC-A11, AC-A14, C8, U1, S5 |
| bootstrap / entra invariants | U1, AC-A4, S4/C1/C2, S6, S11/C3, AC-A7, A11, S8/C6 | as listed |
| deterministic names | no resource, module, scope, or `guid()` input depends on `reference()` or a module output | AC-A9 |
| C8 key gate | no committed `.bicepparam` assigns `runEncryptionKeyBase64` a literal | security C8 |
| concat order | both env `concat(...)` lines are byte-identical to the baseline source | D2, A8 |
| environments/prod | `prod.bicepparam` builds from a full fake `SQUAD_INFRA_*` set. A required-only set gives parity with `main.bicep` defaults. A missing required var fails with `BCP427` naming it; conditional/malformed inputs fail with named messages. Also covers create mode, the legacy `api://` audience, the env-only key, and the contract table == the variables read | cicd escalation D1a |
| placeholder preflight | `check-no-placeholders.mjs` returns exit 0 on prod, 1 on the `main.bicepparam` template, 2 on bad input; self-test on nested values | cicd escalation D1a |

## Individual scripts

* `check-no-placeholders.mjs <built.parameters.json> [...]` (the CI preflight; see `../environments/README.md`)
* `diff-contract.mjs --before <baseline main.json> --after <main.json>`
* `sec-diff.mjs --before <baseline main.json> --after <main.json> --params <x.parameters.json>`
* `lib/arm-eval.mjs` evaluates a compiled ARM template with a parameters file
  and returns the resource inventory. Runtime-only values (`reference()`,
  `list*()`) become symbolic placeholders like `<ref(/subscriptions/.../x).principalId>`,
  and these are stable across two templates. `fail()` raises `GuardFailure`.
  ARM's `if()` is lazy, and the evaluator matches that.

## Fixtures

| Fixture | Shape |
| --- | --- |
| `existing.bicepparam` | today's default: `openAiMode: 'existing'`, both `manage*` flags `false` |
| `create.bicepparam` | `openAiMode: 'create'`, K1 default (GlobalStandard / 10), trimmed allow-list |
| `cross-rg.bicepparam` | registry in another subscription + RG, AOAI in another RG, both flags `true` |
| `all-features-on.bicepparam` | every `enable*` flag and both `manage*` flags `true`; key read from the environment |
| `bootstrap-same-rg.bicepparam` / `bootstrap-cross-rg.bicepparam` | bootstrap with the registry and AOAI in the app RG, and outside it |
| `entra-app.bicepparam` | the Entra app registration |
| `failing/*.bicepparam` | each must trip exactly one `fail()` guard (see the header of each file) |

The harness sets `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64` to a well-formed dummy
value for `all-features-on` (43 × `A` + `=`, the base64 of 32 zero bytes, which is not a secret)
and to a malformed value for `failing/bad-encryption-key`.

## What stays live-only (not provable here)

* **ABAC condition behavior (security C1, U5).** Before the first live
  `bootstrap.bicep` run, the named security reviewer runs this sandbox matrix
  as `ciDeployIdentity` against a throwaway resource group:

  | # | Attempt | Expected |
  | --- | --- | --- |
  | 1 | assign `AcrPull` to the app UAMI (ServicePrincipal) | **allowed** |
  | 2 | assign a 6th role (e.g. `Reader`) to the app UAMI | denied |
  | 3 | assign `Key Vault Secrets User` to a **User** principal | denied |
  | 4 | assign an allowed role to `ciDeployIdentity` itself | denied |
  | 5 | assign an allowed role to `ciPlanIdentity` | denied |
  | 6 | delete the assignment from #1 | allowed |
  | 7 | delete the `Contributor` assignment of `ciDeployIdentity` | denied |
  | 8 | at the registry (cross-RG): assign `Key Vault Secrets User` | denied (single-GUID `AcrPull` only) |

* **The login-server guard** in `modules/container-registry-access.bicep` reads
  the registry's live `properties.loginServer`. The harness proves the guard
  logic with a stubbed value, but only a live what-if or deploy can exercise it
  against the real registry.
* **Custom-role action strings** are accepted by ARM only when the provider
  operation exists. Cross-check them with `az provider operation show` during
  the U5 review.
* **The mandatory live what-if (A9 / AC-A1..A3)** is cicd's gated job. Run it as
  `ciPlanIdentity` with `--validation-level ProviderNoRbac`. It passes only with
  zero `Delete`, `Replace`, and `Unsupported` changes.

## Pre-flip role-assignment check (AC-A13 / U4)

`Test-RoleAssignmentPreFlip.ps1` is read-only (`az role assignment list`). An
operator runs it before setting `manageAcrPullAssignment` or
`manageOpenAiRoleAssignment` to `true` on an existing environment. If it lists a
manually created assignment, delete that assignment first. Otherwise the deploy
fails with `RoleAssignmentExists`.
