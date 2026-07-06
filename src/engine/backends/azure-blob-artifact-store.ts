/**
 * Azure Blob artifact store + user-delegation SAS (Phase 2 — the binary-return
 * channel for `squad_render_pptx`).
 *
 * MCP tool results are JSON/text: a `.pptx` cannot be returned inline. This store
 * uploads the rendered deck to a tenant-scoped blob and returns a SHORT-LIVED
 * download link. Because the server authenticates with a MANAGED IDENTITY (no
 * account key), and a bearer token cannot ride in a URL, the only correct link is
 * a USER-DELEGATION SAS: the store asks the service for a user-delegation KEY
 * (signed by the MI), then HMAC-signs the SAS itself.
 *
 * Consistent with the house style (`backends/azure-table-run-state.ts`,
 * `backends/azure-openai.ts`), this talks to the Blob REST API with `fetch` and an
 * INJECTED managed-identity token provider, so there is NO Azure SDK dependency
 * and the signing uses only `node:crypto`. Security posture:
 *
 *   * SEC-3 — the account + container come from operator config, never a caller.
 *   * SEC-10 — the MI access token AND the minted SAS query string are registered
 *     with the logger for redaction; the full download URL (which embeds the SAS)
 *     is NEVER logged. Error paths never include the response body.
 *   * Tenant isolation — the blob path is `renders/<tenantId>/<uuid>/deck.pptx`
 *     with a server-minted, non-guessable `randomUUID()` (VF-H2), the container has
 *     public access disabled, and each link is a per-blob SAS.
 *
 * Live-only: wired by `server-http.ts`, never imported by a network-touching test
 * (the same posture as `azure-table-run-state.ts`).
 */
import { createHmac, randomUUID } from "node:crypto";
import type { RedactingLogger } from "../../observability/logger.js";

/** The Blob REST API version and the matching SAS signed version (pinned together). */
export const BLOB_API_VERSION = "2022-11-02";
/** The `.pptx` MIME type used for the upload + returned to the caller. */
export const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** The user-delegation key fields returned by the service (base64 `value` is the HMAC secret). */
export interface UserDelegationKey {
  signedOid: string;
  signedTid: string;
  signedStart: string;
  signedExpiry: string;
  signedService: string;
  signedVersion: string;
  value: string;
}

export interface AzureBlobArtifactStoreOptions {
  /** Storage account name (operator config; SEC-3). */
  account: string;
  /** Blob container that holds rendered decks (operator config). */
  container: string;
  /** Returns a fresh Storage bearer token (`https://storage.azure.com/.default`). */
  getAccessToken: () => Promise<string>;
  /** Injectable fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Logger used to register the token + SAS as secrets (SEC-10). */
  logger?: RedactingLogger;
  /** Override the blob endpoint host (default `<account>.blob.core.windows.net`). */
  endpoint?: string;
}

/** The parameters that fix a user-delegation SAS string-to-sign (pinned, version-locked). */
export interface UserDelegationSasParams {
  permissions: string; // sp
  start: string; // st
  expiry: string; // se
  canonicalizedResource: string; // /blob/<account>/<container>/<blob>
  key: UserDelegationKey;
  protocol: string; // spr
  version: string; // sv
  resource: string; // sr
}

/**
 * Build the canonical string-to-sign for a blob USER-DELEGATION SAS.
 *
 * The field order + count are LOCKED to the signed version and MUST match the
 * Azure spec exactly — a wrong order silently fails signature validation (RK-1 /
 * OQ-1). This layout is for service version 2020-12-06 and later (which includes
 * `signedEncryptionScope`), verified against
 * learn.microsoft.com/rest/api/storageservices/create-user-delegation-sas.
 * Exported so a golden-string unit test can pin it (VF-H1).
 *
 * Optional fields we never set (saoid, suoid, scid, sip, sst, ses, and the five
 * response-override headers) are present as EMPTY lines in their exact positions.
 */
export function buildUserDelegationStringToSign(p: UserDelegationSasParams): string {
  return [
    p.permissions, // signedPermissions (sp)
    p.start, // signedStart (st)
    p.expiry, // signedExpiry (se)
    p.canonicalizedResource, // canonicalizedResource
    p.key.signedOid, // skoid
    p.key.signedTid, // sktid
    p.key.signedStart, // skt
    p.key.signedExpiry, // ske
    p.key.signedService, // sks
    p.key.signedVersion, // skv
    "", // signedAuthorizedUserObjectId (saoid)
    "", // signedUnauthorizedUserObjectId (suoid)
    "", // signedCorrelationId (scid)
    "", // signedIP (sip)
    p.protocol, // signedProtocol (spr)
    p.version, // signedVersion (sv)
    p.resource, // signedResource (sr)
    "", // signedSnapshotTime (sst)
    "", // signedEncryptionScope (ses)
    "", // rscc (Cache-Control)
    "", // rscd (Content-Disposition)
    "", // rsce (Content-Encoding)
    "", // rscl (Content-Language)
    "", // rsct (Content-Type)
  ].join("\n");
}

/** Format a Date as the second-precision UTC form Azure SAS expects (`YYYY-MM-DDTHH:MM:SSZ`). */
export function toSasTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Read a single XML element's text (Azure responses are well-formed + flat here). */
function xmlValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match ? match[1] : "";
}

