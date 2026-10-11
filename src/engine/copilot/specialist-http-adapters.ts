import { SpecialistPrerequisiteError, type SpecialistConnection, type SpecialistService, type SpecialistOperation } from "./specialist-connectors.js";

export interface ApprovedHttpConnection {
  id:string;service:SpecialistService;tenantId:string;subject:string;
  /** Exact approved origin, never supplied by the model. */
  origin:string;
  /** Reads server-owned user credential at call time. Never serialized or sent to the sandbox. */
  authorization:()=>Promise<string>;
  /** Explicit resource boundaries, e.g. allowed GitHub owner/repository names. */
  resources:readonly string[];
}
const object=(a:unknown):a is Record<string,unknown>=>!!a&&typeof a==="object"&&!Array.isArray(a);
const scalar=(a:unknown):a is string=>typeof a==="string"&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(a);
const identifier=(a:unknown):a is number=>typeof a==="number"&&Number.isSafeInteger(a)&&a>0;
const closed=(a:unknown,keys:string[]):a is Record<string,unknown>=>object(a)&&Object.keys(a).length===keys.length&&keys.every(k=>Object.hasOwn(a,k));
interface EndpointOperation extends SpecialistOperation { path:(args:Record<string,unknown>,c:ApprovedHttpConnection)=>string }
const segments=(...s:string[])=>s.map(encodeURIComponent).join("/");
const scopes=(c:ApprovedHttpConnection,key:string)=>{if(!c.resources.includes(key))throw new SpecialistPrerequisiteError("resource_not_granted","This specialist resource is outside the approved connection boundary.");};
function operations(service:SpecialistService):EndpointOperation[]{
  switch(service){
    case "github":return [{name:"read-issue",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["owner","repository","number"])&&scalar(a.owner)&&scalar(a.repository)&&identifier(a.number),path:(a,c)=>{const key=a.owner+"/"+a.repository;scopes(c,key);return "/repos/"+segments(String(a.owner),String(a.repository))+"/issues/"+a.number;}}];
    case "gitlab":return [{name:"read-issue",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["project","number"])&&typeof a.project==="string"&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(a.project)&&identifier(a.number),path:(a,c)=>{scopes(c,String(a.project));return "/api/v4/projects/"+encodeURIComponent(String(a.project))+"/issues/"+a.number;}}];
    case "jira":return [{name:"read-issue",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["key"])&&typeof a.key==="string"&&/^[A-Z][A-Z0-9_]{0,30}-[1-9][0-9]*$/.test(a.key),path:(a,c)=>{scopes(c,String(a.key).split("-")[0]);return "/rest/api/3/issue/"+encodeURIComponent(String(a.key));}}];
    case "azure-devops":return [{name:"read-work-item",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["organization","project","id"])&&scalar(a.organization)&&scalar(a.project)&&identifier(a.id),path:(a,c)=>{scopes(c,a.organization+"/"+a.project);return "/"+segments(String(a.organization),String(a.project))+"/_apis/wit/workitems/"+a.id+"?api-version=7.1";}}];
    case "azure":return [{name:"read-resource",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["resourceId","apiVersion"])&&typeof a.resourceId==="string"&&/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/[A-Za-z0-9.]+\/[A-Za-z0-9._()/-]+$/i.test(a.resourceId)&&!a.resourceId.includes("..")&&typeof a.apiVersion==="string"&&/^\d{4}-\d\d-\d\d(?:-preview)?$/.test(a.apiVersion),path:(a,c)=>{scopes(c,String(a.resourceId));return String(a.resourceId)+"?api-version="+a.apiVersion;}}];
    case "microsoft-365":return [{name:"read-user",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["id"])&&typeof a.id==="string"&&/^[a-f0-9-]{36}$/i.test(a.id),path:(a,c)=>{scopes(c,String(a.id));return "/v1.0/users/"+encodeURIComponent(String(a.id))+"?$select=id,displayName,jobTitle";}}];
    case "figma":return [{name:"read-file",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["key"])&&scalar(a.key),path:(a,c)=>{scopes(c,String(a.key));return "/v1/files/"+encodeURIComponent(String(a.key));}}];
    case "mural":return [{name:"read-mural",impactful:false,validate:(a):a is Record<string,unknown>=>closed(a,["id"])&&scalar(a.id),path:(a,c)=>{scopes(c,String(a.id));return "/api/public/v1/murals/"+encodeURIComponent(String(a.id));}}];
    case "aws":throw new SpecialistPrerequisiteError("aws_signer_required","AWS requires an approved per-user SigV4 signing adapter; bearer credentials are not interchangeable.");
  }
}
const fixed:Partial<Record<SpecialistService,string>>={azure:"https://management.azure.com",github:"https://api.github.com","azure-devops":"https://dev.azure.com","microsoft-365":"https://graph.microsoft.com",figma:"https://api.figma.com",mural:"https://app.mural.co"};

/** Concrete bounded read adapters. Write operations need their own exact approval-aware contract. */
export function createSpecialistHttpConnection(c:ApprovedHttpConnection,fetcher:typeof fetch=fetch):SpecialistConnection{
  const origin=new URL(c.origin);
  if(origin.protocol!=="https:"||origin.href!==origin.origin+"/"||origin.username||origin.password||origin.port)throw new Error("Specialist origin must be an approved HTTPS origin without credentials or paths.");
  if(fixed[c.service]&&origin.origin!==fixed[c.service])throw new Error("Specialist service origin does not match its official API.");
  const ops=operations(c.service);
  return {id:c.id,service:c.service,tenantId:c.tenantId,subject:c.subject,operations:ops,invoke:async(name,args,context)=>{
    const op=ops.find(op=>op.name===name);
    if(!op||!op.validate(args))throw new SpecialistPrerequisiteError("operation_not_granted","Invalid exact specialist operation.");
    const path=op.path(args,c),url=new URL(path,origin);
    if(url.origin!==origin.origin)throw new SpecialistPrerequisiteError("origin_changed","Specialist operation changed its approved origin.");
    const auth=await c.authorization();
    if(!auth||/[\r\n]/.test(auth))throw new SpecialistPrerequisiteError("connection_expired","The approved user connection is missing or expired.");
    const response=await fetcher(url,{method:"GET",redirect:"manual",signal:AbortSignal.any([context.signal,AbortSignal.timeout(20000)]),headers:{Authorization:auth,Accept:"application/json"}});
    if(response.status!==200)throw new SpecialistPrerequisiteError("service_error","Specialist API returned HTTP "+response.status+"; no redirect or credential fallback was attempted.");
    if(!response.body||!response.headers.get("content-type")?.includes("json"))throw new SpecialistPrerequisiteError("response_type","Specialist API returned no usable JSON.");
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
    try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>256000){await reader.cancel();throw new SpecialistPrerequisiteError("result_budget","Specialist API result exceeds the output budget.");}parts.push(item.value);}}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  }};
}
