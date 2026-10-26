/**
 * In-process fakes for the GitHub link tests. Everything listens on 127.0.0.1 with an
 * ephemeral port; no real credentials and no external network are used.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, generateKeyPair, jwtVerify } from "jose";

import type { JwtClaims, JwtVerifier, UserPrincipal } from "../../src/auth/entra.js";
import { AesGcmFieldCipher } from "../../src/engine/field-cipher.js";
import { EntraBrowserSignIn } from "../../src/github-link/entra-sign-in.js";
import { GitHubOAuthClient } from "../../src/github-link/github-oauth-client.js";
import { GitHubLinkService, type GitHubLinkServiceOptions } from "../../src/github-link/service.js";
import { InMemoryGitHubLinkStore } from "../../src/github-link/store.js";
import type { GitHubLinkStore } from "../../src/github-link/types.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

export const PUBLIC_BASE = "https://mcp.test";
export const CLIENT_ID = "test-client-id";
export const CLIENT_SECRET = "test-client-secret";

type GeneratedKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (prefix = "") => `${prefix}${randomBytes(18).toString("hex")}`;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface FakeGitHubUser {
  id: number;
  login: string;
}

interface TokenRow {
  user: FakeGitHubUser;
}

export class FakeGitHub {
  url = "";
  refreshCalls = 0;
  exchangeCalls = 0;
  refreshDelayMs = 0;
  refreshMode: "ok" | "server_error" = "ok";
  tokenStyle: "ghu" | "gho" = "ghu";
  readonly revoked: string[] = [];
  /** Every secret this fake ever issued (codes, access and refresh tokens). */
  readonly secrets = new Set<string>();
  readonly accessTokens = new Map<string, TokenRow>();
  readonly refreshTokens = new Map<string, TokenRow>();
  private readonly codes = new Map<string, { user: FakeGitHubUser; challenge?: string; redirectUri: string }>();
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => json(res, 500, { message: "fake failure" }));
    });
    this.url = await listen(this.server);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Simulates the user approving on github.com. Returns the callback URL the browser is sent to. */
  authorize(authorizeUrl: string, user: FakeGitHubUser): string {
    const url = new URL(authorizeUrl);
    if (url.origin !== this.url || url.pathname !== "/login/oauth/authorize") {
      throw new Error(`not a GitHub authorize URL: ${url.origin}${url.pathname}`);
    }
    const code = rand("code_");
    this.secrets.add(code);
    this.codes.set(code, {
      user,
      challenge: url.searchParams.get("code_challenge") ?? undefined,
      redirectUri: url.searchParams.get("redirect_uri") as string,
    });
    const back = new URL(url.searchParams.get("redirect_uri") as string);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") as string);
    return back.toString();
  }

  /** Make every outstanding refresh token invalid, as if the user revoked the app. */
  revokeAllRefreshTokens(): void {
    this.refreshTokens.clear();
  }

  issueFor(user: FakeGitHubUser): Record<string, unknown> {
    const accessToken = rand(this.tokenStyle === "ghu" ? "ghu_" : "gho_");
    this.secrets.add(accessToken);
    this.accessTokens.set(accessToken, { user });
    if (this.tokenStyle === "gho") {
      return { access_token: accessToken, scope: "", token_type: "bearer" };
    }
    const refreshToken = rand("ghr_");
    this.secrets.add(refreshToken);
    this.refreshTokens.set(refreshToken, { user });
    return {
      access_token: accessToken,
      expires_in: 28800,
      refresh_token: refreshToken,
      refresh_token_expires_in: 15897600,
      scope: "",
      token_type: "bearer",
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
        return json(res, 200, { error: "incorrect_client_credentials", error_description: "bad client" });
      }
      if (form.get("grant_type") === "refresh_token") {
        this.refreshCalls++;
        if (this.refreshDelayMs) await sleep(this.refreshDelayMs);
        if (this.refreshMode === "server_error") {
          return json(res, 500, { message: "boom" });
        }
        const presented = form.get("refresh_token") ?? "";
        const row = this.refreshTokens.get(presented);
        if (!row) {
          // HTTP 200 with an error body, and a description that echoes the secret on purpose.
          return json(res, 200, {
            error: "bad_refresh_token",
            error_description: `The refresh token passed is incorrect or expired: ${presented}`,
          });
        }
        this.refreshTokens.delete(presented); // rotation: the old refresh token dies
        return json(res, 200, this.issueFor(row.user));
      }
      this.exchangeCalls++;
      const code = form.get("code") ?? "";
      const entry = this.codes.get(code);
      this.codes.delete(code);
      if (!entry) {
        return json(res, 200, { error: "bad_verification_code", error_description: `The code passed is incorrect or expired: ${code}` });
      }
      if (entry.redirectUri !== form.get("redirect_uri")) {
        return json(res, 200, { error: "redirect_uri_mismatch" });
      }
      if (entry.challenge) {
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
          return json(res, 200, { error: "bad_verification_code" });
        }
      }
      return json(res, 200, this.issueFor(entry.user));
    }
    if (req.method === "GET" && url.pathname === "/user") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const row = this.accessTokens.get(token);
      return row ? json(res, 200, { id: row.user.id, login: row.user.login }) : json(res, 401, { message: "Bad credentials" });
    }
    if (req.method === "DELETE" && url.pathname === `/applications/${CLIENT_ID}/token`) {
      const body = JSON.parse(await readBody(req)) as { access_token: string };
      this.revoked.push(body.access_token);
      this.accessTokens.delete(body.access_token);
      res.writeHead(204);
      res.end();
      return;
    }
    json(res, 404, { message: "Not Found" });
  }
}

