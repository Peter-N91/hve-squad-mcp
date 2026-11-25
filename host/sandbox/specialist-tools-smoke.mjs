import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const command = (name,args) => execFileSync(name,args,{encoding:"utf8",env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/tmp/hve-specialist-smoke"},timeout:30000}).trim().slice(0,180);
const commands={python:command("python3",["--version"]),uv:command("/opt/hve-tools/bin/uv",["--version"]),powershell:command("/usr/bin/pwsh",["-NoProfile","-Command","$PSVersionTable.PSVersion.ToString()"]),ffmpeg:command("ffmpeg",["-version"]),libreoffice:command("soffice",["--version"]),graphviz:command("dot",["-V"]),pandoc:command("pandoc",["--version"])};
const envs=JSON.parse(readFileSync('/opt/hve-upstream/manifest.json','utf8')).files.filter(f=>f.path.endsWith('/pyproject.toml'));
for(const f of envs){const name=f.path.slice('.github/skills/'.length,-'/pyproject.toml'.length).replaceAll('/','--');if(!existsSync('/opt/hve-specialists/'+name+'/bin/python'))throw Error('Missing installed skill Python: '+name);}
mkdirSync('/tmp/hve-specialist-smoke',{recursive:true});
const input='/tmp/hve-specialist-smoke/diagram.dot',output='/tmp/hve-specialist-smoke/diagram.png';
writeFileSync(input,'digraph { Browser -> MCP -> Sandbox; }');execFileSync('dot',['-Tpng',input,'-o',output],{timeout:30000});const png=readFileSync(output);if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Graphviz output is not PNG');
console.log(JSON.stringify({kind:'linux-specialist-smoke',commands,pythonEnvironments:envs.length,graphviz:{bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')},authenticatedConnections:'deferred',windows:'unavailable'}));
