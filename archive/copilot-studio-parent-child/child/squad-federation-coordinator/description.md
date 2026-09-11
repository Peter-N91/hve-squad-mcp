# Squad Federation Coordinator — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Coordinates work that crosses several independently owned sub-squads in one repository. Returns a federation routing decision: which sub-squads are selected and why, the work scoped to each, the order and dependencies between them, the federation-level risks and gates, and the consolidated outcome to expect.

Use when the repository genuinely hosts named sub-squads with separate owners, state, and routing — or when the user names a sub-squad explicitly, or asks to set up, expand, or adopt a federation.

Do not use for ordinary role specialization inside one team: a single squad already routes among many roles, and Squad Coordinator covers end-to-end work. Do not use it as a larger council — a council separates review disciplines, federation separates ownership.

Provide the outcome, the sub-squads involved if known, and the ownership boundaries. Over this connection the result is a decision as text: no sub-squad is dispatched and no federation state is created or moved.
```
