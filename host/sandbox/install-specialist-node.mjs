import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { dirname } from "node:path";
const root="/opt/hve-upstream", target="/opt/hve-specialist-node";
const manifest=JSON.parse(readFileSync(root+"/manifest.json","utf8"));
let environments=0;
for(const file of manifest.files.filter(f=>f.path.endsWith("/package.json"))){
 const source=dirname(root+"/"+file.path),pkg=JSON.parse(readFileSync(source+"/package.json","utf8"));
 if(!Object.keys(pkg.dependencies??{}).length)continue;
 const name=file.path.slice(".github/skills/".length,-"/package.json".length).replaceAll("/","--"),dest=target+"/"+name;
 mkdirSync(dest,{recursive:true});cpSync(source,dest,{recursive:true});
 if(!existsSync(source+"/package-lock.json")){
   if(file.path!==".github/skills/md-to-docx/scripts/package.json")throw Error("Unpinned specialist Node project: "+file.path);
   cpSync("/opt/hve-specialist-node-lock/package.json",dest+"/package.json");cpSync("/opt/hve-specialist-node-lock/package-lock.json",dest+"/package-lock.json");
 }
 execFileSync("/usr/local/bin/npm",["ci","--engine-strict","--omit=dev","--ignore-scripts","--no-audit","--no-fund"],{cwd:dest,stdio:"inherit",env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/tmp/hve-node-build",PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:"1"},timeout:180000});
 environments++;
}
console.log(JSON.stringify({kind:"specialist-node-installation",environments,productionConnections:false}));
