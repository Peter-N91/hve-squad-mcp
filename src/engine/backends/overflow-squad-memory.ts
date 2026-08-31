/**
 * Blob overflow channel for the squad-memory store (WI-03).
 *
 * Azure Table Storage caps a single string property at 32 KiB and an entity at
 * ~1 MiB, so a large memory `content` (a long decision log, a fat repo-memory
 * note) cannot land in the table verbatim. This DECORATOR keeps the primary
 * {@link SquadMemoryStore} unchanged for small entries and, for over-threshold
 * content, spills the (encrypted) payload to a tenant-scoped Blob while leaving a
 * tiny POINTER entity in the primary store. Reads rehydrate the payload
 * transparently, so callers see one seamless store regardless of size.
 *
 * The decorator is FEATURE-FLAGGED off by default (wired only when the operator
 * sets `memoryOverflowEnabled`); when absent the primary store's behavior is
 * byte-for-byte unchanged. Security posture, held here as well as in the primary:
 *
 *   * At-rest parity (MEDIUM-3) — the blob payload is the SAME AES-256-GCM
 *     envelope the table store would have persisted (`cipher.encrypt(content)`),
 *     so the caller's text is opaque at rest in Blob exactly as it is in Table.
 *     The decorator is injected the SAME {@link FieldCipher} the primary uses.
 *   * No-plaintext pointer — the marker stored in the primary is only
 *     `blobref:v1:<sha256>:<blobPath>`; it never contains the caller's content, so
 *     an operator reading the table sees a reference and a digest, never the text.
 *   * Tenant isolation (SEC-4) — the blob path is
 *     `memory/<tenantId>/<encodedProject>/<encodedPath>` with every segment
 *     percent-encoded and the same safe-segment/path guard the primary applies, so
 *     a traversal payload can never escape the tenant's prefix.
 *   * Integrity — the marker carries a SHA-256 of the exact stored envelope bytes;
 *     a read verifies the digest before rehydrating, so a swapped/corrupted blob
 *     is detected rather than silently returned.
 *
 * CAS is unchanged: the pointer entity lives in the primary store, so its ETag IS
 * the CAS token and a stale-etag write still loses the race at the primary — the
 * blob is content-addressed spill, never the concurrency authority.
 */
import { createHash } from "node:crypto";

import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryEntry,
  type SquadMemoryStore,
  type SquadMemoryWriteResult,
} from "../squad-memory-state.js";
import { NullFieldCipher, type FieldCipher } from "../field-cipher.js";

/**
 * The minimal blob seam the overflow decorator writes through: a tenant-scoped
 * PUT/GET of opaque bytes at a caller-minted path. Interface-first (like
 * {@link SquadMemoryStore}) so a fake drives the unit tests and the live wiring
 * binds an {@link import("./azure-blob-artifact-store.js").AzureBlobArtifactStore}-backed
 * adapter — no Azure SDK, no network in tests.
 */
export interface MemoryBlobWriter {
  /** PUT `bytes` at `blobPath` (create-or-replace). */
  put(blobPath: string, bytes: Uint8Array): Promise<void>;
  /** GET the bytes at `blobPath`, or `undefined` when the blob is absent. */
  get(blobPath: string): Promise<Uint8Array | undefined>;
}

export interface OverflowSquadMemoryStoreOptions {
  /** The wrapped store that holds small entries + the overflow pointer entities. */
  primary: SquadMemoryStore;
  /** The blob seam the over-threshold (encrypted) payload spills to. */
  blob: MemoryBlobWriter;
  /**
   * The SAME field cipher the primary store uses, so the blob payload is the
   * identical encrypted envelope (at-rest parity; MEDIUM-3). Default identity.
   */
  cipher?: FieldCipher;
  /**
   * The byte length (of the ENCRYPTED envelope) above which content spills to
   * Blob. Content whose envelope is `<=` this delegates to the primary unchanged.
   */
  thresholdBytes: number;
}

/** Marker prefix identifying a primary entity whose real content lives in Blob. */
const MARKER_PREFIX = "blobref:v1:";
/** SHA-256 hex is a fixed 64 characters — a stable split point in the marker. */
const SHA256_HEX_LENGTH = 64;

/** Build the pointer marker persisted in the primary store for an overflowed entry. */
function buildMarker(sha256Hex: string, blobPath: string): string {
  return `${MARKER_PREFIX}${sha256Hex}:${blobPath}`;
}

/**
 * Parse a pointer marker, or `undefined` when `content` is ordinary text. The
 * SHA-256 is a fixed 64-char field, so the blob path (which may itself contain
 * `:` or `/`) is the unambiguous remainder after the single separator.
 */
function parseMarker(content: string): { sha256Hex: string; blobPath: string } | undefined {
  if (!content.startsWith(MARKER_PREFIX)) {
    return undefined;
  }
  const body = content.slice(MARKER_PREFIX.length);
  const sha256Hex = body.slice(0, SHA256_HEX_LENGTH);
  if (sha256Hex.length !== SHA256_HEX_LENGTH || body.charAt(SHA256_HEX_LENGTH) !== ":") {
    return undefined;
  }
  const blobPath = body.slice(SHA256_HEX_LENGTH + 1);
  if (blobPath.length === 0) {
    return undefined;
  }
  return { sha256Hex, blobPath };
}

