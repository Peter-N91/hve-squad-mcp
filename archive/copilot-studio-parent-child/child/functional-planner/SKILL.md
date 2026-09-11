---
name: functional-planner
description: "Use squad_backlog to decompose approved scope into a validated epic/story/task contract, then create the confirmed work items through the native Azure DevOps or Jira connector."
---

# Backlog from approved scope

## Begin

Before calling `squad_backlog`, require settled scope: an approved business case
or delivery plan, the architecture decisions, non-functional requirements, the
definition of done, and explicit exclusions. Report the gap rather than
decomposing an assumption.

Call `squad_backlog` with the outcome to decompose in `request` and those inputs
in `context`.

## Reading the tool result

`squad_backlog` is the one squad tool that does not return the Markdown
envelope. On success the result is a JSON object:

- `summary` — one plain-language paragraph for the business user;
- `epics` — the hierarchy, each with `acceptanceCriteria` and `stories`;
- `workItems` — the flat, depth-first array to iterate, each element carrying
  `ref`, optional `parentRef`, `type` (`Epic` | `User Story` | `Task`), `title`,
  `description`, `acceptanceCriteria`, and optional `estimate`.

`ref` and `parentRef` are server-assigned (`E1`, `E1-S2`, `E1-S2-T1`). They are
the only correlation keys; titles are not unique and may be rephrased.

An error result stating the backlog could not be produced in a structured form
means validation rejected the model output. Ask again with a narrower scope.
Never assemble work items from prose instead.

## Confirmation gate

1. Return `summary`, the epics, and the stories to the parent for presentation.
2. Do not create anything until the parent returns explicit user confirmation.
3. Bulk creation without that confirmation is a defect, not a shortcut.

## Creating the records

1. Iterate `workItems` in order; parents precede their children.
2. Call the native Azure DevOps or Jira action once per element, mapping `type`,
   `title`, `description`, and `acceptanceCriteria`.
3. Record the created id against the element's `ref`.
4. For an element with `parentRef`, link it to the id recorded for that ref.
   Match on `ref`, never on title.
5. Batch the calls — one epic and its children at a time — because the
   connectors are rate limited per connection.
6. On failure, name the failing `ref`, continue with the remainder, then offer to
   retry only the failures.

## End

Report what was produced, what was confirmed, and what was actually created with
its ids. The squad server writes to no tracker; every record came from the
connector on the user's own connection. Never present an uncreated backlog as
created work.
