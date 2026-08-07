/**
 * Ledger recording around an embedded dispatch.
 *
 * `AutoMemory` already brackets every run with a read-before and a write-after,
 * and this is the artifact-shaped twin of that: the same two moments, writing the
 * squad ledger and the role deliverables instead of a rolling digest.
 *
 * Failure posture is deliberately identical to auto-memory's. The ledger is an
 * ENHANCEMENT, never a dependency — a storage outage degrades a run to "no
 * durable record" rather than failing an advisory dispatch that otherwise
 * succeeded. Every store call is wrapped; nothing here can throw into the
 * coordinator.
 */
import type { SquadArtifactStore } from "./artifact-store.js";
import { parseBacklog } from "./backlog-contract.js";
import type { CoordinatorRequest } from "./coordinator-engine.js";
import {
  defaultProfileTables,
  deliverableRootFor,
  resolveProfile,
  type ProfileTables,
  type ResolvedProfile,
} from "./profiles.js";
import { SquadHistory } from "./squad-history.js";
import { SquadLedger, type SeedSquadOptions } from "./squad-ledger.js";
import type { RedactingLogger } from "../observability/logger.js";

export interface SquadRunRecorderDeps {
  store: SquadArtifactStore;
  /** Roster tables; defaults to the deployed cast. */
  tables?: ProfileTables;
  /**
   * Optional deck renderer. When wired, a `presenter` stage that emits the pptx
   * skill's content YAML is turned into a real `.pptx` with a download link
   * instead of leaving markdown that describes a deck nobody can open.
   */
  renderer?: DeckRenderer;
  logger?: RedactingLogger;
  /** Injectable clock for deterministic tests. */
  today?: () => string;
}

/** The slice of the render service the recorder needs (kept narrow for tests). */
export interface DeckRenderer {
  render(
    request: { contentYaml: string; styleYaml: string },
    ctx: { tenantId: string },
  ): Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
}

/**
 * Pull the pptx skill's content YAML out of a presenter completion.
 *
 * Requires a fenced block carrying a top-level `slides:` key rather than
 * accepting any YAML, because the presenter also emits YAML-ish fragments in
 * prose and rendering the wrong one produces a confidently wrong deck.
 */
export function extractDeckYaml(text: string): string | undefined {
  const fences = text.matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/g);
  for (const fence of fences) {
    const body = fence[1];
    if (/^slides\s*:/m.test(body)) {
      return body.trim();
    }
  }
  return undefined;
}

/** What a completed stage contributes to the ledger. */
export interface RecordedStage {
  /** The roster role KEY, when the stage owns one. */
  roleKey?: string;
  /** The dispatched agent's display name. */
  agentName: string;
  /** The stage's finished text. */
  artifact: string;
}

export class SquadRunRecorder {
  private readonly ledger: SquadLedger;
  private readonly history: SquadHistory;
  private readonly store: SquadArtifactStore;
  private readonly tables: ProfileTables;
  private readonly renderer: DeckRenderer | undefined;
  private readonly logger: RedactingLogger | undefined;
  private readonly today: () => string;