export interface FakeEntraIdentity {
  tenantId: string;
  oid: string;
}

export class FakeEntra {
  url = "";
  readonly secrets = new Set<string>();
  /** Mutate the id_token claims before signing, to simulate a hostile or buggy IdP. */
  claimsHook?: (claims: Record<string, unknown>) => void;
  private server!: Server;
  private privateKey!: GeneratedKey;
  publicKey!: GeneratedKey;
  private readonly codes = new Map<
    string,
    { identity: FakeEntraIdentity; nonce: string; challenge: string; redirectUri: string; scope: string }
  >();

  async start(): Promise<void> {
    const pair = await generateKeyPair("ES256");
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => json(res, 500, { error: "server_error" }));
    });
    this.url = await listen(this.server);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get authorizeEndpoint(): string {
    return `${this.url}/common/oauth2/v2.0/authorize`;
  }

  get tokenEndpoint(): string {
    return `${this.url}/common/oauth2/v2.0/token`;
  }

  /** Simulates the user signing in at Entra as `identity`. Returns the redirect_uri callback URL. */
  signIn(authorizeUrl: string, identity: FakeEntraIdentity): string {
    const url = new URL(authorizeUrl);
    if (url.origin !== this.url || url.pathname !== "/common/oauth2/v2.0/authorize") {
      throw new Error(`not an Entra authorize URL: ${url.origin}${url.pathname}`);
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || url.searchParams.get("response_type") !== "code") {
      throw new Error("authorize URL is not code + PKCE S256");
    }
    const code = rand("entracode_");
    this.secrets.add(code);
    this.codes.set(code, {
      identity,
      nonce: url.searchParams.get("nonce") as string,
      challenge: url.searchParams.get("code_challenge") as string,
      redirectUri: url.searchParams.get("redirect_uri") as string,
      scope: url.searchParams.get("scope") ?? "",
    });
    const back = new URL(url.searchParams.get("redirect_uri") as string);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") as string);
    return back.toString();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    if (req.method !== "POST" || url.pathname !== "/common/oauth2/v2.0/token") {
      return json(res, 404, {});
    }
    const form = new URLSearchParams(await readBody(req));
    const authenticated =
      form.get("client_secret") === CLIENT_SECRET ||
      (form.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" &&
        form.get("client_assertion") === "federated-assertion");
    if (form.get("client_id") !== CLIENT_ID || !authenticated) {
      return json(res, 401, { error: "invalid_client" });
    }
    const code = form.get("code") ?? "";
    const entry = this.codes.get(code);
    this.codes.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    if (
      !entry ||
      entry.redirectUri !== form.get("redirect_uri") ||
      createHash("sha256").update(verifier).digest("base64url") !== entry.challenge
    ) {
      return json(res, 400, { error: "invalid_grant" });
    }
    const claims: Record<string, unknown> = {
      tid: entry.identity.tenantId,
      sub: `pairwise-${rand()}`,
      nonce: entry.nonce,
    };
    if (entry.scope.split(/\s+/).includes("profile")) claims.oid = entry.identity.oid;
    this.claimsHook?.(claims);
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setIssuer(`${this.url}/${entry.identity.tenantId}/v2.0`)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.privateKey);
    this.secrets.add(idToken);
    const accessToken = rand("entra_at_");
    this.secrets.add(accessToken);
    json(res, 200, { token_type: "Bearer", id_token: idToken, access_token: accessToken, expires_in: 3600 });
  }

  verifier(): JwtVerifier {
    const publicKey = this.publicKey;
    return {
      async verify(token: string): Promise<JwtClaims> {
        const { payload } = await jwtVerify(token, publicKey);
        return payload as JwtClaims;
      },
    };
  }
}

