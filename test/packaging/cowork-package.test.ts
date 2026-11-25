import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { loadCatalog } from "../../src/catalog/catalog.js";
import { packageRoot } from "../../src/paths.js";
import {
  buildColorIcon, buildCoworkPackage, buildCoworkTools, buildManifest, buildOutlineIcon, buildSkill, buildZip,
  crc32, DEFAULT_OPTIONS, isWithinRepository, MANIFEST_SCHEMA_URL, placeholderOptions, resolveOptions,
  runCli, SKILL_NAME, validateOptions, ZIP_NAME,
} from "../../generators/build-cowork-package.js";

const root = packageRoot();
const catalog = loadCatalog();
const pkg = buildCoworkPackage(catalog);
const json = (name: string) => JSON.parse((pkg.packaged.get(name) as Buffer).toString());

test("manifest validates against pinned official 1.28 schema (no network or skip)", async () => {
  // Downloaded verbatim from MANIFEST_SCHEMA_URL, 2026-10-17. Pin bytes to make
  // schema drift reviewable; never replace validation with a hand-written subset.
  const bytes = readFileSync(join(root, "test", "packaging", "fixtures", "MicrosoftTeams-v1.28.schema.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "cce967bb1c77641634ce30353f2a699c44cf245e695d2c7a34bb8be771877c3d");
  const schema = JSON.parse(bytes.toString());
  assert.equal(schema.$schema, "http://json-schema.org/draft-04/schema#");
  // The official document uses no draft-04-only validation keywords; Ajv 8 can
  // evaluate its constraints with the obsolete meta-schema declaration removed.
  delete schema.$schema;
  const unwrap = (mod: unknown): any => {
    let value = mod as any;
    while (typeof value !== "function" && value.default) value = value.default;
    return value;
  };
  const Ajv = unwrap(await import("ajv"));
  const formats = unwrap(await import("ajv-formats"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  formats(ajv);
  const validate = ajv.compile(schema);
  const manifest = json("manifest.json");
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.$schema, MANIFEST_SCHEMA_URL);
  assert.equal(manifest.manifestVersion, "1.28");
  assert.equal(validate({ ...manifest, packageName: "not-a-schema-field" }), false);
  const invalid = structuredClone(manifest);
  invalid.agentConnectors[0].toolSource.remoteMcpServer.authorization.type = "InventedAuth";
  assert.equal(validate(invalid), false, "the official authorization enum must be enforced");
});

test("package uses OAuthPluginVault operator placeholders, safe icons and no ambient identity", () => {
  const manifest = json("manifest.json");
  assert.deepEqual(manifest.agentSkills, [{ folder: `./skills/${SKILL_NAME}` }]);
  const remote = manifest.agentConnectors[0].toolSource.remoteMcpServer;
  assert.deepEqual(remote.authorization, { type: "OAuthPluginVault", referenceId: "<AUTH_CONFIG_ID>" });
  assert.equal(remote.mcpServerUrl, "https://example.invalid/mcp");
  assert.equal(remote.mcpToolDescription.file, "./tools/hve-squad-tools.json");
  assert.equal(manifest.id, "00000000-0000-0000-0000-000000000000");
  for (const [name, data] of pkg.packaged) {
    if (name.endsWith(".png")) continue;
    assert.doesNotMatch(data.toString(), /client[_-]?secret|github[_-]?client[_-]?id|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN.*PRIVATE KEY/i);
  }
  const inventory = json("tools/hve-squad-tools.json");
  assert.ok(inventory.tools.length >= 15);
  for (const tool of inventory.tools) assert.ok(tool.inputSchema.type === "object");
  assert.doesNotMatch(JSON.stringify(manifest), /webApplicationInfo|authorizationUrl|clientId/);
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["color", "outline"]);
});

test("PNG sizes, chunks and CRCs are valid with deterministic decodable pixels", () => {
  for (const [png, size] of [[buildColorIcon(), 192], [buildOutlineIcon(), 32]] as const) {
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    let offset = 8; const chunks: string[] = []; const compressed: Buffer[] = [];
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.subarray(offset + 4, offset + 8).toString("ascii"); chunks.push(type);
      const body = png.subarray(offset + 8, offset + 8 + length);
      assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
      if (type === "IHDR") assert.deepEqual([body.readUInt32BE(), body.readUInt32BE(4)], [size, size]);
      if (type === "IDAT") compressed.push(body);
      offset += 12 + length;
    }
    assert.equal(chunks.at(-1), "IEND");
    assert.equal(inflateSync(Buffer.concat(compressed)).length, (size + 1) * size);
  }
});

test("ZIP stored entries have fixed dates, CRCs, safe folders and exact package contents", () => {
  assert.ok(pkg.zip.equals(buildCoworkPackage(catalog).zip));
  assert.ok(pkg.zip.equals(buildZip([...pkg.packaged].reverse().map(([name, data]) => ({ name, data })))));
  const end = pkg.zip.length - 22;
  assert.equal(pkg.zip.readUInt32LE(end), 0x06054b50);
  const names: string[] = [];
  let offset = pkg.zip.readUInt32LE(end + 16);
  for (let i = 0; i < pkg.zip.readUInt16LE(end + 10); i++) {
    assert.equal(pkg.zip.readUInt32LE(offset), 0x02014b50);
    assert.equal(pkg.zip.readUInt16LE(offset + 10), 0, "stored, not platform-dependent compression");
    assert.equal(pkg.zip.readUInt16LE(offset + 12), 0);
    assert.equal(pkg.zip.readUInt16LE(offset + 14), 33, "1980-01-01");
    const length = pkg.zip.readUInt16LE(offset + 28);
    const name = pkg.zip.subarray(offset + 46, offset + 46 + length).toString(); names.push(name);
    const local = pkg.zip.readUInt32LE(offset + 42);
    const start = local + 30 + pkg.zip.readUInt16LE(local + 26) + pkg.zip.readUInt16LE(local + 28);
    const data = pkg.zip.subarray(start, start + pkg.zip.readUInt32LE(offset + 24));
    assert.equal(crc32(data), pkg.zip.readUInt32LE(offset + 16));
    if (!name.endsWith("/")) assert.ok(data.equals(pkg.packaged.get(name) as Buffer), name);
    offset += 46 + length + pkg.zip.readUInt16LE(offset + 30) + pkg.zip.readUInt16LE(offset + 32);
  }
  assert.deepEqual(names.filter((name) => !name.endsWith("/")).sort(), [...pkg.packaged.keys()].sort());
  assert.deepEqual(names, [...names].sort());
  assert.ok(!names.includes("README.md") && !names.includes(".gitattributes"));
  for (const name of ["../escape", "/absolute", "a\\b"]) assert.throws(() => buildZip([{ name, data: Buffer.alloc(0) }]));
});

test("all generated text and binary outputs match checked-in artifacts", () => {
  for (const [name, expected] of [...pkg.packaged, ...pkg.extras, [ZIP_NAME, pkg.zip] as [string, Buffer]]) {
    const actual = readFileSync(join(root, "generated", "cowork-package", ...name.split("/")));
    if (name.endsWith(".png") || name.endsWith(".zip")) assert.ok(actual.equals(expected), name);
    else assert.equal(actual.toString().replace(/\r\n/g, "\n"), expected.toString(), name);
  }
  assert.match((pkg.extras.get(".gitattributes") as Buffer).toString(), /\*\.png binary\n\*\.zip binary/);
});

test("skill references available tools and stops for linking without fabricating approval", () => {
  const skill = (pkg.packaged.get(`skills/${SKILL_NAME}/SKILL.md`) as Buffer).toString();
  assert.match(skill, new RegExp(`^---\\nname: ${SKILL_NAME}\\n`));
  assert.match(skill, /github_connection_required/);
  assert.match(skill, /Then stop/);
  assert.match(skill, /Never claim an approval happened/);
  assert.doesNotMatch(skill, /squad_approve|squad-executed/);
  const names = new Set(buildCoworkTools(catalog).map((tool) => tool.name));
  for (const [name] of skill.matchAll(/\bsquad_[a-z_]+\b/g)) assert.ok(names.has(name), name);
  assert.throws(() => buildSkill([]), /not in the connector tool set/);
});

test("operator options are validated and cannot write live values inside the public repository", () => {
  assert.deepEqual(resolveOptions([], {}), DEFAULT_OPTIONS);
  assert.equal(placeholderOptions(DEFAULT_OPTIONS).length, 6);
  assert.equal(resolveOptions(["--package-version", "2.0.0"], { HVE_COWORK_PACKAGE_VERSION: "3.0.0" }).packageVersion, "2.0.0");
  for (const value of ["http://example.invalid/mcp", "https://user:secret@example.invalid/mcp", "https://example.invalid/mcp?token=hidden"]) {
    assert.throws(() => validateOptions({ ...DEFAULT_OPTIONS, mcpServerUrl: value }));
  }
  assert.throws(() => validateOptions({ ...DEFAULT_OPTIONS, packageId: "not-a-guid" }));
  assert.equal(runCli(["--strict"], {}), 1);
  assert.equal(runCli(["--out-dir"], {}), 1);
  assert.equal(runCli(["--unexpected"], {}), 1);
  assert.equal(runCli(["--auth-config-id", "operator-value"], {}), 1);
  assert.equal(runCli(["--auth-config-id", "operator-value", "--out-dir", join(root, "generated", "cowork-package", "nested")], {}), 1);
  assert.equal(isWithinRepository(root), true);
  assert.equal(isWithinRepository(join(root, "test", "packaging")), true);
  assert.equal(isWithinRepository(join(root, "..", "private-operator-package")), false);
  assert.equal(buildManifest(DEFAULT_OPTIONS).version, "1.0.0");
});