  constructor(deps: SquadRunRecorderDeps) {
    this.ledger = new SquadLedger(deps.store);
    this.history = new SquadHistory(deps.store);
    this.store = deps.store;
    this.tables = deps.tables ?? defaultProfileTables();
    this.renderer = deps.renderer;
    this.logger = deps.logger;
    this.today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  /**
   * Seed the squad if this is the project's first run, and return the history
   * index block to merge into the request `context` as DATA.
   *
   * The seeded profile is returned rather than the requested one: an existing
   * `team.md` wins, so a later caller passing a different `profile` never
   * silently re-casts a squad the project is already running under.
   */
  async open(
    tenantId: string,
    project: string,
    request: CoordinatorRequest,
  ): Promise<{ profile: ResolvedProfile; historyBlock?: string }> {
    const requested = resolveProfile(request.profile, this.tables);
    const opts = this.optionsFor(request);
    try {
      const seeded = await this.ledger.seed(tenantId, project, requested, this.tables, opts);
      const effective =
        seeded.profile === requested.name ? requested : resolveProfile(seeded.profile, this.tables);
      const historyBlock = await this.history.contextBlock(tenantId, project);
      return { profile: effective, historyBlock };
    } catch (error) {
      this.warn("squad ledger open failed; the run continues without a durable record", error);
      return { profile: requested };
    }
  }

  /** Persist a completed stage: its deliverable and its agent history entry. */
  async recordStage(
    tenantId: string,
    project: string,
    request: CoordinatorRequest,
    runId: string,
    stage: RecordedStage,
  ): Promise<void> {
    const opts = this.optionsFor(request);
    // A single-stage hero dispatch knows only the agent name, so recover the role
    // from the roster — the Deliverable Root is looked up by role, not by agent.
    const roleKey = stage.roleKey ?? this.roleKeyForAgent(stage.agentName);
    try {
      let deliverablePath: string | undefined;
      if (roleKey) {
        deliverablePath = await this.ledger.writeDeliverable(
          tenantId,
          project,
          roleKey,
          `${this.today()}-${runId}`,
          stage.artifact,
          this.tables,
          opts,
        );
      }
      await this.ledger.appendAgentHistory(
        tenantId,
        project,
        stage.agentName,
        [
          `### ${this.today()} — run ${runId}`,
          "",
          `* Role: ${roleKey ?? "(unmapped)"}`,
          `* Deliverable: ${deliverablePath ?? "(returned findings to the coordinator)"}`,
        ].join("\n"),
      );
      await this.ledger.appendRunHistory(
        tenantId,
        project,
        runId,
        `* ${stage.agentName} — ${deliverablePath ?? "findings only"}`,
      );
      await this.finishDeliverable(tenantId, project, roleKey, runId, stage, opts);
    } catch (error) {
      this.warn("squad ledger stage record failed", error);
    }
  }

  /**
   * Turn a specialist's prose into the artifact the role actually owes.
   *
   * `presenter` owes a deck, not a description of one; `product-owner` owes work
   * items a connector can create, not a bulleted list a human must retype. Both
   * degrade to "the markdown is still there" rather than failing the run, because
   * a model that did not follow the output contract is a quality problem, not an
   * outage.
   */
  private async finishDeliverable(
    tenantId: string,
    project: string,
    roleKey: string | undefined,
    runId: string,
    stage: RecordedStage,
    opts: SeedSquadOptions,
  ): Promise<void> {
    if (roleKey === "presenter" && this.renderer) {
      const contentYaml = extractDeckYaml(stage.artifact);
      if (!contentYaml) {
        return;
      }
      const rendered = await this.renderer.render(
        { contentYaml, styleYaml: "" },
        { tenantId },
      );
      const note = rendered.content.map((part) => part.text ?? "").join("\n");
      const root = deliverableRootFor("presenter", this.tables, {
        squad: opts.squad,
        date: opts.date,
      });
      if (!root) {
        return;
      }
      // The .pptx itself lives in the render container behind a short-lived SAS;
      // the tracking tree carries the pointer and the source YAML so the deck is
      // reproducible after the link expires.
      await this.store.put(tenantId, project, `${root}/deck-${runId}.yaml`, contentYaml);
      await this.store.put(
        tenantId,
        project,
        `${root}/deck-${runId}.md`,
        rendered.isError ? `# Deck render failed\n\n${note}` : `# Deck\n\n${note}`,
      );
      return;
    }

    if (roleKey === "product-owner") {
      const backlog = parseBacklog(stage.artifact);
      if (backlog.workItems.length === 0) {
        return;
      }
      const root = deliverableRootFor("product-owner", this.tables, {
        squad: opts.squad,
        date: opts.date,
      });
      if (!root) {
        return;
      }
      // The flat `workItems[]` is what a Copilot Studio agent loops one item per
      // call into the native ADO or Jira connector; this server writes nothing
      // to either (ADR-0001).
      await this.store.put(
        tenantId,
        project,
        `${root}/backlog-${runId}.json`,
        `${JSON.stringify(backlog, null, 2)}\n`,
      );
    }
  }

  /** Reverse the Cast Catalog: an agent's `name:` back to the role it fills. */
  private roleKeyForAgent(agentName: string): string | undefined {
    const wanted = agentName.trim().toLowerCase();
    for (const [role, row] of this.tables.cast) {
      if (row.primary.trim().toLowerCase() === wanted) {
        return role;
      }
    }
    return undefined;
  }

  /** Append a verdict block (council or intake) to the decision log. */
  async recordDecision(tenantId: string, project: string, block: string): Promise<void> {
    try {
      await this.ledger.appendDecision(tenantId, project, block);
    } catch (error) {
      this.warn("squad ledger decision record failed", error);
    }
  }

  /** Advance the turn counter and record the run that produced it. */
  async closeRun(
    tenantId: string,
    project: string,
    runId: string,
    activeRoles: string[],
  ): Promise<void> {
    try {
      const state = await this.ledger.readState(tenantId, project);
      await this.ledger.updateState(tenantId, project, {
        turn: (state?.turn ?? 0) + 1,
        activeRoles,
        currentRun: { id: runId } as never,
        updated: this.today(),
      });
    } catch (error) {
      this.warn("squad ledger state update failed", error);
    }
  }

  private optionsFor(request: CoordinatorRequest): SeedSquadOptions {
    return {
      mode: request.mode,
      tier: request.tier,
      squad: request.squad,
      date: this.today(),
    };
  }

  /**
   * Bind this recorder to one run, producing the sink the advisory pipeline
   * writes each finished stage through.
   *
   * The pipeline knows the stage; the recorder knows the tenant, the project and
   * the run. Binding them here keeps the pipeline free of storage types, exactly
   * as its existing persistence seam does.
   */
  sinkFor(
    tenantId: string,
    project: string,
    request: CoordinatorRequest,
    runId: string,
  ): {
    recordStage(stage: RecordedStage): Promise<void>;
    recordDecision(block: string): Promise<void>;
  } {
    return {
      recordStage: (stage) => this.recordStage(tenantId, project, request, runId, stage),
      recordDecision: (block) => this.recordDecision(tenantId, project, block),
    };
  }

  private warn(message: string, error: unknown): void {
    this.logger?.warn(message, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