export class Clock {
  constructor(public t = Date.parse("2026-10-17T08:00:00.000Z")) {}
  now = (): number => this.t;
  advanceSeconds(seconds: number): void {
    this.t += seconds * 1000;
  }
}

export interface Harness {
  gh: FakeGitHub;
  entra: FakeEntra;
  clock: Clock;
  store: GitHubLinkStore;
  cipher: AesGcmFieldCipher;
  logs: string[];
  makeService(overrides?: Partial<GitHubLinkServiceOptions>): GitHubLinkService;
  stop(): Promise<void>;
}

export async function startHarness(options: { store?: GitHubLinkStore } = {}): Promise<Harness> {
  const gh = new FakeGitHub();
  const entra = new FakeEntra();
  await Promise.all([gh.start(), entra.start()]);
  const clock = new Clock();
  const store = options.store ?? new InMemoryGitHubLinkStore();
  const cipher = new AesGcmFieldCipher(randomBytes(32));
  const logs: string[] = [];
  const makeService = (overrides: Partial<GitHubLinkServiceOptions> = {}): GitHubLinkService =>
    new GitHubLinkService({
      store,
      cipher,
      oauth: new GitHubOAuthClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        webBaseUrl: gh.url,
        apiBaseUrl: gh.url,
      }),
      entra: new EntraBrowserSignIn({
        authorizeEndpoint: entra.authorizeEndpoint,
        tokenEndpoint: entra.tokenEndpoint,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        verifier: entra.verifier(),
        issuerForTenant: (tid) => `${entra.url}/${tid}/v2.0`,
      }),
      publicBaseUrl: PUBLIC_BASE,
      now: clock.now,
      leasePollMs: 10,
      ...overrides,
    });
  return {
    gh,
    entra,
    clock,
    store,
    cipher,
    logs,
    makeService,
    stop: async () => {
      await Promise.all([gh.stop(), entra.stop()]);
    },
  };
}

/** A minimal browser: cookie jar + in-process delivery of requests to the service under test. */
export class Browser {
  readonly jar = new Map<string, string>();
  readonly responses: HttpResponseLike[] = [];

  constructor(private readonly service: Pick<GitHubLinkService, "handleHttp">) {}

  async start(url: string): Promise<HttpResponseLike> {
    const landing = await this.get(url);
    return landing.status === 200 ? this.submit(landing) : landing;
  }

