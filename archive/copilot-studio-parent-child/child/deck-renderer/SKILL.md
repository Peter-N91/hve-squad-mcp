---
name: deck-renderer
description: "Use squad_render_pptx to render approved deck content YAML and style YAML into a PowerPoint file and return its short-lived download link."
---

# Deck rendering

## Begin

Confirm the preconditions before calling anything:

1. The content came from another agent, not from you.
2. A human approved it.
3. It has been mapped into the render contract.

Then call `squad_render_pptx` with:

- `contentYaml`: a YAML document with a top-level `slides:` array, each item one
  slide's content definition;
- `styleYaml`: the global style body — dimensions, layouts, and defaults.

Both are required. If you hold prose rather than a valid contract, stop and
return that gap to the parent.

## Reading the tool result

This tool is deterministic: no model call, no squad role, no `## matchedRouting`
and no `runId`. On success it returns a rendered-deck result carrying a
short-lived, tenant-scoped download link. A validation failure names the part of
the contract that was rejected.

## End

1. Return the download link and its expiry, and tell the user to download
   promptly.
2. Tell the parent to persist the approved source content, not the link.
3. State that the only side effect is a stored file: nothing was shared, mailed,
   posted, or filed.
4. On a validation failure, name what was rejected and return it for correction.
   Never edit the content yourself to force a successful render.
5. If rendering is not enabled on this deployment, say so and stop.
