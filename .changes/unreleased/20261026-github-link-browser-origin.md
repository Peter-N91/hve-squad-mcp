---
bump: patch
type: Fixed
---

- Preserve the browser's same-origin Origin header on GitHub linking and account-switch confirmation forms, and permit the initial consent POST to redirect only to the configured Entra authorization origin. Cross-origin referrers remain suppressed and CSRF checks remain enforced.
- Request Entra's identity-only `profile` scope alongside `openid` so the browser ownership check receives the immutable `oid` claim required for per-user binding.
