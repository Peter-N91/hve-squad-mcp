import assert from "node:assert/strict";
import {test} from "node:test";
import {createSpecialistHttpConnection} from "../src/engine/copilot/specialist-http-adapters.js";
import {SpecialistConnectorRegistry} from "../src/engine/copilot/specialist-connectors.js";
const ctx={tenantId:"tenant",subject:"user",project:"p",runId:"r",signal:new AbortController().signal};
test("actual HTTP adapter keeps credentials server-side and refuses resource/redirect escalation",async()=>{
 let calls=0;
 const client=createSpecialistHttpConnection({id:"gh",service:"github",tenantId:"tenant",subject:"user",origin:"https://api.github.com",resources:["owner/repo"],authorization:async()=>"Bearer test-only"},async(url,options)=>{calls++;assert.equal(String(url),"https://api.github.com/repos/owner/repo/issues/42");assert.equal(options?.redirect,"manual");assert.equal(new Headers(options?.headers).get("Authorization"),"Bearer test-only");return new Response('{"number":42}',{headers:{"content-type":"application/json"}});});
 const r=new SpecialistConnectorRegistry([client],async()=>false);
 const req={connectionId:"gh",service:"github",operation:"read-issue",args:{owner:"owner",repository:"repo",number:42}};
 assert.equal(JSON.parse(await r.invoke(req,ctx)).number,42);
 await assert.rejects(r.invoke({...req,args:{...req.args,repository:"other"}},ctx),/outside the approved/);
 assert.equal(calls,1);
});
test("AWS and mismatched official endpoints require proper adapters rather than token reuse",()=>{
 assert.throws(()=>createSpecialistHttpConnection({id:"x",service:"azure",tenantId:"tenant",subject:"user",origin:"https://evil.example",resources:[],authorization:async()=>"x"}),/official API/);
 assert.throws(()=>createSpecialistHttpConnection({id:"x",service:"aws",tenantId:"tenant",subject:"user",origin:"https://example.amazonaws.com",resources:[],authorization:async()=>"x"}),/SigV4/);
});
