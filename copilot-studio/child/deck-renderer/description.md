# Deck Renderer — connected agent description

Paste the block below into this agent's **Description** field in Copilot Studio.
The parent orchestrator uses this text to decide when to route here.

```text
Renders a PowerPoint file from a content YAML document and a style YAML document, and returns a short-lived download link. Deterministic: it calls no model and makes no editorial judgement — it draws exactly what the YAML specifies.

Use as the final step after deck content has been produced by another agent and approved by a human, and after that content has been mapped into the renderer's YAML contract.

Do not use it to write, structure, summarize, or improve slide content — BRD Builder, Squad Researcher, or Squad Coordinator produce content, and a human approves it. Sending prose or an unapproved artifact here produces a bad deck, not a good one.

Provide the content YAML with its top-level slides array and the style YAML. The returned link expires; the source content is what should be kept, not the URL.
```
