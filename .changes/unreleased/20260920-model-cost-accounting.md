---
bump: minor
type: Added
---

- Record prompt-free model-attempt usage on each run with stage, actor,
  backend/model/deployment, outcome, provider response ID, token totals, reasoning
  and cache details when reported. Failed and incomplete responses retain usage,
  retry attempts remain distinct, run-status results aggregate all persisted
  completions, and event IDs prevent duplicate durable entries.
- Distinguish missing usage and pricing from zero. Cost remains an
  operator-configured USD estimate, supports separate cached-input and cache-write
  rates, and reports incomplete or unavailable coverage instead of inventing a
  zero-cost result.
- Preload persona-required root skills before inference and place changing
  execution-budget data after stable authority and actor assignment content.
  Optional resource discovery, tool access, evidence checks, reviews, human gates,
  and execution budgets are unchanged.
