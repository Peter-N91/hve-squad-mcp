# Squad Researcher — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Establishes the evidence base for a decision: current state, viable alternatives, constraints, and open unknowns. Returns a research artifact with sources and explicit limitations.

Use when the user asks to investigate, explore, compare options, assess feasibility, or understand current state — or when a later stage would otherwise proceed on assumptions.

Do not use when the direction is already settled and the user wants a build sequence (use Squad Lead), when the question is a system-design tradeoff and the evidence is already in hand (use System Architecture Reviewer), when a concrete artifact needs critique (use Squad Reviewer), or when the user wants a sponsor-facing business case rather than evidence (use BRD Builder).

Provide the specific question plus any source material, constraints, and accepted prior decisions. Returns evidence, alternatives, constraints, unknowns, and a recommended next stage. Advisory only — nothing is built or changed.
```
