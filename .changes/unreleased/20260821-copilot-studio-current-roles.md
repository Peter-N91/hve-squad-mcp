---
bump: patch
type: Changed
---

- **The hand-maintained Copilot Studio parent and ten connected children became
  redundant once the single-agent generative-orchestration setup proved the full
  MCP surface could be selected directly.** The active authoring path is now the
  generated `generated/copilot-studio-connector/agent-instructions.md`; the
  superseded parent, children, skills, descriptions, and per-agent instructions
  remain available under `archive/copilot-studio-parent-child/` as historical
  reference but are no longer generated, tested, packaged, or supported.
- **`copilot-studio/` now documents only the supported single-agent workflow.**
  Its connector templates remain active, while the README directs makers to
  enable generative orchestration and paste the generated instructions block
  rather than creating and wiring eleven agents.
