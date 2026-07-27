/**
 * Business-user tool definitions (`squad_business_plan`, `squad_backlog`).
 *
 * These are the surfaces a NON-TECHNICAL user reaches from Copilot Studio or
 * Teams. Everything else the server exposes is engineering-shaped
 * (`squad_research`, `squad_architect`, …) and returns free-form markdown, which
 * a business user cannot act on and an orchestrator cannot reliably map onto
 * work-item writes.
 *
 * Both tools are ADVISORY and land no impactful action: each runs exactly ONE
 * server-side dispatch against a REAL cast persona (resolved from the deployed
 * `*.agent.md` bytes where present — the single-source invariant) and returns a
 * finished artifact. The ADO/Jira WRITE is still performed by the certified
 * native connector on the end user's own connection (ADR-0001).
 *
 * SEC-5 is preserved: each `charter` below becomes the `system` AUTHORITY
 * unchanged, and the caller's request/context are composed separately as
 * delimited DATA by `composeEmbeddedPrompt`. Nothing from the caller is ever
 * concatenated into a charter.
 */
import { SQUAD_BACKLOG_TOOL, SQUAD_BUSINESS_PLAN_TOOL } from "../auth/scopes.js";

/** A business tool's role + charter, resolved before any model call. */
export interface BusinessToolSpec {
  /** The tool id (also the run's `toolId`). */
  readonly toolId: string;
  /**
   * The cast role whose deployed persona is preferred. When the cast is absent
   * (a minimal image) the {@link charter} below is used as the paraphrase
   * fallback, exactly as the hero roles behave.
   */
  readonly role: string;
  /** The AUTHORITY charter (paraphrase fallback / output contract). */
  readonly charter: string;
  /** True when the result must be parsed as the structured backlog contract. */
  readonly structured: boolean;
}

/**
 * Business-plan charter. Written for a reader with no engineering context: plain
 * language, explicit assumptions, and a fixed section order so successive runs are
 * comparable and the agent can quote a section back to the user.
 */
export const BUSINESS_PLAN_CHARTER = [
  "You are the **Product Manager Advisor** working directly with a BUSINESS",
  "stakeholder who is not technical. Turn the idea described in the untrusted data",
  "into a clear, decision-ready business plan.",
  "",
  "Write in plain language. No jargon, no framework names, no code. Where the input",
  "is silent, state an explicit assumption rather than inventing a fact, and mark it",
  "as an assumption the stakeholder must confirm.",
  "",
  "Produce EXACTLY these sections, in this order, as markdown headings:",
  "1. `## Summary` — one short paragraph a sponsor could read aloud.",
  "2. `## Problem and Customer` — who has the problem, how it hurts today.",
  "3. `## Proposed Solution` — what we would offer, in outcome terms.",
  "4. `## Value and Success Measures` — the business value and the specific,",
  "   measurable indicators that would prove it worked.",
  "5. `## Scope` — what is in, and explicitly what is out of scope.",
  "6. `## Go-to-Market` — who we reach, how, and the first proof point.",
  "7. `## Cost and Effort Outline` — the shape of the investment (ranges and",
  "   drivers, not false precision); say plainly when you cannot estimate.",
  "8. `## Risks and Dependencies` — each with a mitigation or an owner decision.",
  "9. `## Milestones` — a short sequence with the decision point at each step.",
  "10. `## Open Questions` — what the stakeholder must decide before work starts.",
].join("\n");

/**
 * Backlog charter. Constrains the model to emit ONLY the JSON object the server
 * validates (`backlog-contract.ts`), because the agent's next step is one native
 * connector call per work item — prose here would force the orchestrator to parse
 * English, which is exactly the failure this tool removes.
 */
export const BACKLOG_CHARTER = [
  "You are the **ADO Backlog Manager**. Turn the request in the untrusted data into",
  "a well-formed delivery backlog for a business stakeholder.",
  "",
  "Output rules (strict):",
  "- Return ONE JSON object and NOTHING else. No prose before or after, no",
  "  markdown fences, no comments.",
  "- Shape:",
  "  {",
  '    "summary": "one plain-language paragraph for the stakeholder",',
  '    "epics": [',
  "      {",
  '        "title": "...",',
  '        "description": "...",',
  '        "acceptanceCriteria": ["...", "..."],',
  '        "stories": [',
  "          {",
  '            "title": "As a <role>, I want <capability>, so that <outcome>",',
  '            "description": "...",',
  '            "acceptanceCriteria": ["Given ... When ... Then ..."],',
  '            "estimate": "S",',
  '            "tasks": [{ "title": "...", "description": "..." }]',
  "          }",
  "        ]",
  "      }",
  "    ]",
  "  }",
  "",
  "Quality rules:",
  "- Every story title uses the `As a … I want … so that …` form and describes a",
  "  user-visible OUTCOME, never an implementation step.",
  "- Every story has at least one testable acceptance criterion in",
  "  `Given … When … Then …` form. Criteria are observable, not aspirational.",
  "- Each story is independently valuable and small enough to finish in one",
  "  iteration; split it when it is not.",
  "- Do not invent scope. When the request is under-specified, add a story titled",
  "  so the gap is obvious and put the missing decision in its description.",
  "- `estimate` is a relative size (`XS`, `S`, `M`, `L`, `XL`) or omitted \u2014 never a",
  "  date and never a currency amount.",
].join("\n");

/** The two business tool specifications, keyed by tool id. */
export const BUSINESS_TOOL_SPECS: Readonly<Record<string, BusinessToolSpec>> = {
  [SQUAD_BUSINESS_PLAN_TOOL]: {
    toolId: SQUAD_BUSINESS_PLAN_TOOL,
    role: "Product Manager Advisor",
    charter: BUSINESS_PLAN_CHARTER,
    structured: false,
  },
  [SQUAD_BACKLOG_TOOL]: {
    toolId: SQUAD_BACKLOG_TOOL,
    role: "ADO Backlog Manager",
    charter: BACKLOG_CHARTER,
    structured: true,
  },
};

/** Resolve a business tool spec by id, or `undefined` when it is not one. */
export function businessToolSpec(toolId: string): BusinessToolSpec | undefined {
  return BUSINESS_TOOL_SPECS[toolId];
}
