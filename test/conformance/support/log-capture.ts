/**
 * A capturing {@link RedactingLogger} for the conformance suite.
 *
 * Swaps the default stderr sink for an in-memory line buffer so a corpus can scan
 * every emitted line and assert that NO server secret (bearer token, model key,
 * JWT, `Authorization` header) ever appears (SEC-10). The logger itself is the
 * REAL `RedactingLogger` — only the sink is replaced — so the redaction path under
 * test is the production one.
 */
import { RedactingLogger } from "../../../src/observability/logger.js";

export interface CapturingLogger {
  /** The real redaction-aware logger, wired to an in-memory sink. */
  logger: RedactingLogger;
  /** Every line the logger has emitted (already scrubbed by the logger). */
  lines: string[];
  /** The concatenation of all lines, for substring scans. */
  text(): string;
}

/** Create a {@link RedactingLogger} whose output is captured in `lines`. */
export function createCapturingLogger(name = "conformance"): CapturingLogger {
  const lines: string[] = [];
  const logger = new RedactingLogger({
    level: "debug",
    name,
    sink: (line) => lines.push(line),
  });
  return {
    logger,
    lines,
    text: () => lines.join("\n"),
  };
}
