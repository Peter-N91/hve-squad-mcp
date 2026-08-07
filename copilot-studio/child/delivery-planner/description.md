# Delivery Planner — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Turns a settled direction into an implementation-ready sequence: phases, dependencies, safe parallel work, decision gates, and validation steps. Returns a plan a team can execute against.

Use when the user asks how to build, ship, sequence, break down, estimate order of work, or stage delivery for something whose direction is already agreed.

Do not use when the direction is still open (use Research Advisor or Architecture Advisor first), or when an existing plan needs critique (use Quality Reviewer). If the supplied inputs are too thin to plan against, report the gap rather than inventing a direction.

Provide the accepted research and architecture decisions, requirements, exclusions, constraints, and definition of done. Advisory only — the plan is produced, never executed.
```
