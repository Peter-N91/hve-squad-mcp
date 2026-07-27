/**
 * Blob overflow channel tests (WI-03).
 *
 * The overflow decorator keeps the primary {@link SquadMemoryStore} unchanged for
 * small entries and spills over-threshold content to a Blob while leaving a tiny
 * pointer entity in the primary. These tests drive a real {@link FileSquadMemoryStore}
 * primary + a FAKE {@link MemoryBlobWriter} (no Azure, no network) and pin the
 * load-bearing behaviors:
 *   * under-threshold content round-trips through the primary only (no blob call);
 *   * over-threshold content writes a blob + a pointer entity and reads back
 *     byte-identical;
 *   * the blob payload is the encrypted envelope (at-rest parity; the `gcm1:`
 *     prefix) and the pointer marker never contains the caller's plaintext;
 *   * a CAS conflict is still surfaced via the primary's pointer entity.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import {
  OverflowSquadMemoryStore,
  type MemoryBlobWriter,
} from "../src/engine/backends/overflow-squad-memory.js";
import { AesGcmFieldCipher } from "../src/engine/field-cipher.js";

/** A fake blob seam recording every PUT/GET, with the raw stored bytes exposed. */
class FakeBlobWriter implements MemoryBlobWriter {
  readonly blobs = new Map<string, Uint8Array>();
  puts = 0;
  gets = 0;
  async put(blobPath: string, bytes: Uint8Array): Promise<void> {
    this.puts += 1;
    this.blobs.set(blobPath, Uint8Array.from(bytes));
  }
  async get(blobPath: string): Promise<Uint8Array | undefined> {
    this.gets += 1;
    return this.blobs.get(blobPath);
  }
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "memory-overflow-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fresh cipher (a random 32-byte key) so the at-rest envelope is real AES-GCM. */
function freshCipher(): AesGcmFieldCipher {
  return new AesGcmFieldCipher(randomBytes(32));
}

/** Build a decorator over a fresh file primary + fake blob, sharing one cipher. */
function buildStack(thresholdBytes: number) {
  const { dir, cleanup } = tempDir();
  const cipher = freshCipher();
  const primary = new FileSquadMemoryStore({ baseDir: dir, cipher });
  const blob = new FakeBlobWriter();
  const store = new OverflowSquadMemoryStore({ primary, blob, cipher, thresholdBytes });
  return { store, primary, blob, cipher, cleanup };
}

test("under-threshold content round-trips through the primary only (no blob call)", async () => {
  const { store, blob, cleanup } = buildStack(4096);
  try {
    const write = await store.write("tenant-a", "alpha", "state", "small value");
    assert.equal(write.ok, true, "the small write succeeds");
    assert.equal(blob.puts, 0, "a small write never touches the blob channel");

    const read = await store.read("tenant-a", "alpha", "state");
    assert.equal(read?.content, "small value", "the small content round-trips via the primary");
    assert.equal(blob.gets, 0, "a small read never touches the blob channel");
  } finally {
    cleanup();
  }
});

test("over-threshold content writes a blob + pointer entity and reads back byte-identical", async () => {
  const { store, blob, cleanup } = buildStack(128);
  try {
    const big = "L".repeat(5000);
    const write = await store.write("tenant-a", "alpha", "decisions", big);
    assert.equal(write.ok, true, "the large write succeeds");
    assert.ok(write.ok && write.etag.length > 0, "a large write yields a CAS token from the pointer entity");
    assert.equal(blob.puts, 1, "the large write spills exactly one blob payload");
    assert.equal(write.ok && write.entry.content, big, "the write result presents the caller's real content");

    const read = await store.read("tenant-a", "alpha", "decisions");
    assert.equal(read?.content, big, "the large content rehydrates byte-identically");
    assert.equal(read?.content.length, 5000, "the rehydrated content has the exact original length");
    assert.equal(blob.gets, 1, "the read fetched the payload from the blob channel");
  } finally {
    cleanup();
  }
});

test("the blob payload is the encrypted envelope and the pointer marker holds no plaintext", async () => {
  const { store, primary, blob, cleanup } = buildStack(128);
  try {
    const secret = "TOP-SECRET-PLAINTEXT-" + "z".repeat(5000);
    await store.write("tenant-a", "alpha", "notes", secret);

    // The primary's pointer entity carries only a `blobref:` marker — never the text.
    const pointer = await primary.read("tenant-a", "alpha", "notes");
    assert.ok(pointer, "the primary holds a pointer entity");
    assert.match(pointer?.content ?? "", /^blobref:v1:[0-9a-f]{64}:memory\//, "the marker is a blobref pointer");
    assert.ok(!(pointer?.content ?? "").includes("TOP-SECRET-PLAINTEXT"), "the marker never contains plaintext");

    // The blob payload is the AES-GCM envelope (at-rest parity), not plaintext.
    const [storedBytes] = [...blob.blobs.values()];
    const payload = Buffer.from(storedBytes).toString("utf8");
    assert.match(payload, /^gcm1:/, "the blob payload is the encrypted `gcm1:` envelope");
    assert.ok(!payload.includes("TOP-SECRET-PLAINTEXT"), "the blob payload never contains plaintext");
  } finally {
    cleanup();
  }
});

test("a corrupted blob payload is rejected on read (sha256 integrity check)", async () => {
  const { store, blob, cleanup } = buildStack(128);
  try {
    await store.write("tenant-a", "alpha", "state", "Q".repeat(5000));
    // Swap the stored bytes for a different valid envelope — the digest no longer matches.
    const [blobPath] = [...blob.blobs.keys()];
    blob.blobs.set(blobPath, Buffer.from("gcm1:tampered-envelope", "utf8"));
    await assert.rejects(() => store.read("tenant-a", "alpha", "state"), /integrity check/);
  } finally {
    cleanup();
  }
});

test("CAS conflict on an overflowed entry is surfaced via the pointer entity", async () => {
  const { store, cleanup } = buildStack(128);
  try {
    const first = await store.write("tenant-a", "alpha", "state", "A".repeat(5000));
    assert.ok(first.ok);
    const staleEtag = first.ok ? first.etag : "";

    // A matching-etag write wins and rotates the CAS token.
    const second = await store.write("tenant-a", "alpha", "state", "B".repeat(5000), staleEtag);
    assert.equal(second.ok, true, "the matching-etag write wins the CAS");

    // A second write with the now-stale etag loses the race at the pointer entity.
    const conflict = await store.write("tenant-a", "alpha", "state", "C".repeat(5000), staleEtag);
    assert.equal(conflict.ok, false, "the stale-etag write loses the CAS race");
    assert.equal(conflict.ok === false && conflict.conflict, true, "the conflict is surfaced");
    assert.equal(
      conflict.ok === false && conflict.current?.content,
      "B".repeat(5000),
      "the surfaced current entry is rehydrated to the winning content",
    );
  } finally {
    cleanup();
  }
});

test("overflow list rehydrates pointer entries and passes small entries through", async () => {
  const { store, cleanup } = buildStack(128);
  try {
    await store.write("tenant-a", "alpha", "small", "tiny");
    await store.write("tenant-a", "alpha", "big", "M".repeat(5000));

    const listed = await store.list("tenant-a", "alpha");
    const byPath = new Map(listed.map((e) => [e.path, e.content]));
    assert.equal(byPath.get("small"), "tiny", "a small entry lists through unchanged");
    assert.equal(byPath.get("big"), "M".repeat(5000), "an overflowed entry rehydrates in the list");
  } finally {
    cleanup();
  }
});
