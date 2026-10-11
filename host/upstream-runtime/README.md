# Full upstream runtime dependency snapshot

This directory is a byte-exact dependency snapshot for the full upstream runtime
integration. Copilot deployments use it for new projects after explicit user
initialization; existing native projects retain `host/cast` and native
orchestration. Vendoring this tree alone does not enable its execution.

`../upstream-pin.json` pins HVE Squad's rolling `v0.19.0-pre` tag to commit
`a8d863a9715f0738f69711421b1897269911f68f`. `manifest.json` records every resolved
source, immutable commit, Git blob, SHA-256 and byte count. The manifest-declared
package version is recorded separately from the moving preview ref.

The snapshot includes every declared APM dependency tree, not just agent files:
97 Agent Skills, their reference/script/asset trees, squad prompts and instructions,
and source repository license notices. Binary assets retain their original bytes.
Do not hand-edit vendored files or run their scripts against live project state.

Commands from the MCP repository root:

```powershell
npm run snapshot:upstream
npm run snapshot:upstream:check
```

The check re-fetches immutable sources and verifies every Git blob and SHA-256.
The resolver rejects floating external dependencies, truncated trees, symbolic
links, path collisions and missing licenses. It refuses obsolete files in an
existing snapshot rather than deleting them implicitly.

Activation requires an isolated execution workspace, server-owned project
synchronization with conflict detection, controlled script dispatch, the original
approval boundaries, explicitly selected ranked/economy/manual routing, independent review of final artifact bytes,
and correct FinOps history/usage attribution. Installing this snapshot alone does
not meet those requirements. USD/credits must not be represented as billed charges
without corresponding evidence, and completed runs with failed reviews must not
count as accepted deliverables.

## Runtime default and specialist capability policy

For Copilot deployments, upstream is the default for newly initialized projects
and the user chooses ranked, economy, or manual fixed-model routing during Init.
The selected mode and any manual model are stored in the runtime binding; future
runs retain that choice rather than following a changed operator default.
Existing native projects remain native
until an explicit verified migration; changing the deployment default is not a
migration. This source configuration has not yet been rolled out to the live app.

Bundle local specialist prerequisites in the Linux image by default and verify
their actual versions and execution paths. Installing a tool is not authorization
to perform an impactful action. Do not expose a host Docker socket, platform
managed identity, stored GitHub identity, or unrestricted host filesystem.

Authenticated specialist tools use server-mediated, explicitly approved per-user
connections. The sandbox receives narrowly scoped operations and results, not
connection secrets. Missing connections must surface prerequisite requests;
credentials, permission grants and paid-resource creation are not implicit.

Feature acceptance requires both the installed dependency and its actual scoped
execution adapter, persistence, approvals and tests. The skill inventory alone is
not certification of all specialist workflows.
