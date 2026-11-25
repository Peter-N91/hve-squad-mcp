import type { FieldCipher } from "../engine/field-cipher.js";
import { PrincipalVault } from "../auth/principal-vault.js";
import { GitHubLinkError } from "./types.js";

export type SealedField = "access" | "refresh" | "pending";

/** Only immutable identity participates; leases and rotation counters stay mutable. */
export function credentialBinding(principalKey: string, identity: { githubUserId: number; linkGeneration?: string }): string {
  if (!Number.isSafeInteger(identity.githubUserId) || identity.githubUserId <= 0 ||
      typeof identity.linkGeneration !== "string" || !identity.linkGeneration) {
    throw new GitHubLinkError("github_link_state_invalid", "Stored GitHub credential identity binding is missing.");
  }
  return JSON.stringify(["github-credential-v2", principalKey, identity.githubUserId, identity.linkGeneration]);
}

/**
 * Token encryption bound to the caller-supplied authenticated identity context.
 *
 * AES-GCM here has no associated-data parameter (FieldCipher is a plain
 * string->string interface), so the binding is carried INSIDE the authenticated
 * plaintext: `{p: binding, f: field, t: token}`. On open we verify `p` and `f`
 * after decrypting. A row copied (file or table entity) to another principal, or an
 * access ciphertext swapped into the refresh slot, therefore fails closed. The GCM
 * tag stops an attacker editing the ciphertext to change `p`. The service uses
 * credentialBinding for every token: principal, immutable GitHub ID and link
 * generation. PrincipalVault authenticates that same context as AEAD AAD.
 */
export class TokenSealer {
  constructor(private readonly cipher: FieldCipher | PrincipalVault) {
    if (!(cipher instanceof PrincipalVault) && !cipher.encrypts) {
      throw new Error("GitHub credential encryption is required.");
    }
  }

  seal(principalKey: string, field: SealedField, token: string): string {
    if (this.cipher instanceof PrincipalVault) return this.cipher.seal(`${principalKey}|${field}`, token);
    const sealed = this.cipher.encrypt(JSON.stringify({ p: principalKey, f: field, t: token }));
    if (!sealed.startsWith("gcm1:")) throw new Error("GitHub credential encryption did not produce an authenticated envelope.");
    return sealed;
  }

  open(principalKey: string, field: SealedField, sealed: string): string {
    if (this.cipher instanceof PrincipalVault) {
      try {
        const token = this.cipher.open<unknown>(`${principalKey}|${field}`, sealed);
        if (typeof token !== "string" || token.length === 0) throw new Error();
        return token;
      } catch {
        throw new GitHubLinkError("github_link_state_invalid", "Stored credential authentication failed.");
      }
    }
    // AesGcmFieldCipher passes non-envelope input through; refuse planted plaintext when encrypting.
    if (this.cipher.encrypts && !sealed.startsWith("gcm1:")) {
      throw new GitHubLinkError("github_link_state_invalid", "Stored GitHub credential is not encrypted.");
    }
    let parsed: { p?: unknown; f?: unknown; t?: unknown };
    try {
      parsed = JSON.parse(this.cipher.decrypt(sealed)) as typeof parsed;
    } catch {
      throw new GitHubLinkError("github_link_state_invalid", "Stored GitHub credential could not be decrypted.");
    }
    if (parsed.p !== principalKey) {
      throw new GitHubLinkError(
        "github_link_principal_mismatch",
        "Stored GitHub credential belongs to a different principal.",
      );
    }
    if (parsed.f !== field || typeof parsed.t !== "string" || parsed.t.length === 0) {
      throw new GitHubLinkError("github_link_state_invalid", "Stored GitHub credential is malformed.");
    }
    return parsed.t;
  }
}
