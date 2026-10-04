/**
 * Live smoke test for the Copilot stage executor.
 *
 * Runs one real HVE persona stage against a running sandbox (host/sandbox)
 * through the actual SDK adapter, with the project and the runtime's session
 * state held server-side. Reusing SMOKE_OUTPUT_DIR / SMOKE_SESSION_DIR across
 * runs exercises persistence across fresh sandboxes; reusing SMOKE_RUN_ID and
 * SMOKE_PERSONA after a failed attempt exercises resume. Tokens are read from
 * the environment and never printed.
 *
 *   COPILOT_CONNECTION_TOKEN=...  required, as passed to the sandbox
 *   COPILOT_SANDBOX_URL=...       default 127.0.0.1:4321
 *   SMOKE_GITHUB_TOKEN=...        per-session GitHub identity (static)
 *   SMOKE_TOKEN_COMMAND=...       e.g. "gh auth token"; verified, then supplied
 *                                 through gitHubTokenProvider (production path)
 *   SMOKE_PERSONA=...             pinned persona name, default "Squad Researcher"
 *   SMOKE_ROLE_KEY=...            optional roster role key
 *   SMOKE_RUN_ID=...              default smoke-<timestamp>
 *   SMOKE_MODEL=...               optional model id
 *   SMOKE_DEADLINE_MS=...         default 900000
 *   SMOKE_OUTPUT_DIR=...          project store directory
 *   SMOKE_SESSION_DIR=...         session-state directory (default <output>/sessions)
 *   SMOKE_QUESTION=...            optional request text
 *   SMOKE_TRACE=1                 print session event types
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { CommandCredentialSource, CopilotCredentials } from "../src/engine/copilot/copilot-credentials.js";
import { lazyCopilotSdkClient } from "../src/engine/copilot/copilot-sdk-client.js";
import { CopilotStageExecutor } from "../src/engine/copilot/copilot-stage-executor.js";
import { FileCopilotSessionStateStore } from "../src/engine/copilot/session-state-store.js";
import { loadPersonaForRole } from "../src/engine/persona-loader.js";
import { resolveSquadAgentsRoots } from "../src/paths.js";

const TENANT = "smoke-tenant";
const PROJECT = "copilot-smoke";

async function main(): Promise<void> {
  const connectionToken = process.env.COPILOT_CONNECTION_TOKEN ?? "";
  if (connectionToken.length < 32) throw new Error("COPILOT_CONNECTION_TOKEN (>= 32 characters) is required.");
  const personaName = process.env.SMOKE_PERSONA ?? "Squad Researcher";
  const persona = loadPersonaForRole(personaName, resolveSquadAgentsRoots());
  if (!persona) throw new Error(`The pinned persona ${JSON.stringify(personaName)} was not found under host/cast.`);

  const client = lazyCopilotSdkClient({ cliUrl: process.env.COPILOT_SANDBOX_URL ?? "127.0.0.1:4321", connectionToken });
  const outputDir = process.env.SMOKE_OUTPUT_DIR ?? await mkdtemp(join(tmpdir(), "copilot-smoke-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: outputDir }));
  const sessionState = new FileCopilotSessionStateStore(process.env.SMOKE_SESSION_DIR ?? join(outputDir, "sessions"));
  const runId = process.env.SMOKE_RUN_ID ?? `smoke-${Date.now()}`;
  const started = Date.now();
  try {
    // Production identity path: the server reads, verifies, and supplies the token per session.
    const tokenCommand = process.env.SMOKE_TOKEN_COMMAND?.trim();
    const credentials = tokenCommand
      ? new CopilotCredentials({ source: new CommandCredentialSource(tokenCommand.split(/\s+/)), verifier: client.entitlementVerifier() })
      : undefined;
    if (credentials) {
      const identity = await credentials.verify();
      console.log(`identity: ready=${identity.ready} models=${identity.models ?? "?"} premiumRemaining=${identity.premiumRemainingPercent ?? "?"}% (${identity.reason})`);
      if (!identity.ready) throw new Error("The Copilot identity could not be verified.");
    }
    const executor = new CopilotStageExecutor({
      client,
      workspace: { id: runId, tenantId: TENANT, root: outputDir, resolve: (path) => join(outputDir, path), dispose: async () => undefined },
      store,
      sessionState,
      project: PROJECT,
      runId,
      model: process.env.SMOKE_MODEL || undefined,
      gitHubToken: process.env.SMOKE_GITHUB_TOKEN || undefined,
      gitHubTokenProvider: credentials?.tokenProvider,
      identityStatus: credentials ? () => credentials.status() : undefined,
      deadlineMs: Number(process.env.SMOKE_DEADLINE_MS ?? 15 * 60_000),
      onCompletion: (record) => console.log(`model call: ${record.model ?? "?"} in=${record.usage?.inputTokens ?? "?"} out=${record.usage?.outputTokens ?? "?"}`),
      onSessionEvent: (event) => {
        if (process.env.SMOKE_TRACE) console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${event.type}${event.toolName ? ` ${event.toolName}` : ""}`);
      },
    });
    const result = await executor.execute(persona, {
      toolId: "squad_research",
      request: process.env.SMOKE_QUESTION ??
        "Research how the Model Context Protocol's Streamable HTTP transport manages sessions and cite the official specification.",
    }, undefined, process.env.SMOKE_ROLE_KEY || undefined);
    const entries = await store.list(TENANT, PROJECT);
    const sourcesEntry = entries.filter((entry) => entry.path.endsWith(".sources.json")).find((entry) => entry.path.includes(runId));
    const sources = sourcesEntry ? JSON.parse((await store.get(TENANT, PROJECT, sourcesEntry.path))?.content ?? "{}") : {};
    console.log(`\nstage completed in ${Math.round((Date.now() - started) / 1000)}s via ${result.backendId} (model ${result.model ?? "?"}) session=${sources.sessionId} resumed=${sources.resumed}`);
    console.log(`usage: in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"} calls=${result.usage?.completionCount ?? "?"}`);
    console.log(`project now holds: ${entries.map((entry) => entry.path).join(", ")}`);
    console.log(`project writes this stage: ${(sources.projectWrites ?? []).map((entry: { path: string; origin: string }) => `${entry.path} [${entry.origin}]`).join(", ")}`);
    console.log(`not collected from sandbox: ${(sources.notCollectedFromSandbox ?? []).join(" | ") || "(none)"}`);
    console.log(`evidence: ${(sources.evidence ?? []).map((entry: { id: string; provenance: string; source: string }) => `${entry.id} ${entry.provenance} ${entry.source}`).join(" | ")}`);
    console.log(`cited: ${(sources.cited ?? []).join(", ")}; refused: ${(sources.refusedRequests ?? []).length}`);
    console.log(`sub-agents: ${(sources.delegations ?? []).map((lane: { agent: string; status: string; startedAt: string; finishedAt?: string; reason?: string }) =>
      `${lane.agent} ${lane.status} ${lane.startedAt.slice(11, 19)}-${lane.finishedAt?.slice(11, 19) ?? "?"}${lane.reason ? ` (${lane.reason})` : ""}`).join(" | ") || "(none)"}`);
    console.log(`evidence by sub-agent: ${(sources.evidence ?? []).filter((entry: { agent?: string }) => entry.agent).length} of ${(sources.evidence ?? []).length}`);
    console.log(`\n----- result -----\n${result.text.slice(0, 3000)}`);
  } catch (error) {
    console.error(`copilot stage smoke failed after ${Math.round((Date.now() - started) / 1000)}s: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    process.exitCode = 1;
  } finally {
    await client.stop().catch(() => undefined);
  }
}

await main();
