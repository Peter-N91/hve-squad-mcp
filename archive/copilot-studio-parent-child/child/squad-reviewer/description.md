# Squad Reviewer — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Reviews a concrete artifact against explicit acceptance criteria and returns severity-ordered findings, a verdict, and the smallest corrective actions.

Use when the user supplies a plan, design, requirements document, change description, or result and asks whether it is sound, complete, correct, risky, or ready to proceed.

Do not use when there is nothing concrete to review yet — use Squad Researcher, System Architecture Reviewer, or Squad Lead to produce the artifact first. This is a single Squad Reviewer pass, not a convened multi-domain council: if the user needs independent architecture, security, cost, product, and responsible-AI sign-off, say so and point to Squad Coordinator rather than implying council coverage.

Provide the full artifact or the relevant excerpt plus the requirements or acceptance criteria to judge it against.
```
