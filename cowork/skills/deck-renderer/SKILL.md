---
name: deck-renderer
description: |
  Renders a PowerPoint file through the HVE Squad's deterministic renderer from
  an already-approved content YAML document and style YAML document, and returns
  a short-lived download link. Use only as the final step after deck content was
  produced by another squad stage, approved by a human, and mapped into the
  renderer's YAML contract. This is not a deck authoring or design skill — the
  built-in PowerPoint skill owns creating and editing presentations, and should
  be used for any normal "make me a deck" request. Do not send prose here.
license: MIT
metadata:
  author: hve-squad
  version: "1.0"
---

# Squad deck render

Owns one deterministic tool, `squad_render_pptx`. No model runs behind it, no
squad role is dispatched, and no role is reported — there is nothing to
attribute the result to. It validates the YAML, renders it, uploads the deck to
a tenant-scoped location, and returns an expiring link. It draws exactly what
the YAML says.

## When this is the wrong skill

If the user just wants a deck built or edited, this is not it — the built-in
PowerPoint skill does that natively and better. This skill exists for one narrow
case: governed content that must be rendered through the squad's own
deterministic pipeline, from a contract that was reviewed first.

## Preconditions

Render only when all three hold:

1. The content came from another stage — `brd-builder`, `squad-researcher`, or
   `squad-coordinator` — not from you.
2. A human reviewed and approved that content.
3. The approved content was mapped into the contract: `contentYaml` with a
   top-level `slides:` array where each item is one slide's content definition,
   and `styleYaml` carrying the global dimensions, layouts, and defaults.

No squad tool emits this YAML automatically. If you hold prose rather than a
valid contract, say so and hand back — do not improvise the YAML to force a
render, and do not treat rendering as a substitute for content review.

## Call the tool

Use `squad_render_pptx` with `contentYaml` and `styleYaml`. Both are required.

## Read the result

Deterministic: no `matchedRouting`, no `runId`. On success the result carries a
short-lived, tenant-scoped download link. A validation failure names the part of
the contract that was rejected.

## Present it

1. Give the download link and its expiry, and tell the user to download promptly.
2. Persist the approved **source content**, never the link — a stored URL is a
   dead reference and a needless exposure.
3. State that the only side effect is a stored file: nothing was shared, mailed,
   posted, or filed anywhere.
4. On a validation failure, name what was rejected and hand it back for
   correction. Never edit the content yourself to force a successful render.

If rendering is not enabled on this deployment, say so plainly and stop.

## Handoff

- Content was not approved or not in contract form → back to the stage that
  produced it, or to the user for approval.
- Rendered successfully → return to `hve-squad-orchestrator`.
