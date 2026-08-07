/**
 * Create a change fragment under `.changes/unreleased/`.
 *
 * Interactive when run bare, scriptable with flags. The filename carries a date
 * and a slug so two open pull requests never collide on it — which is the point
 * of fragments over editing `CHANGELOG.md` directly.
 *
 *   npm run change
 *   npm run change -- --type Fixed --bump patch --title "cast drift" --body "- ..."
 */
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SECTION_ORDER, type Bump, type Section } from "./release-prep.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAGMENT_DIR = join(dirname(SCRIPT_DIR), ".changes", "unreleased");

const BUMPS: Bump[] = ["patch", "minor", "major"];

const BUMP_HINT: Record<Bump, string> = {
  patch: "Everything else — including a new agent or role under a capability that already shipped",
  minor: "A genuinely new idea, or something that materially changes how the package is used",
  major: "A consumer must change their integration",
};

/** Normalize a title into a filename slug (max 48 chars). */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");
  return slug.length > 0 ? slug : "change";
}

/** Build the fragment filename for a date and title. */
export function fragmentName(title: string, date = new Date()): string {
  return `${date.toISOString().slice(0, 10).replace(/-/g, "")}-${slugify(title)}.md`;
}

/** Render the fragment file body. */
export function renderFragment(type: Section, bump: Bump, body: string): string {
  const bullets = body.trim().startsWith("-") ? body.trim() : `- ${body.trim()}`;
  return ["---", `bump: ${bump}`, `type: ${type}`, "---", "", bullets, ""].join("\n");
}

interface Args {
  type?: Section;
  bump?: Bump;
  title?: string;
  body?: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = (): string => argv[(i += 1)] ?? "";
    switch (argv[i]) {
      case "--force":
        args.force = true;
        break;
      case "--type": {
        const value = next();
        args.type = SECTION_ORDER.find((s) => s.toLowerCase() === value.toLowerCase());
        if (!args.type) {
          throw new Error(`--type must be one of ${SECTION_ORDER.join(", ")}.`);
        }
        break;
      }
      case "--bump": {
        const value = next() as Bump;
        if (!BUMPS.includes(value)) {
          throw new Error("--bump must be patch, minor, or major.");
        }
        args.bump = value;
        break;
      }
      case "--title":
        args.title = next();
        break;
      case "--body":
        args.body = next();
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

async function prompt(argv: string[]): Promise<Required<Omit<Args, "force">> & { force: boolean }> {
  const args = parseArgs(argv);
  if (args.type && args.bump && args.title && args.body) {
    return { ...args, force: args.force } as Required<Omit<Args, "force">> & { force: boolean };
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let type = args.type;
    if (!type) {
      process.stdout.write("Section:\n");
      SECTION_ORDER.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s}\n`));
      const answer = await rl.question("Choose 1-6: ");
      type = SECTION_ORDER[Number.parseInt(answer, 10) - 1];
      if (!type) {
        throw new Error("Not a valid section.");
      }
    }
    let bump = args.bump;
    if (!bump) {
      process.stdout.write("\nVersion impact — the level tracks IDEAS, not artifacts:\n");
      BUMPS.forEach((b, i) => process.stdout.write(`  ${i + 1}. ${b} — ${BUMP_HINT[b]}\n`));
      const answer = await rl.question("Choose 1-3: ");
      bump = BUMPS[Number.parseInt(answer, 10) - 1];
      if (!bump) {
        throw new Error("Not a valid bump level.");
      }
    }
    const title = args.title ?? (await rl.question("\nShort title (filename only): "));
    let body = args.body;
    if (!body) {
      process.stdout.write("\nRelease notes as markdown bullets. Blank line to finish.\n");
      const lines: string[] = [];
      for (;;) {
        const line = await rl.question("> ");
        if (line.trim().length === 0) {
          break;
        }
        lines.push(line);
      }
      body = lines.join("\n");
    }
    if (!title.trim() || !body.trim()) {
      throw new Error("A title and a body are both required.");
    }
    return { type, bump, title, body, force: args.force };
  } finally {
    rl.close();
  }
}

export async function runCli(argv: string[]): Promise<number> {
  let answers;
  try {
    answers = await prompt(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const target = join(FRAGMENT_DIR, fragmentName(answers.title));
  if (existsSync(target) && !answers.force) {
    process.stderr.write(`${target} already exists (pass --force to overwrite).\n`);
    return 1;
  }
  mkdirSync(FRAGMENT_DIR, { recursive: true });
  writeFileSync(target, renderFragment(answers.type, answers.bump, answers.body), "utf8");
  process.stdout.write(`Wrote ${target}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
