<!-- markdownlint-disable-file -->
# Bundled cast snapshot

This directory holds a **SHA-pinned snapshot of the full deployed cast** the
embedded engine loads from disk (the single-source invariant). It exists so the
remote/embedded container image can resolve **real** `*.agent.md` persona bytes
without the full repository or an `apm install` at runtime.

## What is here

- `.github/agents/**` — every deployed HVE Core cast persona plus the
  squad-owned personas under `agents/squad/`.
- `.github/instructions/squad/*.instructions.md` — the squad instructions,
  including the `squad-routing.instructions.md` probe file so the resolved root
  layout matches a deployed consumer.
- `.github/instructions/untrusted-content-boundary.instructions.md` — the
  boundary instruction the loader applies to any persona that ingests external
  content (VF-07 / G6).
- `manifest.json` — the pinned source commit, the bundled agent `name:` values,
  and the file/instruction counts.

The container `Containerfile` copies this tree to `/app/.github`, which is the
`packageRoot/.github` candidate that `resolveSquadAgentsRoots()` /
`resolveSquadGithubRoot()` probe at runtime.

## Regeneration

The snapshot is generated reproducibly — do not hand-edit the copied files:

```pwsh
cd squad-mcp
npm run snapshot:cast
```

The script copies READ-ONLY from the authoritative in-repo sources
(`.github/agents`, `squad-src/.github/agents/squad`,
`squad-src/.github/instructions/squad`, and the top-level
`untrusted-content-boundary.instructions.md`) and rewrites `manifest.json` with
the current `git rev-parse HEAD`.

## Drift check

`test/cast-bundle.test.ts` FAILS when the bundle is missing any roster Cast
Catalog **Primary** agent or the untrusted-content-boundary instruction. Re-run
`npm run snapshot:cast` after the deployed cast or roster changes, then commit
the regenerated bundle + manifest.

## Deferred

Bundling the full referenced **skill** file trees is deferred to the later
execution expansion to keep image size and scope bounded. The loader's
untrusted-content-boundary enforcement does not depend on skill files being
present; personas + squad/boundary instructions are bundled now.
