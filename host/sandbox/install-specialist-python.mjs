import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const root = "/opt/hve-upstream";
const manifest = JSON.parse(readFileSync(root + "/manifest.json", "utf8"));
const environments = "/opt/hve-specialists";
mkdirSync(environments, { recursive: true });
let installed = 0;
for (const file of manifest.files.filter(file => file.path.endsWith("/pyproject.toml"))) {
  const project = dirname(root + "/" + file.path);
  const lock = project + "/uv.lock";
  if (!existsSync(lock)) throw new Error("Specialist Python project requires a dependency lock: " + file.path);
  const name = file.path.slice(".github/skills/".length, -"/pyproject.toml".length).replaceAll("/", "--");
  const environment = environments + "/" + name;
  execFileSync("/opt/hve-tools/bin/uv", ["sync", "--locked", "--no-dev", "--no-install-project", "--project", project], {
    stdio: "inherit", env: { PATH: "/usr/bin:/bin", HOME: "/tmp/hve-specialist-build", UV_PROJECT_ENVIRONMENT: environment, UV_CACHE_DIR: "/tmp/hve-uv-cache", UV_PYTHON_DOWNLOADS: "never" },
    timeout: 180000,
  });
  execFileSync(environment + "/bin/python", ["-c", "import sys; assert sys.version_info >= (3,11)"], {stdio:"inherit"});
  installed++;
}
console.log(JSON.stringify({kind:"specialist-python-installation",lockedEnvironments:installed,productionConnections:false}));
