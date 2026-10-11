import { createHash } from "node:crypto";
import type { SquadArtifact, SquadArtifactStore } from "../artifact-store.js";
import type { CompletionUsageRecord } from "../model-backend.js";
import { buildRunBillingLog, selectRunHistory, type RunBillingSnapshot } from "./run-billing-log.js";
import { UpstreamScriptBridge, type UpstreamScriptBridgeOptions } from "./upstream-script-bridge.js";
import type { UpstreamReviewVerification } from "./upstream-coordinator.js";

const ROOT = ".copilot-tracking/squad";
const HEADING = "## Run-scoped SDK billing & value";
export interface RunBillingValueReceipt extends Omit<RunBillingSnapshot, "eventsJsonl"> {
  historyEntryIds: string[];
  historySha256: Record<string, string>;
  deliverablesProduced: number;
  accepted: number;
  rejected: number;
  unreviewed: number;
  hostBilledCreditsPerAccepted: number | null;
  verifiedReview?: Pick<UpstreamReviewVerification, "verdict" | "reviewerStageId" | "ownerStageId" | "readHashes" | "reviewReceipt">;
}

/** Never divide a run's service charges by project-wide accepted deliverables. */
export async function publishRunBillingProjection(
  options: Omit<UpstreamScriptBridgeOptions, "billingRecords">,
  records: readonly CompletionUsageRecord[],
  entryIds: ReadonlySet<string>,
  verification?: UpstreamReviewVerification,
): Promise<RunBillingValueReceipt> {
  const snapshot = buildRunBillingLog(options.runId, records);
  const files = new Map<string, SquadArtifact>();
  const baselines = new Map<string, SquadArtifact>();
  const historySha256: Record<string, string> = {};
  const selectedIds = new Set<string>();
  let verifiedOwnerPath: string | undefined;
  if (verification) {
    if (!entryIds.has(verification.ownerStageId) || !entryIds.has(verification.reviewerStageId)) throw new Error("Verified review is outside the billing run.");
    // Input files are immutable stage-local request/context mounts, not persisted
    // project artifacts. Billing revalidates stored owner/reviewer evidence only.
    for (const proof of [verification.reviewReceipt, ...verification.readHashes.filter(proof =>
      !["input/request.md", "input/context.md", "input/research.md", "input/plan.md"].includes(proof.path))]) {
      const stored = await options.store.get(options.tenantId, options.project, proof.path);
      if (!stored || createHash("sha256").update(stored.content).digest("hex") !== proof.sha256) {
        throw new Error("Run billing review proof changed after trusted verification.");
      }
      baselines.set(stored.path, stored);
    }
  }
  for (const entry of await options.store.list(options.tenantId, options.project, ROOT + "/")) {
    if (![`${ROOT}/team.md`, `${ROOT}/consumption-rates.md`, `${ROOT}/state.json`].includes(entry.path) &&
        !entry.path.startsWith(`${ROOT}/history/`)) continue;
    const file = await options.store.get(options.tenantId, options.project, entry.path);
    if (!file || file.updatedAt !== entry.updatedAt) throw new Error("Run billing history snapshot changed.");
    baselines.set(file.path, file);
    // One logical server run spans several script handoffs; Squad joins reviews by Turn.
    const content = entry.path.startsWith(`${ROOT}/history/`)
      ? selectRunHistory(file.content, entryIds).replace(/^([*-][ \t]+Turn:[ \t]*)\d+[ \t]*$/gm, (_line, prefix: string) => prefix + "1")
      : file.content;
    if (!content) continue;
    files.set(file.path, { ...file, content });
    if (entry.path.startsWith(`${ROOT}/history/`)) {
      for (const heading of content.matchAll(/^###[ \t]+\S+[ \t]+([^\r\n]+)\r?$/gm)) {
        const id = heading[1].trim();
        if (selectedIds.has(id)) throw new Error("Run history ID appears in multiple agent histories.");
        selectedIds.add(id);
      }
      historySha256[file.path] = createHash("sha256").update(content).digest("hex");
      if (verification) {
        const owner = selectRunHistory(content, new Set([verification.ownerStageId]));
        if (owner) {
          const match = /^[*-][ \t]+Deliverable:[ \t]*`?([^`\r\n]+)`?[ \t]*$/m.exec(owner);
          verifiedOwnerPath = match?.[1].trim();
        }
      }
    }
  }
  if ([...entryIds].some(id => !selectedIds.has(id))) throw new Error("Run billing scope contains an unpersisted history ID.");
  if (verification) {
    if (!verifiedOwnerPath || !verification.readHashes.some(proof => proof.path === verifiedOwnerPath)) throw new Error("Verified review did not read the billing owner's deliverable.");
    for (const [path, file] of files) {
      if (!path.startsWith(`${ROOT}/history/`)) continue;
      const headings = [...file.content.matchAll(/^###[ \t]+\S+[ \t]+([^\r\n]+)\r?$/gm)];
      const index = headings.findIndex(heading => heading[1].trim() === verification.reviewerStageId);
      if (index < 0) continue;
      const start = headings[index].index, end = headings[index + 1]?.index ?? file.content.length;
      const reviewed = file.content.slice(start, end).replace(/^([*-][ \t]+Outcome:[ \t]*)[^\r\n]*$/m,
        (_line: string, prefix: string) => `${prefix}${verification.verdict}: ${verifiedOwnerPath}.`);
      const content = file.content.slice(0, start) + reviewed + file.content.slice(end);
      files.set(path, { ...file, content });
      historySha256[path] = createHash("sha256").update(content).digest("hex");
    }
  }
  const scopedStore: SquadArtifactStore = {
    get: async (tenant, project, path) => {
      if (tenant !== options.tenantId || project !== options.project) throw new Error("Run billing scope mismatch.");
      return files.get(path);
    },
    list: async (tenant, project) => {
      if (tenant !== options.tenantId || project !== options.project) throw new Error("Run billing scope mismatch.");
      return [...files.values()].map(file => ({ path: file.path, size: Buffer.byteLength(file.content), updatedAt: file.updatedAt }));
    },
    put: async () => { throw new Error("Run billing measurement is read-only."); },
    append: async () => { throw new Error("Run billing measurement is read-only."); },
  };
  const bridge = new UpstreamScriptBridge({ ...options, store: scopedStore, billingRecords: records });
  await bridge.initializeMirror();
  const result = await bridge.runScript({ script: "Measure-SquadLedger", args: { check: false } });
  const output: unknown = JSON.parse(result.output);
  if (!output || typeof output !== "object" || !("unitEconomics" in output) ||
      !output.unitEconomics || typeof output.unitEconomics !== "object") throw new Error("Run billing measurement omitted value.");
  const unit = output.unitEconomics as Record<string, unknown>;
  const observed = "observed" in output ? output.observed : undefined;
  const observedCredits = observed && typeof observed === "object" && "sessionAiu" in observed ? observed.sessionAiu : null;
  if (snapshot.hostBilledCredits === null ? observedCredits !== null :
      typeof observedCredits !== "number" || Math.abs(observedCredits - snapshot.hostBilledCredits) > 1e-9) {
    throw new Error("Squad omitted or altered the compatible host billing log.");
  }
  const count = (key: string): number => {
    const value = unit[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid run value count.");
    return value;
  };
  const accepted = count("accepted");
  const ratio = snapshot.hostBilledCredits !== null && accepted > 0 ? snapshot.hostBilledCredits / accepted : null;
  const reported = unit.hostBilledCreditsPerAccepted;
  if (ratio === null ? reported !== null : typeof reported !== "number" || Math.abs(reported - ratio) > 1e-9) {
    throw new Error("Squad host-log projection disagrees with trusted SDK billing completeness.");
  }
  const { eventsJsonl: _privateLog, ...billing } = snapshot;
  for (const [path, baseline] of baselines) {
    const current = await options.store.get(options.tenantId, options.project, path);
    if (!current || current.etag !== baseline.etag || current.content !== baseline.content) {
      throw new Error("Run billing source changed during measurement; publication refused.");
    }
  }
  const receipt: RunBillingValueReceipt = { ...billing, historyEntryIds: [...entryIds].sort(), historySha256,
    deliverablesProduced: count("deliverablesProduced"), accepted, rejected: count("rejected"), unreviewed: count("unreviewed"),
    hostBilledCreditsPerAccepted: ratio,
    ...(verification ? { verifiedReview: { verdict: verification.verdict, reviewerStageId: verification.reviewerStageId,
      ownerStageId: verification.ownerStageId, readHashes: verification.readHashes, reviewReceipt: verification.reviewReceipt } } : {}),
  };
  const amount = (value: number | null) => value === null ? "unavailable" : String(value);
  const receiptPath = `${ROOT}/runtime-billing/${options.runId}.json`;
  const section = [
    HEADING, "", `Run: \`${options.runId}\`. Source: [trusted run billing receipt](runtime-billing/${options.runId}.json).`,
    "SDK service-reported charges, not an invoice. Value is derived by the pinned Squad script from this run's exact stage/helper history IDs, grouped as one logical run in the private measurement view.",
    "", "| Metric | Value |", "| --- | --- |",
    `| Billing completeness | ${receipt.billingStatus} |`,
    `| Reported / missing billing completions | ${receipt.billedCompletionCount} / ${receipt.unreportedBillingCompletions} |`,
    `| Known billed credits subtotal (not a complete total) | ${amount(receipt.knownCreditsSubtotal)} |`,
    `| Complete host-billed credits | ${amount(receipt.hostBilledCredits)} |`,
    `| Accepted / rejected / unreviewed deliverables | ${receipt.accepted} / ${receipt.rejected} / ${receipt.unreviewed} |`,
    `| Host-billed credits per accepted deliverable | ${amount(receipt.hostBilledCreditsPerAccepted)} |`, "",
  ].join("\n");
  const writeVerified = async (path: string, content: string, prior: SquadArtifact | undefined) => {
    const written = await options.store.put(options.tenantId, options.project, path, content, prior?.etag ?? "");
    if (!written.ok) throw new Error("Run billing projection CAS conflicted.");
    const saved = await options.store.get(options.tenantId, options.project, path);
    if (!saved || saved.etag !== written.artifact.etag || saved.content !== content) throw new Error("Run billing projection read-back failed.");
  };
  const previousReceipt = await options.store.get(options.tenantId, options.project, receiptPath);
  await writeVerified(receiptPath, JSON.stringify(receipt, null, 2) + "\n", previousReceipt);
  const ledgerPath = `${ROOT}/consumption.md`;
  const ledger = await options.store.get(options.tenantId, options.project, ledgerPath);
  if (!ledger) throw new Error("Run billing projection has no project consumption ledger.");
  const heading = /^## Run-scoped SDK billing & value\r?$/m.exec(ledger.content);
  const start = heading?.index ?? -1;
  const next = start >= 0 ? ledger.content.indexOf("\n## ", start + HEADING.length) : -1;
  const content = start < 0 ? ledger.content.trimEnd() + "\n\n" + section :
    ledger.content.slice(0, start) + section + (next < 0 ? "" : ledger.content.slice(next + 1));
  await writeVerified(ledgerPath, content, ledger);
  return receipt;
}
