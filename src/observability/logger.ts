/**
 * Redaction-aware logger (SEC-10).
 *
 * The ONLY logging path the remote/embedded code uses. Every line is scrubbed
 * through {@link redactString} against the registered-secret set before it is
 * written, so a token, model key, or downstream credential can never appear in
 * a log — even if a caller accidentally interpolates one into a message.
 *
 * Logs go to **stderr** only. The stdio transport reserves stdout for the
 * JSON-RPC protocol stream; the HTTP transport has no stdout protocol contract
 * but keeping one sink keeps the contract uniform and avoids interleaving.
 *
 * The logger captures the secret set by reference; registering a secret after a
 * sink is attached still scrubs it (the set is read at write time).
 */
import { redactString, redactValue } from "./redact.js";

/** A sink receives already-rendered, already-scrubbed log lines. */
export type LogSink = (line: string) => void;

/** Severity levels, lowest to highest. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Minimum level to emit (default `info`). */
  level?: LogLevel;
  /** Where scrubbed lines are written (default stderr). */
  sink?: LogSink;
  /** A name prefixed to every line. */
  name?: string;
}

/**
 * A small structured logger. `fields` are JSON-serialized and scrubbed; the
 * message string is scrubbed; the secret set is shared so a value registered
 * anywhere is redacted everywhere.
 */
export class RedactingLogger {
  private readonly secrets = new Set<string>();
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly name: string;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
    this.name = options.name ?? "hve-squad-mcp";
  }

  /**
   * Register a secret value so every future (and concurrent) log line redacts
   * it. Called at the trust boundary: the auth middleware registers the raw
   * bearer token; the backend credential provider registers the model key.
   */
  registerSecret(value: string | undefined | null): void {
    if (typeof value === "string" && value.length >= 8) {
      this.secrets.add(value);
    }
  }

  /** The live secret set (read-only view) for ad-hoc scrubbing by callers. */
  get secretSet(): ReadonlySet<string> {
    return this.secrets;
  }

  /** Scrub an arbitrary string with the current secret set. */
  scrub(value: string): string {
    return redactString(value, this.secrets);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.emit("error", message, fields);
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const scrubbedMessage = redactString(message, this.secrets);
    let suffix = "";
    if (fields && Object.keys(fields).length > 0) {
      const scrubbedFields = redactValue(fields, this.secrets);
      suffix = ` ${JSON.stringify(scrubbedFields)}`;
    }
    this.sink(`[${this.name}] ${level} ${scrubbedMessage}${suffix}`);
  }
}
