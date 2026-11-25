# Cowork + Code adapter testing (plugin 11.0.25)

Status: local authoring/contract tests, not a claim of tenant connector availability.
No backend change, additional permission, receipt-ingestion endpoint, automatic
Code session creation or deployment is introduced by this increment.

## Build and install deliberately

From the repository root:

```powershell
npm run generate:cowork:check
npm run lint
node --import tsx --test test/code-handoff.test.ts test/cowork-plugin.test.ts
pwsh -NoProfile -File cowork/pack.ps1 -Fqdn '<existing-host>' `
  -OAuthReferenceId '<existing-registration-id>' `
  -OutputPath '<private-output>/hve-squad-cowork-code-11.0.25.zip'
```

The manifest retains its existing app ID and OAuth connector. Use the SAME
existing resource/registration, not new scopes or shared maker credentials.
Keep tenant-specific packages outside Git. Never commit endpoints or identifiers.
A template package with unresolved placeholders is for inspection, not live use.
The versioned test ZIP must not overwrite a previous known-good ZIP.

Upload manually through Cowork > Customize > Plugins > Upload plugin (Only you).
This is an explicit installation step, not part of building the source. Verify
version 11.0.25 and both hve-project-manager (1.23) and hve-code-implement (0.1.0).
Use a new Code session so the host can resync plugin skills/connections. Installation
and live connector consent are separate; do not infer auth from visible skills.

## Test 1: capability exposure (no mutation)

In Code:

> Use HVE project manager for a read-only capability check. Do not create a run,
> resume work, approve, answer or sync. Report skill and connector availability
> separately and discover the live Squad tools. Do not print credentials.

Pass for native lifecycle integration: the required live tool definitions are
visible and authorized. On a selected existing project, an explicitly authorized
read-only status check uses the real saved run and canonical binding. Do not
poll a terminal failed run as a way of restarting it. Missing tools are
connector-unavailable, not a request to add local mcpServers or loosen scopes.
Check M365 registration/connection, rollout/policy and server exposure with the
operator. The repository cannot force Code's host to expose the connector.

## Test 2: artifact-only implementation

Select an existing synthetic schema-2 OneDrive/SharePoint project and its real
folder URL. Keep that URL/private identifiers in the session, not this repository.

> Use hve-code-implement against this exact existing project. Discover capabilities
> first. Implement the versioned specs as an experimental draft test only; preserve
> the failed/unapproved status and every finding. Save editable source and a
> versioned implementation receipt under implementation/ in the SAME folder.
> No publishing, deployment, sharing, GitHub, work data or manifest/ledger edits.

Expected: missing Squad tools are reported, mode is artifact-only, and only
explicitly authorized versioned inputs permit the separate native workflow.
Native implementation is not emulation of missing HVE planning. If the specs
or reviews conflict, ask before proceeding. An experimental override is recorded,
not used to release a server gate or claim HVE approval.

## Test 3: independent evidence

- Verify actual parent drive/folder and file item IDs, eTags, lengths and full
  hashes through cloud read-back, not just session-local paths or syncing labels.
- Check that inputs did not change between selection and receipt commit.
- Confirm the source and receipt appear in the local OneDrive sync folder.
- In a local staging/synced copy containing the manifest, input specs and outputs:

```console
node <installed-skill>/scripts/verify-receipt.mjs <receipt.json> <bound-project-root>
```

The dependency-free helper checks schema, project binding, safe paths and all
staged input/output hashes. It never runs project code. Its success DOES NOT
verify human consent/authority, actual Graph eTags, approval, or truth of tests.
These require independent native/API evidence. Use the actual host tools to
verify cloud metadata and run app-specific tests, recording cloud/local/static
provenance separately. Not-run is not pass. Screen-reader and human visual checks
remain not-run until performed. There is no implicit overall approval field.

## Negative tests

1. Change an input hash/version: reconfirm, do not reuse implementation consent.
2. Alter an output: helper exits 1; no successful verification claim.
3. Change project UUID/drive/folder: stop; never rebind silently.
4. Existing divergent output: preserve it; require matching base hash + eTag for
   authorized update. A transport timeout requires reconciliation, not replay.
5. Give a draft without explicit experimental authorization: stop and ask.
6. Connector absent: HVE run/control operations stay blocked.
7. Fake a UI button/test claim: record failure/not-run; do not close HVE findings.
8. Native evidence receipt: reject it as a gate-release command or canonical ledger.
9. Symlink/shortcut outside project or traversal path: reject.
10. Retry with changed project/run/question: require the original PM checks and
    new applicable consent. A source failure remains failed.

## Return and rollback

Return the receipt item reference/hash to Cowork. The project manager independently
reads it as untrusted implementation evidence and updates navigation under its
existing single-writer/eTag rules. It does not edit HVE originals or approve the
result. A new server review is separately authorized work through squad_run.

To roll back, install the retained known-good package and start a fresh session.
Keep already created implementation evidence; do not delete files or change
server flags/credentials as part of rollback. No deployed backend was modified.
