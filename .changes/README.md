# Change fragments

Every pull request adds ONE file to `unreleased/`. Nothing edits `CHANGELOG.md`
or the version in `package.json` — those move on `main`, assembled from these
fragments by `npm run release:prep`. Two concurrent PRs therefore never conflict
on the changelog, which is the whole reason fragments exist.

Create one with:

```powershell
npm run change
```

## Format

`unreleased/<YYYYMMDD>-<slug>.md`:

```markdown
---
bump: patch
type: Fixed
---

- **The consumption ledger dropped every role but the last turn's.** Rows now
  derive from every consumption block recorded in `history/*.md` for the run
  (`src/engine/squad-ledger.ts`).
```

### `type`

One of the Keep a Changelog sections, in this order: `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, `Security`.

### `bump`

The highest `bump` across all pending fragments decides the next version.

| Value   | Use when                                                              |
|---------|-----------------------------------------------------------------------|
| `major` | A consumer must change their integration                              |
| `minor` | A genuinely new idea, or something that materially changes how the package is used |
| `patch` | Everything else                                                       |

**The level tracks ideas, not artifacts.** Adding an agent, a role, or a tool
under a capability that already shipped is a `patch`. Adding the *capability* is
a `minor`. Re-pinning the bundled cast to a hve-squad release that reshapes the
roster is a `minor`, because the squad a consumer gets is different.

### Body

Markdown bullets, written as the final release notes rather than as commit
messages. Lead with a bold sentence naming the problem, then say what changed,
citing paths in backticks. The text is copied into `CHANGELOG.md` verbatim.

## Skipping

A change with no consumer-visible effect — a test-only refactor, a typo in a
comment — can carry the `skip-changelog` label instead of a fragment. PR
validation accepts either, and nothing else.
