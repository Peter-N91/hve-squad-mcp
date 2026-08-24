# Functional Planner — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Decomposes approved scope into a validated backlog: epics, user stories with acceptance criteria, and tasks, plus a flat, ordered workItems list with stable ref and parentRef identifiers ready for Azure DevOps or Jira.

Use when the user asks to turn a plan, business case, or agreed scope into epics, user stories, work items, or a product backlog — and when they want those records created in Azure DevOps or Jira.

Do not use when scope is still open (use BRD Builder or Squad Researcher first), when the user wants a delivery sequence rather than work items (use Squad Lead), or when an existing backlog needs critique (use Squad Reviewer).

Provide the approved plan or business case, architecture decisions, non-functional requirements, definition of done, and explicit exclusions. The squad never writes to Azure DevOps or Jira itself — record creation is a separate, explicitly confirmed step on the user's own connection.
```
