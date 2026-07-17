/**
 * Tool + router layer.
 *
 * Exposes the coarse `squad_*` tools as MCP tool descriptors (advertising the
 * raw JSON Schema authored in `tools.catalog.yml`), validates tool-call inputs
 * against that schema with Ajv, and maps a validated call into a normalized
 * `CoordinatorRequest`. This is the squad's routing boundary expressed as a tool
 * surface; the routing decision itself lives in the catalog (one row per tool).
 *
 * The router is intentionally decoupled from the MCP SDK: it throws
 * `ToolInputError` on bad input, and the server translates that into an MCP
 * protocol error. This keeps the router unit-testable without a transport.
 */
import { Ajv, type ValidateFunction } from "ajv";

import type { CatalogTool, ToolCatalog } from "../catalog/catalog.js";
import type { CoordinatorRequest } from "../engine/coordinator-engine.js";

/** Thrown when a tool-call input fails JSON Schema validation. */
export class ToolInputError extends Error {
  constructor(
    message: string,
    readonly toolId: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** An MCP tool descriptor as advertised by `tools/list`. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class ToolRouter {
  private readonly toolsById = new Map<string, CatalogTool>();
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(catalog: ToolCatalog) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const tool of catalog.tools) {
      this.toolsById.set(tool.id, tool);
      this.validators.set(tool.id, ajv.compile(tool.input));
    }
  }

  /** The advertised tool ids, in catalog order. */
  get toolIds(): string[] {
    return [...this.toolsById.keys()];
  }

  /** Project the catalog into MCP `tools/list` descriptors. */
  listToolDescriptors(): ToolDescriptor[] {
    return [...this.toolsById.values()].map((tool) => ({
      name: tool.id,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input as unknown as Record<string, unknown>,
    }));
  }

  /** Look up a tool by id. */
  getTool(id: string): CatalogTool | undefined {
    return this.toolsById.get(id);
  }

  /**
   * Validate a tool-call argument object against the tool's JSON Schema.
   * Throws `ToolInputError` when the tool is unknown or the input is malformed.
   */
  validateInput(id: string, args: unknown): void {
    const validate = this.validators.get(id);
    if (!validate) {
      throw new ToolInputError(`Unknown tool: ${id}`, id, []);
    }
    const candidate = args ?? {};
    if (!validate(candidate)) {
      const details = (validate.errors ?? []).map(
        (err) => `${err.instancePath || "(root)"} ${err.message ?? "is invalid"}`.trim(),
      );
      throw new ToolInputError(
        `Invalid input for tool "${id}": ${details.join("; ")}`,
        id,
        details,
      );
    }
  }

  /** Map a validated argument object into a normalized CoordinatorRequest. */
  toCoordinatorRequest(tool: CatalogTool, args: unknown): CoordinatorRequest {
    const record = (args ?? {}) as Record<string, unknown>;
    return {
      toolId: tool.id,
      request: String(record.request ?? ""),
      profile: optionalString(record.profile),
      tier: optionalString(record.tier),
      owner: optionalString(record.owner),
      mode: optionalString(record.mode),
      context: optionalString(record.context),
      squad: optionalString(record.squad),
      init: record.init === true,
    };
  }
}
