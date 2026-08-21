---
name: squad-federation-coordinator
description: |
  Routes HVE Squad work across several independently owned sub-squads in one
  repository, and proposes federation setup, expansion, or promotion. Returns
  the routing decision: which sub-squads are selected and why, the work scoped
  to each, the order and dependencies, the federation-level risks and gates, and
  the consolidated outcome to expect. Use when the repository genuinely hosts
  named sub-squads with separate owners, state, and routing, when the user names
  a sub-squad explicitly, or when they ask to set up or adopt a federation. Do
  not use for ordinary role specialization inside one team, and do not use it as
  a larger council — a council separates review disciplines, federation
  separates ownership.
license: MIT
metadata:
  author: hve-squad
  version: "1.0"
---

# Squad federation

Routes to the **Squad Federation Coordinator** role at the `confirm` tier with
gates. It is a catch-all — it matches anything — so select it deliberately.

## Confirm federation is warranted

Only when one repository truly has independently owned domains: separate
rosters, state, decisions, routing, and approval responsibilities. Prefer a
single squad until ownership justifies the coordination cost. If this is role
specialization inside one team, say the normal coordinator already covers it and
hand back.

## Call the tool

Use the `squad_federate` tool:

- `request` — the cross-domain outcome, with ownership boundaries stated.
- `context` — constraints and accepted artifacts.
- `squad=<name>` pins one registered sub-squad, overriding meta-routing. Prefer
  this for focused work; leave it off only for genuinely cross-domain requests.
  Names are lower-kebab-case and must already exist in the registry.
- `init=true` proposes a new federation on a fresh project, or adds and registers
  a new sub-squad when one already exists.
- `promote=true` proposes adopting an existing single squad as the first
  sub-squad, with its state relocated intact.
- `mode=autopilot` without a pinned squad requests federation-wide sequencing.
  Use sparingly — each selected sub-squad can run its own inner pipeline,
  multiplying latency and cost.

Do not pass `discovery`; this path is unattended and the server ignores it.

## What this connection actually does

The result is a **decision as text**. No sub-squad is dispatched. `init` and
`promote` produce a proposal only — no `federation.md`, no registry entry, and
no relocated state. Say this plainly: a user who believes their federation was
created will act on state that does not exist.

## Read the result

- `## Human Gate — approval required` with `outcome: "held"` is a valid paused
  state. Capture `runId` exactly, say an operator releases it out of band, and
  follow it with `squad_status` using backoff and bounded attempts.
- `## Result (squad-guided / embedded)` carries the routing decision.
- `## matchedRouting` reports `role: Squad Federation Coordinator`.

On an unknown or ambiguous sub-squad target, say so and escalate rather than
inventing a sub-squad name.

## Handoff

- One sub-squad is now the focus → `squad-coordinator` scoped to that sub-squad.
- Federation was the wrong tool → `hve-squad-orchestrator` to pick a stage.
- Otherwise return to `hve-squad-orchestrator` and name the next approval needed.
