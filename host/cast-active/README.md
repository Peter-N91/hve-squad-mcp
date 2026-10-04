# Active hve-squad cast

This is the runtime's reproducible snapshot of the deployed agents and
instructions from `Peter-N91/hve-squad` v0.17.0. `package-pin.json` records the
release; `manifest.json` records the resolved source commit and hashes for each
file.

The Cowork runtime does not bundle or load Agent Skills. Native runtime
procedures and artifact validators replace those dependencies. The snapshot
generator fails closed if a later upstream pin declares a skill dependency,
until the runtime is deliberately adapted.

The older `host/cast/` tree is preserved as legacy local work, but is not loaded
by the application or container. Do not hand-edit files under this generated
snapshot. To refresh and verify it, update `package-pin.json`, then run:

```powershell
npm run snapshot:cast
npm run snapshot:cast:check
```

The copied files retain their upstream licenses and provenance; see the
repository's `NOTICE` file.
