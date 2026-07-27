/**
 * Named-target routing over the {@link SquadMemoryStore} seam.
 *
 * A single deployment may need more than one memory destination: a team keeps its
 * working state in Azure Table for speed, but wants decisions and business plans
 * to land in a SharePoint library their stakeholders already read. This decorator
 * lets a deployment offer SEVERAL destinations and lets the caller pick one BY
 * NAME per call.
 *
 * Trust model — this is the one place a caller influences storage, so the rule is
 * explicit and mirrors the {@link import("../config/operator-config.js").OperatorConfig.allowedModelEndpoints}
 * precedent (SEC-3): the OPERATOR declares the destinations (drive ids, accounts,
 * directories, credentials) and the caller may only select **among** them by an
 * opaque name. A caller can never supply a raw destination, a URL, a drive id, or
 * a path root. An unknown name is rejected BEFORE any I/O with a message that
 * names no destination.
 *
 * Tenant isolation is unchanged and independent of the target: every underlying
 * store still receives `tenantId` (from the validated token) as its first
 * argument, so selecting a different target changes WHERE memory is written, never
 * WHOSE memory is reachable.
 */
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
  SquadMemoryWriteResult,
} from "./squad-memory-state.js";

/** Thrown when a caller names a target the operator did not declare. */
export class UnknownMemoryTargetError extends Error {
  constructor(readonly requested: string) {
    // Deliberately lists the ALLOWED names only — never the requested value
    // (which is caller text) and never any destination detail.
    super("Unknown memory target.");
    this.name = "UnknownMemoryTargetError";
  }
}

/** Target-name shape: a short, opaque, lower-kebab-case label. */
const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface TargetedSquadMemoryStoreOptions {
  /** Operator-declared destinations, keyed by the name a caller may select. */
  targets: ReadonlyMap<string, SquadMemoryStore>;
  /** The target used when a call names none. Must be a key of `targets`. */
  defaultTarget: string;
}

/**
 * A {@link SquadMemoryStore} that dispatches to one of several operator-declared
 * stores. It implements the plain seam (so every existing caller keeps working,
 * routed to the default target) and adds `*On(target, …)` variants for the call
 * sites that accept a caller-selected target.
 */
export class TargetedSquadMemoryStore implements SquadMemoryStore {
  private readonly targets: ReadonlyMap<string, SquadMemoryStore>;
  private readonly defaultTarget: string;

  constructor(options: TargetedSquadMemoryStoreOptions) {
    if (options.targets.size === 0) {
      throw new Error("TargetedSquadMemoryStore requires at least one target.");
    }
    for (const name of options.targets.keys()) {
      if (!TARGET_NAME.test(name)) {
        throw new Error(`Memory target name "${name}" must be lower-kebab-case.`);
      }
    }
    if (!options.targets.has(options.defaultTarget)) {
      throw new Error(`Default memory target "${options.defaultTarget}" is not a declared target.`);
    }
    this.targets = options.targets;
    this.defaultTarget = options.defaultTarget;
  }

  /** The declared target names, for connector/tool-schema projection and docs. */
  targetNames(): string[] {
    return [...this.targets.keys()].sort();
  }

  /** The name used when a call selects none. */
  get defaultTargetName(): string {
    return this.defaultTarget;
  }

  /**
   * Resolve a caller-supplied target name. `undefined` / empty selects the default.
   * Any other unmatched value throws {@link UnknownMemoryTargetError} — fail-closed,
   * never a silent fallback to the default, which would write a caller's memory
   * somewhere it did not ask for.
   */
  resolve(target?: string): SquadMemoryStore {
    const name = (target ?? "").trim();
    if (name.length === 0) {
      return this.targets.get(this.defaultTarget) as SquadMemoryStore;
    }
    const store = this.targets.get(name);
    if (!store) {
      throw new UnknownMemoryTargetError(name);
    }
    return store;
  }

  // --- plain seam (default target) -----------------------------------------

  list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    return this.resolve().list(tenantId, project);
  }

  read(tenantId: string, project: string, path: string): Promise<SquadMemoryEntry | undefined> {
    return this.resolve().read(tenantId, project, path);
  }

  write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    return this.resolve().write(tenantId, project, path, content, expectedEtag);
  }

  listProjects(tenantId: string): Promise<string[]> {
    return this.resolve().listProjects(tenantId);
  }

  // --- target-selecting variants -------------------------------------------

  listOn(target: string | undefined, tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    return this.resolve(target).list(tenantId, project);
  }

  readOn(
    target: string | undefined,
    tenantId: string,
    project: string,
    path: string,
  ): Promise<SquadMemoryEntry | undefined> {
    return this.resolve(target).read(tenantId, project, path);
  }

  writeOn(
    target: string | undefined,
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    return this.resolve(target).write(tenantId, project, path, content, expectedEtag);
  }
}

/**
 * Narrow a store to the targeted decorator, for call sites that support a
 * caller-selected target. Returns `undefined` for a plain single-destination
 * store, so those deployments simply ignore the `target` input.
 */
export function asTargetedStore(
  store: SquadMemoryStore | undefined,
): TargetedSquadMemoryStore | undefined {
  return store instanceof TargetedSquadMemoryStore ? store : undefined;
}
