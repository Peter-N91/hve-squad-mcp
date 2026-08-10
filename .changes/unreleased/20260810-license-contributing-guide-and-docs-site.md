---
bump: patch
type: Added
---

- **The repository shipped with no license, no contributor guide, and no consumer-facing documentation.** Added `LICENSE` (MIT, matching the `license` field `package.json` already declared) and a `NOTICE` recording that `host/cast/.github/` is redistributed content whose files stay under their originating licenses. Added `CONTRIBUTING.md` covering the change-fragment release contract, the `tools.catalog.yml` drift check, the cast-pin procedure, and the three security invariants a change must hold. Added a GitHub Pages site under `docs/` — home, getting started, tools, deploy, configuration, and contributing — published by the new `.github/workflows/docs.yml`, plus the `hve-squad-mcp` logo variant and `docs/assets/BRAND.md` defining the shared badge and the variant layer that future surfaces swap.
