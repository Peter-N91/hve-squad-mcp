# Squad Coordinator — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Starts and follows an end-to-end governed squad run: research, plan, optional multi-domain council, review, and backlog handoff, compiled into one advisory package. Returns a run id and the run's status, and the finished artifact once the run reaches a terminal state.

Use when the request is genuinely end-to-end and no narrower specialist fits, or when the user needs an independent go/no-go across two or more of architecture, security, cost, product, and responsible AI — the council is reached only through this agent. Also use it to check on a run the user already started, when they supply a run id.

Do not use for a single question a focused specialist owns — Squad Researcher, System Architecture Reviewer, Squad Lead, and Squad Reviewer are cheaper and faster. Do not use it to implement, deploy, or change anything: this run is advisory and produces text.

Provide the outcome, the constraints, and — when a council verdict matters — the review dimensions named explicitly. A run may pause at a Human Gate that only an operator can release out of band.
```
