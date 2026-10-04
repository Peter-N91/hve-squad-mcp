# Stakeholder library

Read this protocol when creating, opening, adopting, repairing, or checkpointing
a project. Maintain a portable Markdown library inside the selected OneDrive or
SharePoint folder. This is Cowork-authored navigation, not new HVE work, a second
artifact store, a SharePoint site, or a source of orchestration decisions.

## Two audiences, one set of authoritative files

Create these four bridge-owned navigation pages:

```text
<project>/
|-- START-HERE.md
`-- library/
    |-- deliverables.md
    |-- decisions.md
    `-- next-steps.md
```

`README.md` points stakeholders to `START-HERE.md`. Keep `artifact-index.md`
as the complete technical inventory, including synchronization receipts,
intermediate outputs, logs, provenance sidecars and legacy records. Link it
under Technical details, not as the default stakeholder library.

The library links to verified canonical mirrors; it never copies, moves,
renames, rewrites, or reformats those artifacts. A BRD under
`.copilot-tracking/plans/<run>/brd/artifact.md` stays there. Navigation filenames
are bridge-owned views, not a new category mapping for server files. Keep all
existing folders and decision records in place.

## Build from evidence, not assumptions

Use the validated local manifest, verified mirror receipts, decision records,
and actual server questions, review findings and next-action guidance already
retrieved for this project. Reading existing evidence to classify a document
or present an open question is allowed; inventing requirements, interpreting
a source document as approval, or choosing an HVE stage is not.

- Show the project name, source checkpoint revision/sequence and observation
  time on every page. Name the current run's actual outcome separately from
  available deliverables and synchronization health. A failed run can have
  a usable unapproved draft. A verified file is not an approved deliverable.
- Do not enumerate other runs through the server merely to populate the
  library. Previously verified local inventory may supply historical links,
  labelled with its original run and last verification time. Unknown or stale
  evidence stays unknown or stale; absence from a partial listing is not proof
  that a deliverable or decision does not exist.
- Use readable titles backed by content or explicit artifact metadata:
  "Business Requirements Document - review draft", not a UUID or `artifact.md`.
  Do not classify an ordinary plan as a BRD from the user's request or its
  parent folder. Unclassified files remain in the technical index.
- Include primary business deliverables first; supporting research, plans and
  reviews follow in a separate section. Keep activity logs, state JSON,
  execution receipts and provenance sidecars out of the primary deliverables
  view. They remain accessible through Technical details.
- Keep document acceptance, run outcome, and mirror state separate. Show
  "Unapproved draft - changes requested" for a verified BRD whose review is
  revise/FAIL. Use "Accepted" only with the server acceptance evidence and any
  required human approval. An acknowledged caution or upload consent is not
  business approval. Native transformations and adopted files retain their
  distinct provenance and link to their source; never label them server output.
- Track a document's stable artifact identity and source version, not just its
  filename or modification time. Use explicit supersedes/version evidence to
  group versions. Show the latest accepted version alongside a newer unapproved
  draft where both exist. If precedence is unknown, show labelled alternatives;
  do not silently promote the newest file or remove prior accepted work.
- A newly discovered but unmirrored document is "Not yet available - retrieval
  pending", with no download link. A conflicting or outdated mirror is labelled
  as such, never offered as the verified current version. Preserve historical
  receipts and links only when explicitly labelled as last-verified evidence.

## Start here: a stakeholder dashboard

Keep this page concise and current, not an append-only activity log. Lead with:

1. Available deliverables: a small curated selection of verified documents,
   using meaningful titles, direct links and explicit draft/acceptance labels.
2. Your decisions: unresolved stakeholder inputs and their impact, with a link
   to the full decision view. Separate actionable same-run questions from
   review findings, deferred decisions, and operator-only blockers.
3. What happens next: the actual next supported action, who must act if known,
   and its prerequisite. Do not manufacture a roadmap or schedule.
4. Health: disclose failed/held runs, pending mirrors, stale pages and incomplete
   checkpoints plainly. Put run IDs and detailed diagnostics behind the index.

Do not make stakeholders search `.copilot-tracking` or read tool transcripts to
discover their deliverables. After a managed turn, link this dashboard and the
actual available deliverables in the response, followed by the pending
decision and next action. Put technical run/checkpoint details afterwards.