/** The tenant-scoped, content-addressed blob path for an overflowed payload.
 *
 * Every segment is percent-encoded (SEC-4) and the payload's SHA-256 is the final
 * segment, so each DISTINCT envelope lands at a DISTINCT path. That content
 * addressing is load-bearing for CAS: the blob is PUT before the pointer's
 * compare-and-swap, so a losing writer must never clobber the WINNER's payload —
 * with a content-independent path it would, corrupting the winner's pointer. A
 * losing write instead spills a harmless orphan blob the winner's pointer ignores.
 */
function blobPathFor(tenantId: string, project: string, path: string, sha256Hex: string): string {
  return `memory/${encodeURIComponent(tenantId)}/${encodeURIComponent(project)}/${encodeURIComponent(path)}/${sha256Hex}`;
}

export class OverflowSquadMemoryStore implements SquadMemoryStore {
  private readonly primary: SquadMemoryStore;
  private readonly blob: MemoryBlobWriter;
  private readonly cipher: FieldCipher;
  private readonly thresholdBytes: number;

  constructor(options: OverflowSquadMemoryStoreOptions) {
    this.primary = options.primary;
    this.blob = options.blob;
    this.cipher = options.cipher ?? new NullFieldCipher();
    this.thresholdBytes = options.thresholdBytes;
  }

  async list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    const entries = await this.primary.list(tenantId, project);
    return Promise.all(entries.map((entry) => this.rehydrateEntry(entry)));
  }

  async listUpdatedSince(
    tenantId: string,
    project: string,
    updatedAt: number,
  ): Promise<SquadMemoryEntry[]> {
    const entries = this.primary.listUpdatedSince
      ? await this.primary.listUpdatedSince(tenantId, project, updatedAt)
      : (await this.primary.list(tenantId, project)).filter(
          (entry) => entry.updatedAt >= updatedAt,
        );
    return Promise.all(entries.map((entry) => this.rehydrateEntry(entry)));
  }

  async read(tenantId: string, project: string, path: string): Promise<SquadMemoryEntry | undefined> {
    const entry = await this.primary.read(tenantId, project, path);
    return entry ? this.rehydrateEntry(entry) : undefined;
  }

  async write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    // Produce the encrypted envelope the primary store WOULD persist, and measure
    // it: the overflow decision is on the at-rest byte length, not the plaintext.
    const envelope = this.cipher.encrypt(content);
    const envelopeBytes = Buffer.from(envelope, "utf8");
    const safe =
      isSafeMemorySegment(tenantId) && isSafeMemorySegment(project) && isSafeMemoryPath(path);

    // Small content (or an unsafe key the primary will reject anyway) delegates
    // unchanged — no blob call, identical behavior to a store without overflow.
    if (!safe || envelopeBytes.byteLength <= this.thresholdBytes) {
      return this.primary.write(tenantId, project, path, content, expectedEtag);
    }

    // Over threshold: spill the encrypted envelope to Blob FIRST (so a reader can
    // never observe a pointer to a not-yet-written blob), then write the tiny
    // pointer entity to the primary under the same CAS token. The blob path is
    // content-addressed (its own sha256), so a losing CAS writer cannot clobber
    // the winner's payload — it only leaves a harmless orphan.
    const sha256Hex = createHash("sha256").update(envelopeBytes).digest("hex");
    const blobPath = blobPathFor(tenantId, project, path, sha256Hex);
    await this.blob.put(blobPath, envelopeBytes);
    const marker = buildMarker(sha256Hex, blobPath);
    const result = await this.primary.write(tenantId, project, path, marker, expectedEtag);
    if (!result.ok) {
      // The CAS race was lost at the pointer entity; surface the current entry
      // (rehydrated when it is itself an overflow pointer) so the caller can retry.
      const current = result.current ? await this.rehydrateEntry(result.current) : undefined;
      return { ok: false, conflict: true, current };
    }
    // Present the caller's real content (not the marker) with the primary's etag.
    return { ok: true, etag: result.etag, entry: { ...result.entry, content } };
  }

  listProjects(tenantId: string): Promise<string[]> {
    return this.primary.listProjects(tenantId);
  }

  /**
   * Return `entry` unchanged when it is ordinary content, or rehydrate an overflow
   * pointer by fetching + integrity-checking + decrypting the blob payload. The
   * ETag is always the primary's (the CAS authority), never the blob's.
   */
  private async rehydrateEntry(entry: SquadMemoryEntry): Promise<SquadMemoryEntry> {
    const marker = parseMarker(entry.content);
    if (marker === undefined) {
      return entry;
    }
    const bytes = await this.blob.get(marker.blobPath);
    if (bytes === undefined) {
      throw new Error("Overflow blob payload is missing for a pointer entry.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== marker.sha256Hex) {
      throw new Error("Overflow blob payload failed its integrity check (sha256 mismatch).");
    }
    const content = this.cipher.decrypt(Buffer.from(bytes).toString("utf8"));
    return { ...entry, content };
  }
}
