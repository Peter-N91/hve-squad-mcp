---
bump: patch
type: Fixed
---

- **An interactive Cowork session now stays connected across turns.**
  `scaleCooldownSeconds` kept the replica warm for 30 minutes, but the MCP
  session id kept its own 5-minute `DEFAULT_SESSION_IDLE_MS`. A normal reading
  pause between turns outlived the session while the container was still
  running, so `POST /mcp` was refused with `404 Missing or invalid session;
  re-initialize.` and Cowork reported every HVE tool as unavailable
  mid-conversation. `main.bicep` gains a bounded `sessionIdleSeconds` parameter,
  published as `SQUAD_MCP_SESSION_IDLE_MS`, so the session lifetime is explicit
  infrastructure rather than an invisible default. The `hve-project-manager`
  skill now separates a transient dropped connection (every `squad_*` tool
  missing at once, retried after reconnecting) from an operator disabling a
  single tool (still recorded as blocked); fabricating stage output remains
  forbidden in both cases. `cowork/SETUP.md` documents both timers and how to
  tell an expired session (fast 404) from a genuine cold start (no log line).
