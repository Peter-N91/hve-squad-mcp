# System Architecture Reviewer — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Evaluates a system-design decision and recommends one option with its consequences: component boundaries, integration choices, deployment topology, data stores, reliability, performance, and cost tradeoffs. Returns options, a single recommendation, consequences, and ADR candidates.

Use when the user is choosing between technical approaches, questioning a boundary or integration, or asking whether a design will hold under scale, cost, compliance, or operability pressure.

Do not use when there is no evidence yet (use Squad Researcher first), when the architecture is settled and the user wants a work breakdown (use Squad Lead), or when an existing design must be judged against acceptance criteria (use Squad Reviewer).

Provide the decision plus scale, budget, compliance, team maturity, current topology, and any fixed decisions. Advisory only — no ADR, code, or infrastructure is created.
```
