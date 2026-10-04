---
bump: patch
type: Fixed
---

- **The Cowork plugin failed to publish with `InvalidAgentConnector: … tool
  description file ./tools/hve-squad-tools.json not found in the app package`.**
  The manifest declared its `mcpToolDescription.file` and every `agentSkills`
  folder with a `./` prefix, but the publish service matches those strings
  literally against archive entry names, which carry no prefix. The declared
  paths are now bare (`tools/hve-squad-tools.json`), and
  `generators/build-cowork-plugin.ts` rejects a `./`, `../`, absolute, or
  backslashed path rather than only checking that it resolves on disk — which is
  why the original validation passed a package the service refused. `pack.ps1`
  additionally asserts every declared path against the built `.zip`, so the
  archive itself is verified rather than the source tree.
