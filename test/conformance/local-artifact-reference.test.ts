import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {FileSquadMemoryStore} from "../../src/engine/backends/file-squad-memory.js";
import {MemoryBackedArtifactStore} from "../../src/engine/artifact-store.js";
import {buildHarness,initializeSession,callTool} from "./support/harness.js";

test("authenticated history read publishes transient specialist reference without altering stored evidence",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"binary-history-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const memory=new FileSquadMemoryStore({baseDir:dir}),store=new MemoryBackedArtifactStore(memory);
 const path="outputs/report.docx.artifact.json",content=JSON.stringify({kind:"local-specialist-artifact",sha256:"a".repeat(64)});
 await store.put("tenant-A","default",path,content);let calls=0;
 const h=buildHarness({memoryStore:memory,artifactsEnabled:true,localArtifactReference:async(tenant,project,p)=>{calls++;assert.equal(tenant,"tenant-A");assert.equal(project,"default");assert.equal(p,path);return {downloadUrl:"https://example.invalid/transient-test",expiresAt:"2026-10-10T20:00:00Z",sha256:"a".repeat(64),mediaType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"};}});
 h.verifier.register({token:"owner",tenantId:"tenant-A",subject:"user-A",scopes:["Squad.Memory"]});
 const sessionId=await initializeSession(h.handler,"owner");
 const response=await callTool(h.handler,{token:"owner",sessionId,name:"squad_history",args:{project:"default",op:"read",path}});
 assert.equal(response.status,200);const body=response.body as {result:{structuredContent:{download:{sha256:string}}}};
 assert.equal(body.result.structuredContent.download.sha256,"a".repeat(64));assert.equal(calls,1);
 assert.equal((await store.get("tenant-A","default",path))!.content,content);
 assert.ok(!content.includes("downloadUrl"));
});

test("authenticated binary history chunks use exact metadata scope and reject mixed or invalid ranges",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"binary-chunk-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const memory=new FileSquadMemoryStore({baseDir:dir});let calls=0;
 const h=buildHarness({memoryStore:memory,artifactsEnabled:true,localArtifactChunk:async(tenant,project,path,offset)=>{
  calls++;assert.equal(tenant,"tenant-A");assert.equal(project,"default");assert.equal(path,"outputs/report.docx.artifact.json");assert.equal(offset,0);
  return {base64:"UEsDBA==",offset:0,nextOffset:null,totalBytes:4,sha256:"a".repeat(64),mediaType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"};
 }});
 h.verifier.register({token:"owner",tenantId:"tenant-A",subject:"user-A",scopes:["Squad.Memory"]});
 const sessionId=await initializeSession(h.handler,"owner");
 const response=await callTool(h.handler,{token:"owner",sessionId,name:"squad_history",args:{project:"default",op:"read",path:"outputs/report.docx.artifact.json",binaryOffset:0}});
 const body=response.body as {result:{structuredContent:{binary:{base64:string;totalBytes:number}}}};
 assert.equal(body.result.structuredContent.binary.base64,"UEsDBA==");assert.equal(body.result.structuredContent.binary.totalBytes,4);
 for(const args of [
  {project:"default",op:"read",path:"outputs/report.docx",binaryOffset:0},
  {project:"default",op:"read",path:"outputs/report.docx.artifact.json",binaryOffset:-1},
  {project:"default",op:"read",path:"outputs/report.docx.artifact.json",binaryOffset:0,offset:0},
 ]){
  const bad=await callTool(h.handler,{token:"owner",sessionId,name:"squad_history",args});
  assert.ok("error" in (bad.body as object));
 }
 assert.equal(calls,1);
});
