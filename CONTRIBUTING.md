# Contributing to hve-squad-mcp

This repository ships the **outbound** MCP server for [hve-squad](https://github.com/Peter-N91/hve-squad): the squad's own server, which other hosts consume. Contributions reach consumers through a fork and pull request against this repository.

1. Fork the repository and create a branch.
2. Make your change, and add a change fragment describing it (see [Recording your change](#recording-your-change)).
3. Run the verification commands in [Before you open a pull request](#before-you-open-a-pull-request).
4. Open a pull request against `main`. The pull request template restates the contract as items you confirm.
5. A maintainer reviews and merges. Merging is what releases it.

> **This repository is public.** Never commit a tenant id, subscription id, resource endpoint, object id, or secret — not in code, not in a test fixture, not in an example, not in a changelog entry. Use placeholders (`<tenant-id>`, `https://<your-app>.azurecontainerapps.io`).

## Recording your change

Do not edit `CHANGELOG.md`, and do not bump `version` in `package.json`. Both are **release outputs**, assembled on `main` when a release is cut. A pull request that edits either one is rejected by the `Release state and change fragment` check.

The reason is mechanical. A version line is one line and the newest changelog heading is one position, so two pull requests that both touch them always conflict — and the second one to merge silently reuses a version the first already claimed. Instead every pull request adds **one new file** under `.changes/unreleased/`. Two pull requests adding two differently named files never conflict.

Create yours with:

```bash
npm run change
```

The script asks four things and writes the file for you:

- **Type** — the Keep a Changelog section your entry belongs to: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`.
- **Bump** — how the version should move. This tracks **ideas, not artifacts**, so most changes are `patch`.
- **Title** — a short phrase, used only to name the file.
- **Entry** — the changelog text itself, written the way it should read in the release notes.

### Choosing the bump

| Value   | Use when | In this repository |
|---------|----------|--------------------|
| `major` | A consumer must change their integration to keep working. | Not used yet. |
| `minor` | A genuinely new idea, or a change that materially changes how the server is used. | A new tool on the surface. A new execution mode. A new storage backend family. |
| `patch` | Everything else, **including a new role binding, a new council seat, or a cast pin move that extends something already shipped**. | Retargeting a roster row. A new persona under an existing profile. A gate hardening. A wording fix. |

Adding a role is not a minor. Adding the *capability* the role belongs to is. When in doubt choose `patch` — the maintainer sees the resolved level on the pull request check (the `release:prep --dry-run` summary) and corrects the line before merging. Raising is cheap; an accidental minor is permanent.

If you prefer to skip the prompts, pass the values directly:

```bash
npm run change -- --type Fixed --bump patch \
  --title "cast pin drifts from the manifest" \
  --body "- **The bundled cast no longer matched its pin.** Re-resolved ..."
```

Either way you get a file like `.changes/unreleased/20260810-cast-pin-drifts-from-the-manifest.md`:

```markdown
---
bump: patch
type: Fixed
---

- **The bundled cast no longer matched its pin.** Re-resolved ...
```

Write the entry as markdown bullets starting with `- `, because the release step copies them verbatim. Lead with a bold sentence naming the problem, then say what changed, then cite file paths in backticks. One fragment per idea — a pull request doing two unrelated things adds two fragments.

A pull request that changes nothing a consumer would notice can carry the `skip-changelog` label instead, which a maintainer applies. That skips the version bump too: the version is resolved from fragments at release time, so a pull request contributing no fragment contributes no bump. Dependabot is exempt by author, because it cannot author a fragment — a maintainer adds one to the bot's branch when a bump is consumer-visible.

## Before you open a pull request

```bash
npm ci
npm run lint                      # tsc --noEmit
npm test                          # unit suites
npm run test:conformance          # security conformance suites
npm run generate:check            # generated/mcp-tools.schema.json is not stale
npm run generate:connector:check  # generated/copilot-studio-connector/ is not stale
```

`generated/` is **committed and regenerable**. If you changed `tools.catalog.yml` or anything the generators read, run `npm run generate` and `npm run generate:connector` and commit the result — CI fails on drift, not on the change itself.

## Changing the tool surface

`tools.catalog.yml` is the source of truth for the tool surface. The generator validates it against the deployed squad sources — the routing table, the roster, and the `*.agent.md` personas — and **fails the build** when a catalog tool maps to a routing intent that is not a real routing row, or to a role or council seat that is not a bundled agent.

So a catalog edit is never local. If you add a role binding, confirm it resolves against the bundled cast, and expect the drift check to tell you when it does not.

The tool surface is **additive-only** with respect to the squad: the generators read the squad sources read-only and never duplicate agent logic. The single source of truth for tool behaviour stays the deployed personas and the `squad-*` instructions.

## Moving the cast pin

`host/cast/.github/` is a SHA-pinned snapshot of the deployed cast, resolved reproducibly from public sources. **Do not hand-edit the copied files.** To move it:

```bash
# edit host/cast/package-pin.json to the new hve-squad version, then
npm run snapshot:cast
npm run snapshot:cast:check
```

`host/cast/package-pin.json` and `host/cast/manifest.json` move together, in the same commit. The `bump-on-package-release` workflow opens this pull request for you when a new hve-squad release appears; it deliberately does **not** auto-merge, because a pin move can retire a role the catalog still binds.

## Security expectations

Three invariants are non-negotiable, and a pull request that weakens one is declined:

- **Charter is authority; caller input is DATA (SEC-5).** Anything that arrives from a caller — `request`, `context`, deck YAML, a file name — is untrusted content. Only a persona charter carries instruction authority. Never concatenate caller text into a position where a model would read it as an instruction.
- **The server never writes to Azure DevOps, Jira, or GitHub (ADR-0001).** It produces the plan; a certified native connector performs every write on the end user's own connection, under that connector's auth, DLP, and throttles. Do not add an outbound write path.
- **Every store path is tenant-scoped and traversal-guarded.** A new storage target inherits the tenant prefix and the path guard, or it does not ship.

Add a conformance test under `test/conformance/` for any change that touches auth, gates, tenant isolation, or exposure. Those suites exist to make a regression in the trust boundary loud.

Found a vulnerability? Do **not** open a public issue. Report it privately through [GitHub Security Advisories](https://github.com/Peter-N91/hve-squad-mcp/security/advisories/new).

## Documentation

The consumer-facing site under `docs/` is plain, hand-authored HTML deployed to GitHub Pages by `.github/workflows/docs.yml` on push to `main`. There is no build step — edit the HTML and the CSS directly, keep the shared nav in sync across pages, and see [docs/assets/BRAND.md](docs/assets/BRAND.md) before touching the logo or the palette.

Architecture decisions live in `docs/planning/adrs/`. A change that alters the trust boundary, the execution model, or the distribution shape needs an ADR, not just a changelog entry.

## Licensing

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE). Do not add a dependency or redistribute content whose license is incompatible with MIT; if you add a redistributed source, record it in [NOTICE](NOTICE).
