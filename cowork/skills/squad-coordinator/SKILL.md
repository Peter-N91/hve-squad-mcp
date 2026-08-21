---
name: squad-coordinator
description: |
  Starts and follows an end-to-end governed HVE Squad run — research, plan,
  optional multi-domain council, review, and backlog handoff compiled into one
  advisory package — and reports on a run already in flight. Use when the
  request is genuinely end-to-end and no narrower squad stage fits, when the
  user needs an independent go/no-go across two or more of architecture,
  security, cost, product, and responsible AI, or when the user supplies a squad
  run id and asks for an update. The council is reached only here. Do not use it
  for a single question a focused stage owns, and do not use it to implement or
  deploy — this run is advisory and produces text.
license: MIT
metadata:
  author: hve-squad
  version: "1.0"
---

# Governed squad run

Owns two tools: `squad_run` to start a governed run and `squad_status` to follow
one. `squad_run` routes to the **Squad Coordinator** role. Over this connection
its stages are research, plan, optional council, review, and backlog handoff. It
lands no impactful action.

## Choose it deliberately

This is a catch-all — it matches almost anything. A focused stage is cheaper,
faster, and usually better. Use this only for genuinely end-to-end work or for
the council.

## Start a run

Use the `squad_run` tool:

- `request` — the end-to-end outcome. When a go/no-go matters, **name the review
  dimensions explicitly**. The council engages only when the request explicitly
  spans at least two of architecture, security, cost, product, and responsible
  AI. Vague wording produces no council. For example: "review this architecture
  for security, cost, product requirements, and responsible-AI risks, and
  produce a go/no-go".
- `context` — constraints, accepted artifacts, and evidence.
- `mode=autopilot` for one compiled artifact. This does not mean remote
  execution.
- `profile` only when the user's domain clearly matches one of `default`,
  `full`, `security`, `design`, `architecture`, `azure`, `product`.

Do not pass `discovery`. The discovery gate interviews a human, this path is
unattended, and the server ignores an explicit depth rather than honoring it. If
the request has no requirement behind it, ask the user, or hand off to
`squad-researcher` or `brd-builder`.

## Read the result

- `## Human Gate — approval required` with `outcome: "held"` is a valid paused
  state, not an error. Capture `runId` exactly as written.
- `## Result (squad-guided / embedded)` with `outcome: "completed"` carries the
  compiled package. A convened council appears inside it as `## Council Verdict`,
  resolving Stop over Go-With-Conditions over Go.
- `## matchedRouting` reports `role: Squad Coordinator` and the council row.

## Follow a held run

1. Report the run id exactly, say an operator must release it out of band, and
   stop. You cannot approve or release a gate, and neither can any other skill.
2. When the user asks for an update, call `squad_status` with that stored run id.
3. Poll with backoff and bounded attempts. Stop on completed, failed, or a
   persistent denial.
4. Never start a second run because the first is still held.

If the operator enabled advisory autopilot, a run proven advisory-only may
complete without a hold; a plan seeding an impactful role still holds. Read the
actual outcome — do not assume either behavior.

## Present it

Say plainly whether the run is held, complete, or failed. Never describe a held
run as finished work. For a completed run give the compiled artifact, the
council verdict and its conditions, and the material caveats. Never claim the
run edited code, deployed infrastructure, released a gate, or wrote to a tracker.

## Handoff

- The verdict is accepted and work items are wanted → `functional-planner`.
- A specific gap remains → the one focused stage that owns it, rather than
  restarting the whole pipeline.
- Otherwise return to `hve-squad-orchestrator` and name the next decision.
