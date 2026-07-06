/**
 * stdio transport adapter.
 *
 * The only per-transport code in Phase 0. stdio runs the server as a child
 * process of the host (VS Code), speaking newline-delimited JSON-RPC over
 * stdin/stdout. All logging MUST go to stderr so it never corrupts the protocol
 * stream on stdout. Phase 1 adds a Streamable HTTP adapter beside this one.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
