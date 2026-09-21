---
bump: patch
type: Fixed
---

- **An interactive session lost the connector mid-conversation.** The app scaled
  to zero during the pauses a caller takes to read the previous artifact — the
  platform default is five minutes of idle — so the next turn hit a cold start
  and the startup probe was still refusing connections when the request arrived.
  Copilot Cowork reported that as an unreachable connector rather than as
  latency, which made a working deployment look unstable. The scale block now
  exposes `scaleCooldownSeconds` (default unchanged at 300), so an operator
  serving interactive callers can keep the app warm across those pauses while
  still scaling to zero once the session ends (`host/infra/main.bicep`).
- The `Microsoft.App/containerApps` resource moves to API version `2025-01-01`,
  which is where `scale.cooldownPeriod` is available; `2024-03-01` rejects it.
