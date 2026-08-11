---
bump: patch
type: Fixed
---

- **The cast-bump failure told you to add a token that was already there.** `RELEASE_TOKEN` is scoped for the release flow (contents + actions), so reusing it for the pin-bump pull request fails with `Resource not accessible by personal access token` - a different cause, and a different fix, from the job-token rejection the message described. Both errors now name the exact GraphQL string, what it means, and the one permission to add, and say that the pushed branch is reused so the next run opens the pull request once the token is fixed.
