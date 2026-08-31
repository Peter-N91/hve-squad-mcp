/**
 * Container-local operator CLI for issuing single-use simple OAuth login codes.
 *
 * Run inside the deployed Container App (for example through `az containerapp
 * exec`) so Azure Storage is reached with the app's managed identity. There is no
 * remote code-issuance endpoint and therefore no additional administrator secret.
 */
import { loadOperatorConfig } from "./config/operator-config.js";
import { buildSimpleOAuthAuthority } from "./server-http.js";
import { RedactingLogger } from "./observability/logger.js";

interface CliOptions {
  command: string;
  tenantId?: string;
  subject?: string;
  scopes?: string[];
  ttlSeconds?: number;
  limit?: number;
}

function usage(): string {
  return [
    "Usage:",
    "  node dist/src/oauth-cli.js issue-code --tenant-id <uuid> --subject <id> [options]",
    "  node dist/src/oauth-cli.js sweep [--limit <1..500>]",
    "",
    "Options:",
    "  --scopes <comma-separated>  Defaults to every configured simple OAuth scope.",
    "  --ttl-seconds <60..max>     Defaults to 600 seconds.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const [command = "", ...rest] = argv;
  const options: CliOptions = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near '${flag ?? ""}'.`);
    }
    index += 1;
    if (flag === "--tenant-id") {
      options.tenantId = value;
    } else if (flag === "--subject") {
      options.subject = value;
    } else if (flag === "--scopes") {
      options.scopes = value
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
    } else if (flag === "--ttl-seconds") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        throw new Error("--ttl-seconds must be an integer.");
      }
      options.ttlSeconds = parsed;
    } else if (flag === "--limit") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        throw new Error("--limit must be an integer between 1 and 500.");
      }
      options.limit = parsed;
    } else {
      throw new Error(`Unknown argument '${flag}'.`);
    }
  }
  return options;
}

export async function mainOAuthCli(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (!["issue-code", "sweep"].includes(options.command)) {
    throw new Error(usage());
  }
  const config = loadOperatorConfig();
  if (!config.simpleOAuth.enabled) {
    throw new Error("SQUAD_MCP_SIMPLE_OAUTH_ENABLED is not true in this container.");
  }
  const logger = new RedactingLogger({ name: "hve-squad-oauth-cli" });
  const authority = buildSimpleOAuthAuthority(config, logger);
  if (!authority) {
    throw new Error("Simple OAuth authority could not be constructed.");
  }
  if (options.command === "sweep") {
    const removed = await authority.sweepExpired(options.limit);
    process.stdout.write(`${JSON.stringify({ removed }, null, 2)}\n`);
    return;
  }
  if (!options.tenantId || !options.subject) {
    throw new Error(usage());
  }
  const result = await authority.issueLoginCode({
    tenantId: options.tenantId,
    subject: options.subject,
    scopes: options.scopes,
    ttlSeconds: options.ttlSeconds,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("oauth-cli.js")) {
  mainOAuthCli().catch((error: unknown) => {
    process.stderr.write(`[hve-squad-oauth-cli] ${String(error)}\n`);
    process.exit(1);
  });
}
