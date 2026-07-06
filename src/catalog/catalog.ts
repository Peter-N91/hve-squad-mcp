/**
 * Tool catalog loader and types.
 *
 * `tools.catalog.yml` is the single source of truth for the public tool
 * surface. This module parses it into typed `CatalogTool` records and performs
 * lightweight structural validation (the deeper catalog<->cast drift check
 * lives in the generator, `generators/build-manifests.ts`).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { catalogPath } from "../paths.js";

/** A JSON Schema object describing a tool's input. Kept open per the spec. */
export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** One coarse intent tool, authored in `tools.catalog.yml`. */
export interface CatalogTool {
  /** Tool id advertised to MCP hosts, e.g. `squad_research`. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Tool description (seeds the MCP `description` field). */
  description: string;
  /** The squad-routing intent row this tool maps onto (`*` for the catch-all). */
  routingIntent: string;
  /** The squad role/agent the intent resolves to (validated against the roster). */
  role: string;
  /** Default autonomy tier: `auto`, `confirm`, or `escalate`. */
  tier: string;
  /** Whether the role may run concurrently with other independent roles. */
  parallelEligible: boolean;
  /** True for `squad_run`: the full classify-and-dispatch pipeline. */
  catchAll: boolean;
  /** True when the tool carries Implementation/Human gates (e.g. `squad_run`). */
  gates: boolean;
  /** Optional council member agents engaged for go/no-go reviews. */
  council: string[];
  /** Optional council routing intent (for `squad_review`). */
  councilIntent?: string;
  /** Optional tier applied when the council engages. */
  councilTier?: string;
  /** JSON Schema for the tool input (mirrors the `/squad` prompt args). */
  input: JsonSchema;
}

/** The parsed catalog. */
export interface ToolCatalog {
  schemaVersion: string;
  tools: CatalogTool[];
}

interface RawCatalog {
  schemaVersion?: unknown;
  tools?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected an array of strings.");
  }
  return value as string[];
}

function normalizeTool(raw: unknown, index: number): CatalogTool {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`tools[${index}] is not an object.`);
  }
  const t = raw as Record<string, unknown>;
  const id = t.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`tools[${index}].id is required and must be a non-empty string.`);
  }
  if (typeof t.routingIntent !== "string" || t.routingIntent.length === 0) {
    throw new Error(`tool "${id}": routingIntent is required.`);
  }
  if (typeof t.role !== "string" || t.role.length === 0) {
    throw new Error(`tool "${id}": role is required.`);
  }
  if (typeof t.input !== "object" || t.input === null) {
    throw new Error(`tool "${id}": input JSON Schema is required.`);
  }
  return {
    id,
    title: typeof t.title === "string" ? t.title : id,
    description: typeof t.description === "string" ? t.description : "",
    routingIntent: t.routingIntent,
    role: t.role,
    tier: typeof t.tier === "string" ? t.tier : "confirm",
    parallelEligible: t.parallelEligible === true,
    catchAll: t.catchAll === true,
    gates: t.gates === true,
    council: asStringArray(t.council),
    councilIntent: typeof t.councilIntent === "string" ? t.councilIntent : undefined,
    councilTier: typeof t.councilTier === "string" ? t.councilTier : undefined,
    input: t.input as JsonSchema,
  };
}

/** Parse a catalog from a YAML string. */
export function parseCatalog(yamlText: string): ToolCatalog {
  const raw = parseYaml(yamlText) as RawCatalog;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tools.catalog.yml did not parse to an object.");
  }
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw new Error("tools.catalog.yml must define a non-empty `tools` array.");
  }
  const tools = raw.tools.map((tool, index) => normalizeTool(tool, index));
  const ids = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) {
      throw new Error(`Duplicate tool id "${tool.id}" in catalog.`);
    }
    ids.add(tool.id);
  }
  return {
    schemaVersion: typeof raw.schemaVersion === "string" ? raw.schemaVersion : "0.0.0",
    tools,
  };
}

/** Load and parse the authored catalog from disk. */
export function loadCatalog(path: string = catalogPath()): ToolCatalog {
  return parseCatalog(readFileSync(path, "utf8"));
}
