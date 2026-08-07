<!-- markdownlint-disable-file -->
# Bundled cast snapshot

This directory holds a **SHA-pinned snapshot of the full deployed cast** the
embedded engine loads from disk (the single-source invariant). It exists so the
remote/embedded container image can resolve **real** `*.agent.md` persona bytes
without the full repository or an `apm install` at runtime.

## What is here

- `.github/agents/**` — every deployed HVE Core cast persona flat under
  `agents/`, plus the squad-owned charters under `agents/squad/`. Each persona
  appears exactly once: APM deploys the squad charters into the flat tree as
  well, so copying both sources duplicated all 18 and left persona lookup decided
  by directory-walk order.
- `.github/instructions/squad/*.instructions.md` — the squad instructions,
  including the `squad-routing.instructions.md` probe file so the resolved root
  layout matches a deployed consumer.
- `.github/instructions/untrusted-content-boundary.instructions.md` — the
  boundary instruction the loader applies to any persona that ingests external
  content (VF-07 / G6).
- `manifest.json` — the integrity record: the resolved package and upstream
  commits, a SHA-256 per bundled file with the pinned source it came from, and
  the file counts.

The container `Containerfile` copies this tree to `/app/.github`, which is the
`packageRoot/.github` candidate that `resolveSquadAgentsRoots()` /
`resolveSquadGithubRoot()` probe at runtime.

## Regeneration

The snapshot is resolved reproducibly from public sources — do not hand-edit the
copied files:

```pwsh
cd squad-mcp
npm run snapshot:cast
```

`host/snapshot-cast.ts` resolves the tag in `package-pin.json` to a commit, reads
that release's `apm.yml` — the deployment manifest, which lists every deployed
file as `<owner>/<repo>/<path>[#<ref>]` — and fetches each file from its pinned
source. It needs network access and nothing else: **no local package checkout and
no `apm install`**.

That matters because the previous implementation copied from a sibling
`../hve-squad` checkout including `<package>/.github/agents`, which is gitignored
in the package repo and ships in no release asset. It existed only on a machine
that had run `apm install`, holding whatever that install left behind — so the
bundle was reproducible on exactly one machine, and a stale install silently
produced a bundle mixing current squad charters with retired upstream agents.

Set `GITHUB_TOKEN` (or `GH_TOKEN`) to raise the API rate limit; the sources are
public, so a token is optional.

## Drift check

Two halves, because they catch different failures:

- **Offline** — `test/cast-bundle.test.ts` FAILS when a bundled file's bytes
  disagree with the SHA-256 in `manifest.json`, when the bundle carries a file the
  manifest does not record, when `package-pin.json` moved without a re-snapshot,
  or when a roster **Primary** agent is missing or ambiguous. No network.
- **Online** — `npm run snapshot:cast:check` re-resolves the pin and FAILS when
  the committed bundle is not what the pinned tag produces. Non-zero exit, no
  writes.

Re-run `npm run snapshot:cast` after the pin or the upstream cast changes, then
commit the regenerated bundle + manifest.

## Deferred

Bundling the full referenced **skill** file trees is deferred to the later
execution expansion to keep image size and scope bounded. The loader's
untrusted-content-boundary enforcement does not depend on skill files being
present; personas + squad/boundary instructions are bundled now.