## Decisions: an actionable inbox, not a transcript

For each unresolved item show a stable reference, exact question or finding,
why it matters, supplied options, owner, due date, status, evidence link and
supported way to respond. Use "Unassigned" and "Not set" when owner/date are
unknown. Never assign the signed-in user by default.

Distinguish these types:

| Type | Meaning and supported action |
| --- | --- |
| Live server question | Retain exact project/run/question identity, notice, question and choices. Return to Cowork for the native question and same-run response protocol. |
| Stakeholder input from review | Cite the exact finding/open question and affected document. It is not a pending server `humanInput` and cannot resume a terminal run. |
| Deferred collaboration | Link the saved shared decision record. Keep it pending/deferred until a real answer is supplied and verified under the handoff protocol. |
| Operator gate or technical blocker | Label the authorized operator action and permissions from actual server guidance; do not present it as a stakeholder content approval. |

Never manufacture a `questionId` for a review finding. Never display an old
answered or cancelled question as a current same-run prompt merely because its
history remains on disk. Put resolved, superseded, and historical items in a
separate section; preserve their evidence and distinguish answered, submitted,
and server-accepted states. If the live question is not revalidated, show
"Current status unverified" rather than claiming the gate is still open.

Show the complete notice and exact question/choices in the decision view when
available; the dashboard may link to that view rather than shortening consent
language. Reading the library is not proof that a notice was shown in a live
handoff. Editing a Markdown checkbox or a row is not a submitted answer,
approval, or gate release. Collect and persist real answers through the
execution protocol; the library is not an alternate decision API.

If the user elects to retain an unapproved draft, record that disposition
separately from its unresolved review findings. Do not turn draft retention
into business approval, a passing review, or permission for another run.

## Next steps: current actions with provenance

Project the current `next-actions.md`, live server guidance and recorded user
dispositions into a short table: action, prerequisite/decision reference,
actor, status and evidence. Distinguish stakeholder input, operator recovery,
artifact retrieval and server-directed continuation. Link the relevant
decision or deliverable, not merely an activity log.

Keep technical recovery actions in a separate subsection. A terminal run is
not resumable; a new run requires the supported server-directed handoff and
user authorization. No new run is needed just to rebuild this library. Do not
promote historical capability failures to current blockers without evidence.
When no supported next action is known, state that explicitly. Empty decision
lists say "No pending decisions recorded in the verified checkpoint", with
coverage/time, not "All decisions approved".

## Safe refresh and migration

1. Verify the existing project UUID, storage binding and manifest revision.
   Inventory the four navigation paths without changing project identity or
   resetting acknowledgments. On an authorized create/adopt or managed refresh,
   create missing navigation pages only, using no-overwrite preconditions.
2. For an existing project, offer a navigation-only library repair when pages
   are absent. Once authorized, use its current verified evidence and preserve
   history. Do not start `squad_run`, replay a completed run, invoke specialist
   tools, or fabricate missing research to rebuild navigation. No cloud files
   are migrated merely by installing a plugin ZIP.
3. If `library` is already an unrelated file/folder, or a target page/README has
   divergent user content, stop replacement and ask how to reconcile. Preserve
   existing user sections; do not overwrite a whole README to add one link.
   Never invent another library root or move user content to avoid a conflict.
4. Use the artifact-sync identity, last-verified-hash and eTag protections for
   these managed pages. Read current bytes and eTags before each conditional
   refresh; record content hashes, stable item IDs and readback verification.
   Build current views from the full known checkpoint, not only the newest
   response. Replace managed snapshots safely; never keep appending duplicate
   "current" tables or drop older pending decisions on the next poll.
5. Use project-relative Markdown links or verified M365 web links. Paths in
   `library/*.md` need `../` before root-relative artifact paths; paths in
   `START-HERE.md` do not. Validate every published target exists at its bound
   canonical location and version. Encode URL path segments, escape Markdown
   titles/table cells, reject unsafe schemes and never retain signed URLs.
   Do not publish placeholders or links to missing navigation pages.
