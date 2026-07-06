/**
 * From-disk persona loader (single-source invariant).
 *
 * The embedded thin slice shipped PARAPHRASED role charters so the engine was
 * deterministic without a deployed cast on disk. This loader is the follow-up
 * named in `embedded-roles.ts`: it reads the REAL `*.agent.md` bytes (frontmatter
 * plus body) so the embedded path and the delegated path can share the exact same
 * persona source of truth in a deployed consumer.
 *
 * It is a pure read — no model, no network. It returns a {@link PersonaRecord}
 * (charter body + parsed `applyTo`/`tools` frontmatter) or `undefined` when the
 * cast is not present on disk (CI / minimal image), which callers treat as
 * "fall back to the paraphrased constant".
 *
 * `applyTo` is parsed for completeness and future multi-instruction resolution,
 * but agent personas normally carry no `applyTo` (that is an instructions-file
 * concept); SEC-5 / untrusted-content-boundary is enforced unconditionally by
 * `embedded-prompt.ts`, not by a per-role preamble.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { resolveSquadAgentsRoots } from "../paths.js";

/** A role persona resolved from a deployed `*.agent.md` file. */
export interface PersonaRecord {
  /** The squad role label, e.g. "Task Researcher" (matches the agent `name:`). */
  role: string;
  /** The persona body (everything after the frontmatter) — the AUTHORITY charter. */
  charter: string;
  /** Parsed `applyTo` frontmatter (normally empty for agent personas). */
  applyTo: string[];
  /** Parsed `tools` frontmatter when present. */
  tools?: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

interface ParsedPersona {
  name?: string;
  applyTo: string[];
  tools?: string[];
  body: string;
}

function parseAgentPersona(text: string): ParsedPersona | undefined {
  const match = text.match(FRONTMATTER);
  if (!match) {
    return undefined;
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
  const tools = normalizeList(frontmatter.tools);
  return {
    name,
    applyTo: normalizeList(frontmatter.applyTo),
    tools: tools.length > 0 ? tools : undefined,
    body: match[2].trim(),
  };
}

function collectAgentFiles(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      collectAgentFiles(full, acc);
    } else if (entry.endsWith(".agent.md")) {
      acc.push(full);
    }
  }
}

/**
 * Load the {@link PersonaRecord} for a squad role by matching the agent `name:`
 * frontmatter across the candidate agents roots. Returns `undefined` when no
 * matching persona is found on disk.
 */
export function loadPersonaForRole(
  role: string,
  roots: string[] = resolveSquadAgentsRoots(),
): PersonaRecord | undefined {
  for (const root of roots) {
    const files: string[] = [];
    collectAgentFiles(root, files);
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseAgentPersona(text);
      if (parsed && parsed.name === role && parsed.body.length > 0) {
        return {
          role,
          charter: parsed.body,
          applyTo: parsed.applyTo,
          tools: parsed.tools,
        };
      }
    }
  }
  return undefined;
}

/**
 * Resolve the on-disk {@link PersonaRecord} for a squad ROLE KEY (e.g.
 * `"architect"`) by first mapping the role key to the deployed agent `name:`
 * via the injected `rosterMap`, then loading the real persona bytes for that
 * agent name.
 *
 * Roster PARSING is intentionally NOT done here — this helper only consumes an
 * already-parsed role -> agent-name map so the loader stays roster-map-injectable
 * and free of instruction-file parsing (the routing engine owns roster parsing).
 * This is a pure disk read with no paraphrase fallback; callers that want the
 * hero paraphrase fallback use `resolvePersonaForRosterRole` in
 * `embedded-roles.ts`.
 *
 * Returns `undefined` when the role key is absent from the map or the mapped
 * agent persona is not present on disk (never a silent wrong persona).
 */
export function loadPersonaForRosterRole(
  roleKey: string,
  rosterMap: ReadonlyMap<string, string>,
  roots: string[] = resolveSquadAgentsRoots(),
): PersonaRecord | undefined {
  const agentName = rosterMap.get(roleKey);
  if (!agentName) {
    return undefined;
  }
  return loadPersonaForRole(agentName, roots);
}
