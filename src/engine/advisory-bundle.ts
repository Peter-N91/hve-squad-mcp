import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type BundleKind = "skills" | "instructions";

export class BundleResourceError extends Error {}

export class BundleLookupError extends BundleResourceError {
  constructor(message: string, readonly path: string, readonly kind: BundleKind, readonly discovery: "list_bundle" | "list_references") {
    super(`${message} Requested resource: ${JSON.stringify(path)}.`);
  }
}

function canonicalPath(path: string): void {
  if (!path || path.includes("\\") || path.includes(":") || /[\x00-\x1f]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new BundleResourceError("Use a canonical bundle-relative resource path without traversal.");
  }
}

function contained(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new BundleResourceError("The resource escapes its pinned bundle.");
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Read-only access to the operator's pinned bundle, never the project workspace. */
export class AdvisoryBundle {
  constructor(private readonly githubRoot: string) {}

  async list(kind: BundleKind, references = false): Promise<string[]> {
    const root = await realpath(this.githubRoot);
    const directory = join(root, kind);
    const result: string[] = [];
    const visit = async (path: string): Promise<void> => {
      const resolved = await realpath(path);
      contained(root, resolved);
      for (const entry of await readdir(resolved, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new BundleResourceError("Symbolic links are not allowed in the pinned resource tree.");
        const child = join(resolved, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile() && (references ? /\.(?:md|json|ya?ml|txt|csv)$/.test(entry.name)
          : kind === "skills" ? entry.name === "SKILL.md" : entry.name.endsWith(".instructions.md"))) {
          const path = relative(directory, child).split(sep).join("/");
          result.push(references ? `${kind}/${path}` : path);
        }
      }
    };
    try {
      await visit(directory);
    } catch (error) {
      if (missing(error)) throw new BundleResourceError(`The pinned ${kind} tree is unavailable.`);
      throw error;
    }
    return result.sort();
  }

  async skill(name: string, file = "SKILL.md"): Promise<{ path: string; content: string }> {
    canonicalPath(name);
    const candidates = (await this.list("skills")).map((path) => path.slice(0, -"/SKILL.md".length));
    const matches = candidates.filter((path) => path === name || path.split("/").at(-1) === name);
    if (matches.length !== 1) {
      throw new BundleLookupError(matches.length ? "Skill name is ambiguous; use its full relative directory." : "The requested skill is not in the pinned bundle.",
        name, "skills", "list_bundle");
    }
    const resource = (file || "SKILL.md").split("#")[0];
    canonicalPath(resource);
    if (!resource.endsWith(".md")) throw new BundleResourceError("Only Markdown skill instructions can be loaded.");
    return this.read("skills", `${matches[0]}/${resource}`, matches[0]);
  }

  async instruction(path: string): Promise<{ path: string; content: string }> {
    canonicalPath(path);
    if (!path.endsWith(".instructions.md")) throw new BundleResourceError("Only pinned instruction files can be loaded.");
    return this.read("instructions", path);
  }

  async reference(path: string): Promise<{ path: string; content: string }> {
    canonicalPath(path);
    const [kind, ...parts] = path.split("/");
    if ((kind !== "skills" && kind !== "instructions") || !/\.(?:md|json|ya?ml|txt|csv)$/.test(path)) {
      throw new BundleResourceError("Only pinned Markdown or declarative reference data may be read; scripts and binaries are unavailable.");
    }
    return this.read(kind, parts.join("/"));
  }

  private async read(kind: BundleKind, path: string, skillDirectory?: string): Promise<{ path: string; content: string }> {
    let githubRoot: string;
    let root: string;
    try {
      githubRoot = await realpath(this.githubRoot);
      root = await realpath(join(githubRoot, kind, skillDirectory ?? ""));
      contained(githubRoot, root);
    } catch (error) {
      if (missing(error)) throw new BundleResourceError(`The pinned ${kind} tree or selected skill directory is unavailable.`);
      throw error;
    }
    try {
      const target = await realpath(join(githubRoot, kind, path));
      contained(root, target);
      const content = await readFile(target, "utf8");
      return { path: `${kind}/${path}`, content };
    } catch (error) {
      if (missing(error)) throw new BundleLookupError("The requested pinned resource is missing.", `${kind}/${path}`, kind, "list_references");
      throw error;
    }
  }
}
