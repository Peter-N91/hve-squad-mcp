---
bump: patch
type: Fixed
---

- Cowork plugin 11.0.16 / skill 1.17 requires artifact synchronization after
  every run/status response, including active, held, and failed runs. Read-only
  history discovers actual run-scoped persisted artifacts; complete paged/spilled
  content is verified before the exact canonical mirror is written. HVE's own
  persisted storage structure is authoritative: artifact parents are created
  only on demand, not as generic categories or a parallel duplicate tree.
  BRDs stay at their actual paths, including under plans. Planner details,
  lineage, partial/unaccepted status, and linked inventory are preserved without
  inventing stage success. PM metadata is consolidated with verified inventory.
- Existing folders and old category copies are preserved as legacy, without
  automatic deletion/relocation or further duplication. Canonical backfill uses
  full server reads, not guessed paths or stale copies; existing decision
  records resume in place and new bridge decision metadata is under activity.
- Retrieval prefers opt-in offset paging only when advertised, validating
  contiguous UTF-16 offsets, page/full hashes, source version metadata, and
  final UTF-8 bytes. Source etag/endOffset fields are not required. Legacy
  no-offset truncation stays pending; exact hash-verified inline content does
  not require a spill based solely on size.
- Machine envelopes are decoded once; exact artifact content can be transported
  without local materialization. Supplied eTags/end offsets are validated; a
  final page's truncated flag does not override full-assembly hash/length checks.
  Full history listing, not bounded trackingUpdatePaths, determines persisted
  inventory coverage.
- Host-exposed current-task raw result capture may supply exact artifact bytes
  with the same identity/range/hash checks; no hardcoded capture paths, broad
  log/session scanning, or mandatory spill dependency is introduced.
- Source/mirror hashes, stable item ids/eTags, and conditional writes protect
  user edits during mutable-file refresh. Partial mirroring never finalizes
  active work or advances full projection acknowledgment. Package validation
  and ZIP packaging require the synchronization reference and skill metadata.
  This changes plugin guidance only, not server behavior or deployment, and
  does not establish production BRD acceptance.
