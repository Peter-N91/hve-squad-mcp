---
bump: minor
type: Added
---

- **The package is ready to publish to the npm registry.** Removed
  `"private": true` from `package.json`, added a `prepublishOnly` build hook so
  a stale `dist/` can never ship, and added a manual-only
  `.github/workflows/publish.yml` (`npm ci && npm run build && npm publish
  --access public`, authenticated via an `NODE_AUTH_TOKEN` secret, gated on the
  release tag already existing) that a maintainer runs explicitly — it never
  fires from a version-bump commit or a cut release. `npm pack --dry-run`
  confirms the tarball carries `dist/src/server.js`. The README's Status table
  no longer describes the package as `private`/unpublished.