export interface RenderArtifactLink {
  /** The full SAS download URL (SECRET — never logged). */
  downloadUrl: string;
  /** ISO expiry of the SAS. */
  expiresAt: string;
  /** The tenant-scoped blob path (safe to log; no query string). */
  blobPath: string;
  /** The deck MIME type. */
  contentType: string;
}

export class AzureBlobArtifactStore {
  private readonly account: string;
  private readonly container: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly baseUrl: string;

  constructor(options: AzureBlobArtifactStoreOptions) {
    this.account = options.account;
    this.container = options.container;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    const host = options.endpoint ?? `https://${this.account}.blob.core.windows.net`;
    this.baseUrl = host.replace(/\/$/, "");
  }

  private async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    this.logger?.registerSecret(token);
    return {
      Authorization: `Bearer ${token}`,
      "x-ms-version": BLOB_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
      ...extra,
    };
  }

  /** PUT a block blob at `blobPath` (tenant-scoped path minted by the caller). */
  private async putBlob(blobPath: string, bytes: Uint8Array): Promise<void> {
    const url = `${this.baseUrl}/${this.container}/${blobPath}`;
    const headers = await this.authHeaders({
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": PPTX_CONTENT_TYPE,
    });
    const response = await this.fetchImpl(url, { method: "PUT", headers, body: bytes });
    if (!response.ok) {
      // Never include the response body — it can echo a header or token.
      throw new Error(`Blob upload failed with status ${response.status}.`);
    }
  }

  /** Ask the service for a user-delegation key valid over [start, expiry]. */
  private async getUserDelegationKey(start: Date, expiry: Date): Promise<UserDelegationKey> {
    const url = `${this.baseUrl}/?restype=service&comp=userdelegationkey`;
    const body = `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${toSasTime(start)}</Start><Expiry>${toSasTime(expiry)}</Expiry></KeyInfo>`;
    const headers = await this.authHeaders({ "Content-Type": "application/xml" });
    const response = await this.fetchImpl(url, { method: "POST", headers, body });
    if (!response.ok) {
      throw new Error(`Get user delegation key failed with status ${response.status}.`);
    }
    const xml = await response.text();
    const key: UserDelegationKey = {
      signedOid: xmlValue(xml, "SignedOid"),
      signedTid: xmlValue(xml, "SignedTid"),
      signedStart: xmlValue(xml, "SignedStart"),
      signedExpiry: xmlValue(xml, "SignedExpiry"),
      signedService: xmlValue(xml, "SignedService"),
      signedVersion: xmlValue(xml, "SignedVersion"),
      value: xmlValue(xml, "Value"),
    };
    // Fail-fast if the response shape changed and the signing key is absent — a
    // silently-empty key would mint a signature that Azure rejects at download.
    if (key.value.length === 0) {
      throw new Error("User delegation key response did not contain a signing key.");
    }
    return key;
  }

  /** HMAC-sign and assemble the user-delegation SAS query string for `blobPath`. */
  private mintDownloadSas(blobPath: string, key: UserDelegationKey, start: Date, expiry: Date): string {
    const sp = "r";
    const st = toSasTime(start);
    const se = toSasTime(expiry);
    const canonicalizedResource = `/blob/${this.account}/${this.container}/${blobPath}`;
    const stringToSign = buildUserDelegationStringToSign({
      permissions: sp,
      start: st,
      expiry: se,
      canonicalizedResource,
      key,
      protocol: "https",
      version: BLOB_API_VERSION,
      resource: "b",
    });
    const signature = createHmac("sha256", Buffer.from(key.value, "base64"))
      .update(stringToSign, "utf8")
      .digest("base64");
    const params: [string, string][] = [
      ["sv", BLOB_API_VERSION],
      ["sr", "b"],
      ["sp", sp],
      ["st", st],
      ["se", se],
      ["spr", "https"],
      ["skoid", key.signedOid],
      ["sktid", key.signedTid],
      ["skt", key.signedStart],
      ["ske", key.signedExpiry],
      ["sks", key.signedService],
      ["skv", key.signedVersion],
      ["sig", signature],
    ];
    return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }

  /**
   * Upload the rendered deck and return a short-lived download link. Mints a
   * non-guessable, tenant-scoped blob path (VF-H2), uploads, then issues a
   * user-delegation SAS over exactly that blob. The SAS query string is registered
   * as a secret and the full URL is never logged (SEC-10).
   */
  async uploadAndMintDownloadSas(
    tenantId: string,
    bytes: Uint8Array,
    ttlMs: number,
  ): Promise<RenderArtifactLink> {
    const artifactId = randomUUID();
    const blobPath = `renders/${encodeURIComponent(tenantId)}/${artifactId}/deck.pptx`;
    await this.putBlob(blobPath, bytes);

    const now = Date.now();
    // Backdate the start slightly for clock skew; expiry is now + ttl.
    const start = new Date(now - 5 * 60 * 1000);
    const expiry = new Date(now + ttlMs);
    const key = await this.getUserDelegationKey(start, expiry);
    const sas = this.mintDownloadSas(blobPath, key, start, expiry);
    // SEC-10: the SAS grants read on the blob — treat it as a secret.
    this.logger?.registerSecret(sas);

    const downloadUrl = `${this.baseUrl}/${this.container}/${blobPath}?${sas}`;
    // Log only the base URL (no query); never the SAS.
    this.logger?.info?.("render artifact uploaded", { blobPath });
    return {
      downloadUrl,
      expiresAt: expiry.toISOString(),
      blobPath,
      contentType: PPTX_CONTENT_TYPE,
    };
  }
}
