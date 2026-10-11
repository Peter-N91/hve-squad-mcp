import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const root = "/opt/hve-upstream";
const manifest = JSON.parse(readFileSync(root + "/manifest.json", "utf8"));
for (const file of manifest.files) {
  const bytes = readFileSync(root + "/" + file.path);
  if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Linux upstream package drift: " + file.path);
}
const workspace = "/tmp/hve-upstream-linux-smoke";
mkdirSync(workspace, { recursive: true });
writeFileSync(workspace + "/team.md", "# Members\n\nModel routing: economy\n\n| Role | Agent Name (Primary) | Model Tier |\n| --- | --- | --- |\n| developer | Squad Implementor | default |\n| tester | Squad Reviewer | fast |\n");
const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8" };
const script = name => root + "/.github/skills/squad/scripts/" + name + ".ps1";
const run = (name, args) => execFileSync("/usr/bin/pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script(name), "-SquadRoot", workspace, ...args], { encoding: "utf8", env, timeout: 120_000 });
run("Initialize-SquadConsumptionRates", ["-Mode", "economy"]);
const output = JSON.parse(run("Measure-SquadLedger", ["-Format", "json"]));
if (!output.unitEconomics || output.unitEconomics.accepted !== 0 || output.unitEconomics.estCreditsPerAccepted !== null) throw new Error("Upstream FinOps smoke returned invalid empty-roster accounting.");
run("Initialize-SquadConsumptionRates", ["-Check", "-Mode", "economy"]);
console.log(JSON.stringify({ test: "isolated Linux upstream bundle and FinOps", verifiedFiles: manifest.files.length, unitEconomics: output.unitEconomics, productionUsage: false }));