6. Refresh deliverables, decisions and next steps first; verify them, then
   refresh `START-HERE.md` and the links in README/state/next-actions. Write the
   manifest last with the activity/checkpoint. Record navigation receipts in
   an optional local `stakeholderLibrary` block: `schemaVersion: 1`,
   `sourceRevision`, `sourceSequence`, `refreshedAt`, `status` and `pages[]`
   containing `path`, `driveId`, `itemId`, `eTag`, `sha256`, `verifiedAt`.
   These are bridge-owned pages, not HVE deliverables or additional MCP inputs.
7. If any page cannot be safely refreshed, preserve it, record which view is
   stale/conflicting in the first writable checkpoint/recovery record and the
   user response, and leave reconciliation required. A fresh dashboard must not
   conceal stale child pages. Library publication and artifact synchronization
   are separate checks: it never advances bridge acknowledgments, proves full
   mirroring, closes an active run, or supplies review/approval evidence.

Refresh after verified artifacts or decisions change, after held/failed turns,
on resume, and before the ordinary end-of-turn handoff. For live `humanInput`,
capture the bound hold and ask the native question first; library generation
must not delay that question. Keep the refresh pending and resume it after
presentation/answer handling, or persist it as pending on explicit deferral.

## Initial navigation templates

Use these templates only after the referenced navigation pages exist. Fill the
project label, revision, sequence and observation time from the real checkpoint;
replace empty rows with evidence-backed entries, not invented examples. On
adoption, populate from existing evidence rather than asserting an empty project.

### `START-HERE.md`

```markdown
# <Project name> - Start here

Stakeholder navigation maintained by Cowork. Source checkpoint: <revision> /
<sequence>. Observed: <time>. This page is not business approval.

## Deliverables
[Open the deliverable library](library/deliverables.md)
No verified deliverables recorded yet.

## Your decisions
[Open pending decisions](library/decisions.md)
No pending decisions recorded in the verified checkpoint. Coverage: <coverage>.

## What happens next
[Open next steps](library/next-steps.md)
<Actual supported next action, or "No supported next action recorded".>

## Project health
<Observed run outcome, mirror coverage and checkpoint/library limitations.>

## Technical details
[Full artifact inventory](artifact-index.md) | [Project state](state.md)
```

### `library/deliverables.md`

```markdown
# Deliverable library
[Start here](../START-HERE.md) | [Decisions](decisions.md) | [Next steps](next-steps.md)

Source checkpoint: <revision> / <sequence>. Observed: <time>.

## Primary deliverables
| Deliverable | Document status | Version / run | Mirror state | Open document |
| --- | --- | --- | --- | --- |
| No verified deliverables recorded yet | Unknown | Not established | Pending | Not available |

## Supporting evidence and reviews
No verified supporting documents recorded yet.

## Previous versions and unresolved alternatives
No version relationships established.

[Technical inventory and recovery details](../artifact-index.md)
```

### `library/decisions.md`

```markdown
# Pending decisions
[Start here](../START-HERE.md) | [Deliverables](deliverables.md) | [Next steps](next-steps.md)

Source checkpoint: <revision> / <sequence>. Observed: <time>. Coverage: <coverage>.

## Needs stakeholder input
No pending decisions recorded in the verified checkpoint.

| Reference / type | Question or finding / impact | Owner | Due | Status | Evidence / how to respond |
| --- | --- | --- | --- | --- | --- |

## Operator actions and technical blockers
None recorded in the verified checkpoint.

## Answered, deferred and historical decisions
No decision history recorded yet.

Actual notices and choices appear with their decision entries. Return to Cowork
to answer; editing this page does not submit an answer or release a gate.
[Technical inventory](../artifact-index.md)
```

### `library/next-steps.md`

```markdown
# Next steps
[Start here](../START-HERE.md) | [Deliverables](deliverables.md) | [Decisions](decisions.md)

Source checkpoint: <revision> / <sequence>. Observed: <time>.

## Current actions
| Action | Prerequisite / decision | Actor | Status | Evidence |
| --- | --- | --- | --- | --- |
| No supported next action recorded | Not established | Unassigned | Unknown | Not available |

## Technical recovery
<Verified recovery actions and coverage limitations, or "None recorded".>

[Checkpoint action record](../next-actions.md) | [Technical inventory](../artifact-index.md)
```
