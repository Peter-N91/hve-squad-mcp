import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecialistConnectorRegistry, type SpecialistConnection, type SpecialistContext } from "../src/engine/copilot/specialist-connectors.js";
const context: SpecialistContext = {tenantId:"tenant-a",subject:"user-a",project:"project-a",runId:"run-a",signal:new AbortController().signal};
const input={service:"azure-devops",connectionId:"ado-a",operation:"read-work-item",args:{id:42}};
function registry(impactful=false,approved=false,output:unknown={id:42}){
  let calls=0;
  const c:SpecialistConnection={id:"ado-a",service:"azure-devops",tenantId:"tenant-a",subject:"user-a",operations:[{name:"read-work-item",impactful,validate:(a):a is Record<string,unknown>=>!!a&&typeof a==="object"&&"id" in a&&typeof a.id==="number"&&Object.keys(a).length===1}],invoke:async()=>{calls++;return output}};
  return {r:new SpecialistConnectorRegistry([c],async()=>approved),calls:()=>calls};
}
test("specialist tools are discoverable but missing connections never use a server identity",async()=>{
  const r=new SpecialistConnectorRegistry([],async()=>false);
  assert.equal(r.tools(context).length,2);
  assert.deepEqual(r.list(context),[]);
  await assert.rejects(r.invoke(input,context),/no approved connection/);
});
test("connections are bound to both tenant and user and validate exact operation input",async()=>{
  const {r,calls}=registry();
  await assert.rejects(r.invoke(input,{...context,subject:"user-b"}),/no approved connection/);
  await assert.rejects(r.invoke(input,{...context,tenantId:"tenant-b"}),/no approved connection/);
  await assert.rejects(r.invoke({...input,args:{id:42,command:"delete"}},context),/does not grant/);
  assert.equal(calls(),0);
  assert.deepEqual(JSON.parse(await r.invoke(input,context)),{id:42});
  assert.equal(calls(),1);
});
test("impactful operations require exact server approval, not a model argument",async()=>{
  const {r,calls}=registry(true);
  await assert.rejects(r.invoke(input,context),/needs explicit server approval/);
  assert.equal(calls(),0);
  await assert.rejects(r.invoke({...input,approved:true},context),/must identify/);
});
test("adapter output cannot expose credentials or unbounded responses",async()=>{
  await assert.rejects(registry(false,false,{access_token:"sensitive"}).r.invoke(input,context),/credential-shaped/);
  await assert.rejects(registry(false,false,{text:"x".repeat(256001)}).r.invoke(input,context),/bounded output/);
});
