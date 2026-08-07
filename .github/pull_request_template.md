## What changed

<!-- One paragraph: the problem, and what this does about it. -->

## Release contract

- [ ] Added one fragment under `.changes/unreleased/` (`npm run change`) — or applied `skip-changelog`
- [ ] Its `bump` tracks **ideas, not artifacts** (a new role under a shipped capability is a `patch`)
- [ ] Its body reads as final release notes, not as a commit message
- [ ] Did **not** edit `CHANGELOG.md` or the `version` in `package.json`

## Verification

- [ ] `npm run lint`
- [ ] `npm test` and `npm run test:conformance`
- [ ] `npm run generate:check` and `npm run generate:connector:check` (no drift)
- [ ] `npm run snapshot:cast:check` — if the cast pin moved

## Cast and roster

<!-- Delete if untouched. -->

- [ ] `host/cast/package-pin.json` and `host/cast/manifest.json` moved together
- [ ] Every `tools.catalog.yml` role and council seat resolves to a bundled agent

## Security

- [ ] No tenant id, subscription id, endpoint, or secret is committed — **this repository is public**
- [ ] Caller input reaching a model stays DATA; only a persona charter is authority (SEC-5)
- [ ] Any new store path is tenant-scoped and traversal-guarded
