---
bump: minor
type: Added
---

- **Azure deployment required operators to repeat the runbook by hand.** The
  modular Bicep deployment now keeps environment values in `.bicepparam` files,
  validates and previews changes in GitHub Actions, authenticates through a
  user-assigned managed identity, and waits for production approval before
  building the image or deploying (`host/infra/`, `.github/workflows/azure-deploy.yml`).
