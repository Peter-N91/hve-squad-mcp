import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTables } from "../markdown-table.js";

const ECONOMY_ROLES = new Set(["developer", "technical-writer", "presenter", "prompt-engineer", "data-scientist"]);
const clean = (value: string) => value.replace(/`/g, "").trim();

export class EconomyFloorExhaustedError extends Error {}

export interface EconomyPick {
  model: string;
  rankedModel: string;
  role: string;
  floor: string;
  rationale: string;
}

/** Intersect pinned upstream fit/cost routing with verified account availability. */
export function selectEconomyModel(root: string, role: string, floor: string, available: readonly string[]): EconomyPick {
  const catalog = parseTables(readFileSync(join(root, "references", "squad", "model-catalog.md"), "utf8"));
  const routing = parseTables(readFileSync(join(root, "references", "squad", "model-routing.md"), "utf8"));
  const assignment = routing.find(table => table.headers[0] === "Class" && table.headers.includes("Roles"));
  const key = role.replace(/^council-/, "");
  const cls = role.startsWith("council-") ? "council" : clean(assignment?.rows.find(row =>
    row[1].split(",").some(cell => clean(cell) === key))?.[0] ?? "implementation");
  const classes = new Map<string, string>();
  for (const table of catalog) {
    const capabilityIndex = table.headers.indexOf("Capability class");
    if (table.headers[0] === "Catalog ID" && capabilityIndex >= 0) {
      for (const row of table.rows) classes.set(clean(row[0]), clean(row[capabilityIndex]));
    }
  }
  const fits = catalog.find(table => table.headers[0] === "Catalog ID" && table.headers.includes("Blended"));
  if (!fits || !assignment) throw new Error("The pinned upstream model-routing tables are missing.");
  if (!["fast", "default", "extended"].includes(floor)) throw new Error(`Unknown economy model floor: ${floor}`);
  const fitIndex = fits.headers.indexOf(cls);
  if (fitIndex < 0) throw new Error(`Unknown model assignment class: ${cls}`);
  const admitted = floor === "fast" ? ["fast-lightweight", "balanced", "code-specialized"] :
    floor === "extended" ? ["frontier-reasoning"] : ["balanced", "code-specialized", "frontier-reasoning"];
  const candidates = fits.rows.map((row, order) => ({
    id: clean(row[0]), family: clean(row[1]), generation: Number(row[2]), fit: Number(row[fitIndex]),
    cost: Number(row[fits.headers.indexOf("Blended")]), order,
  })).filter(row => available.includes(row.id) && admitted.includes(classes.get(row.id) ?? "") &&
    row.fit >= 1 && Number.isFinite(row.cost));
  const tie = (a: typeof candidates[number], b: typeof candidates[number]) =>
    (a.family === b.family ? b.generation - a.generation : 0) || a.order - b.order;
  const ranked = [...candidates].sort((a, b) => b.fit - a.fit || a.cost - b.cost || tie(a, b))[0];
  if (!ranked) {
    throw new EconomyFloorExhaustedError(`Economy routing has no available catalog model at floor ${floor} for ${role}`);
  }
  const economical = ECONOMY_ROLES.has(key) && cls === "implementation"
    ? candidates.filter(candidate => candidate.fit >= 2).sort((a, b) => a.cost - b.cost || b.fit - a.fit || tie(a, b))[0]
    : undefined;
  const pick = economical ?? ranked;
  return {
    model: pick.id, rankedModel: ranked.id, role, floor,
    rationale: `Route: economy; ${economical ? "economy pick" : "ranked pick (protected role)"}; class=${cls}`,
  };
}

/** Unrostered workers inherit the parent's ranked model, never its economy discount. */
export function selectEconomyDelegateModel(
  root: string, parent: EconomyPick, role: string | undefined, floor: string, available: readonly string[],
): EconomyPick {
  if (role) return selectEconomyModel(root, role, floor, available);
  return {
    ...parent, model: parent.rankedModel,
    rationale: `Route: economy; unrostered worker inherits parent ranked pick; parent=${parent.role}; floor=${parent.floor}`,
  };
}