  async submit(page: HttpResponseLike): Promise<HttpResponseLike> {
    const html = String(page.body);
    const action = /<form method="post" action="([^"]+)">/.exec(html)?.[1];
    if (!action) throw new Error("Expected a human consent form");
    const fields = [...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)];
    const form = new URLSearchParams(fields.map(match => [match[1], match[2]]));
    const response = await this.service.handleHttp({ method: "POST", path: action, body: form.toString(),
      headers: { origin: PUBLIC_BASE, "content-type": "application/x-www-form-urlencoded",
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    if (!response) throw new Error("Consent route not handled");
    this.receive(response);
    return response;
  }

  async get(url: string): Promise<HttpResponseLike> {
    const parsed = new URL(url);
    if (parsed.origin !== PUBLIC_BASE) {
      throw new Error(`browser asked to visit a foreign origin: ${parsed.origin}`);
    }
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await this.service.handleHttp({
      method: "GET",
      path: parsed.pathname,
      query: parsed.search.replace(/^\?/, ""),
      headers: cookie ? { cookie } : {},
    });
    if (!response) throw new Error("service did not handle the request");
    this.receive(response);
    return response;
  }

  private receive(response: HttpResponseLike): void {
    const setCookie = response.headers["set-cookie"];
    if (setCookie) {
      const [pair] = setCookie.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/Max-Age=0/.test(setCookie) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
    this.responses.push(response);
  }
}

export interface FlowResult {
  start: HttpResponseLike;
  entraCallback?: HttpResponseLike;
  githubCallback?: HttpResponseLike;
  final: HttpResponseLike;
  browser: Browser;
  entraCallbackUrl?: string;
  githubCallbackUrl?: string;
}

/** Drive the three browser legs. `signInAs` is who types credentials at Entra in this browser. */
export async function runLinkFlow(
  h: Harness,
  service: GitHubLinkService,
  startUrl: string,
  signInAs: FakeEntraIdentity,
  githubUser: FakeGitHubUser,
  browser = new Browser(service),
): Promise<FlowResult> {
  const start = await browser.start(startUrl);
  if (start.status !== 302) return { start, final: start, browser };
  const entraCallbackUrl = h.entra.signIn(start.headers.location, signInAs);
  const entraCallback = await browser.get(entraCallbackUrl);
  if (entraCallback.status !== 302) return { start, entraCallback, final: entraCallback, browser, entraCallbackUrl };
  const githubCallbackUrl = h.gh.authorize(entraCallback.headers.location, githubUser);
  const githubCallback = await browser.get(githubCallbackUrl);
  return { start, entraCallback, githubCallback, final: githubCallback, browser, entraCallbackUrl, githubCallbackUrl };
}

export const TENANT = "11111111-1111-4111-8111-111111111111";
export const ALICE: UserPrincipal = { tenantId: TENANT, objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
export const BOB: UserPrincipal = { tenantId: TENANT, objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
export const asIdentity = (p: UserPrincipal): FakeEntraIdentity => ({ tenantId: p.tenantId, oid: p.objectId });
export const GH_ALICE: FakeGitHubUser = { id: 1001, login: "alice-gh" };
export const GH_BOB: FakeGitHubUser = { id: 2002, login: "bob-gh" };

/** Link `principal` through the full flow as themselves; returns the service used. */
export async function linkAs(
  h: Harness,
  service: GitHubLinkService,
  principal: UserPrincipal,
  githubUser: FakeGitHubUser,
  begin: { allowRebind?: boolean } = {},
): Promise<FlowResult> {
  const { startUrl } = await service.begin(principal, begin);
  const result = await runLinkFlow(h, service, startUrl, asIdentity(principal), githubUser);
  if (begin.allowRebind && String(result.final.body).includes("Confirm GitHub account switch")) {
    result.final = await result.browser.submit(result.final);
  }
  return result;
}
