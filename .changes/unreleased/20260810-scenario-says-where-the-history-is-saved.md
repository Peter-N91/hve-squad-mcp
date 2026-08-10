---
bump: patch
type: Added
---

- **The scenario walkthrough enabled squad memory without saying where any of it lands.** Added *Part 2 - Decide where the history is saved* to `docs/scenario-product-backlog.html`: the `.copilot-tracking/` tree a run writes, a `table` / `graph` / `file` comparison with the operator action each one needs, the SharePoint path (`graph-memory-permissions.bicep`, `Sites.Selected` plus a single-site grant, and why encryption defeats the point of choosing SharePoint), blob overflow for artifacts past the table entity ceiling, multi-target allow-lists, and the two ways history is read back. Calls out that run state and memory are separate stores that both read `SQUAD_MCP_STORAGE_ACCOUNT`, and that leaving the memory section in the agent instructions while auto-memory is on silently destroys continuity.
