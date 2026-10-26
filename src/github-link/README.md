# GitHub account linking

Lets the MCP server run Copilot SDK sessions as each Entra user's own GitHub identity.
Entra OBO cannot mint GitHub tokens, so a second, separately consented credential is
stored per principal (`tenantId|oid`, never the pairwise `sub`).

## Flow facts verified against docs.github.com (2026-10-17)

- Authorize: `GET https://github.com/login/oauth/authorize` (client_id, redirect_uri, state,
  code_challenge + `S256`). Token: `POST https://github.com/login/oauth/access_token`.
- GitHub App user token `ghu_`: `expires_in` always 28800 (8h). Refresh token `ghr_`: 15897600 s
  (6 months). `scope` is always empty; the only scope value a GitHub App honours is `offline_access`.
- Refresh (`grant_type=refresh_token`) returns a NEW refresh token. The old refresh token and the
  old access token stop working. A lost response or concurrent refresh breaks the link for good.
- Error bodies follow the Accept header. HTTP 200 with `{error}` is widely reported, not stated in
  the docs, so the client treats any `error` field as failure.
- Not in the docs I read: the `bad_refresh_token` name, and any OAuth scope needed for Copilot
  entitlement. The Copilot SDK page only says it accepts a user `gho_` or `ghu_` token.

## Browser flow

1. `begin(principal)` creates a one-time link URL and pins the current link generation.
2. `GET /github/link/start?nonce=...` serves a no-store landing page. It neither consumes
   the nonce nor starts sign-in, so previews and prefetches are safe.
3. The human submits `POST /github/link/start`. The browser must send the exact configured
   public origin, a URL-encoded body, and the `ghlink_bind` HttpOnly cookie matching the
   hidden `csrf` field. A provided `Sec-Fetch-Site` must be `same-origin`.
   Consent pages use `Referrer-Policy: same-origin`: `no-referrer` makes browsers
   send `Origin: null` on form POSTs. Cross-origin referrers remain suppressed;
   redirects and result pages retain `no-referrer`.
   The initial consent form's CSP permits only itself and the configured Entra
   authorization origin, including the POST's redirect to Entra. Account-switch
   confirmation remains self-only.
4. Entra code + PKCE sign-in returns to `/github/link/entra-callback`. The verified
   tenant and object ID must match the MCP caller. GitHub code + PKCE returns to
   `/github/link/callback`. Both callbacks require the browser-binding cookie.
   Entra sign-in requests `openid profile`; `profile` is required for the immutable
   `oid` claim. These scopes establish identity, not delegated Graph file access.
5. Selecting a different GitHub account serves a second form naming the old and new
   accounts. Only the human's CSRF-protected `POST /github/link/confirm` saves the
   replacement. `BeginOptions.allowRebind` is a compatibility hint, never authorization.

HTTP adapters must forward raw URL-encoded POST bodies as strings or Buffers, with
lowercase header names. They must bound request sizes before buffering. These four
paths are browser routes, not MCP routes; do not exempt `/mcp` from authentication.

## Production boundaries

- Refresh window is 65 minutes (configurable, minimum 3601 s): the Copilot runtime re-asks for any
  token with under an hour left, so `tokenFor` refreshes early and the provider never reports
  `expiresIn` below 3601.
- One refresh across replicas: lease via `putIfMatch`, new pair persisted before it is returned.
- Unknown refresh outcomes persist `reauth-required`. Expired or malformed leases also fail
  closed, never take over and blindly replay a rotating refresh token. No automatic OAuth
  retries occur. A crash after GitHub rotates but before persistence requires relinking.
- `linkGeneration` is stable across refresh, but changes on every relink and unlink.
  Persist and pass `expectedLinkGeneration` for every worker/session continuation.
  `asGitHubTokenProvider(principal, expectedUserId?, expectedGeneration?)` also captures
  a generation at creation. An old provider cannot borrow a same-account relink.
- Providers bind credentials to `githubHost` (default `github.com`). An SDK-supplied
  different host is rejected before returning a token. Expiry is always greater than
  3600 seconds; short, invalid or expired tokens are never presented as non-expiring.
- Unlink blocks local token use immediately and conditionally replaces the row with a
  token-free tombstone before revocation. Retain tombstones: their generation prevents
  stale callbacks on another replica from recreating an unlinked account.
  `unlink` keeps its boolean return on complete success. `GitHubUnlinkPartialError`
  means local unlink succeeded but upstream revocation failed or was unavailable:
  inspect `localUnlinked` and `revocation`, and direct the user to GitHub app settings.
- Production should pass `PrincipalVault` as `cipher` to the service and shared flow
  store. Its AES-256-GCM envelope authenticates principal, immutable GitHub numeric ID,
  link generation and token field as AAD and supports
  read-old/write-current key rings. Legacy encrypting `FieldCipher` remains supported,
  with the same complete identity binding checked inside authenticated plaintext.
  Lease, timestamp and rotation-counter fields remain updateable without resealing.
  Historical principal-only envelopes and rows missing a link generation are not
  accepted for token use; the user must relink. Null ciphers and unencrypted
  token/flow payloads are rejected. Credential keys must be independent of run-data keys.
- `AzureTableGitHubLinkStore` uses exact-ETag writes, never upserts. Shared flow state
  is sealed and bound to the row key; exact-ETag delete makes consumption atomic.
  Flow lifetime is at most ten minutes. Schedule `sweepExpired(Date.now(), 100)` on
  the shared flow store; each cleanup batch is bounded to 1-1000 rows. Read/throttle
  retries are bounded; ambiguous mutation failures are not blindly replayed.
- In-memory flows are development/test only and bounded to 10,000 entries.
  The file link store is single-host only, not safe on network filesystems. It never
  steals timed-out writer locks; after a crash, confirm the writer stopped before
  manually removing its lock.

## Identity policy

Multiple Entra principals may independently link the same immutable GitHub user ID.
There is no reverse uniqueness index and no cross-replica uniqueness claim. Every
operation remains principal-scoped. GitHub can coalesce an app's grants or tokens;
revoking an app/token may therefore require another linked principal to reauthenticate.
Deployments requiring exclusive ownership need a separately reviewed atomic reverse
index and migration, not an in-process check.

## Local validation

`node --import tsx --test "test/github-link/*.test.ts"` runs only synthetic identities,
loopback OAuth providers and a real socket browser-route test. Both fake providers
validate PKCE. `npx --no-install tsc --noEmit --pretty false` checks integration types.
