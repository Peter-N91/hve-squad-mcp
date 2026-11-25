import type { CopilotToolDefinition, CopilotToolResult } from "./copilot-stage-executor.js";

export type SpecialistService = "azure" | "aws" | "azure-devops" | "github" | "jira" | "gitlab" | "microsoft-365" | "figma" | "mural";
export interface SpecialistInvocation {
  service: SpecialistService; operation: string; connectionId: string; args: Record<string, unknown>;
}
export interface SpecialistContext { tenantId: string; subject: string; project: string; runId: string; signal: AbortSignal }
export interface SpecialistOperation {
  name: string;
  /** Impactful means the server must authorize this exact invocation independently of model text. */
  impactful: boolean;
  validate(args: unknown): args is Record<string, unknown>;
}
export interface SpecialistConnection {
  id: string; service: SpecialistService; tenantId: string; subject: string;
  operations: readonly SpecialistOperation[];
  /** Trusted server callback retains credentials; the sandbox sees only bounded results. */
  invoke(operation: string, args: Record<string, unknown>, context: SpecialistContext): Promise<unknown>;
}
export class SpecialistPrerequisiteError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SpecialistPrerequisiteError"; }
}
const SERVICES = new Set<SpecialistService>(["azure","aws","azure-devops","github","jira","gitlab","microsoft-365","figma","mural"]);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeResult(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 256000) throw new SpecialistPrerequisiteError("result_budget", "Specialist result is absent or exceeds the bounded output size.");
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)|"(?:access_token|refresh_token|client_secret|authorization|cookie|api_token)"\s*:/i.test(serialized)) throw new SpecialistPrerequisiteError("credential_output", "Specialist result contains credential-shaped fields and will not enter model context.");
  return serialized;
}

/** Per-user server-mediated connections; enabling the tool never grants a connection or action. */
export class SpecialistConnectorRegistry {
  constructor(private readonly connections: readonly SpecialistConnection[], private readonly authorizeImpactful: (request: SpecialistInvocation, context: SpecialistContext) => Promise<boolean>) {
    const ids = new Set<string>();
    for (const c of connections) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.id) || !SERVICES.has(c.service) || !c.tenantId || !c.subject || ids.has(c.id)) throw new Error("Invalid specialist connection registration.");
      ids.add(c.id);
      if (new Set(c.operations.map(o => o.name)).size !== c.operations.length) throw new Error("Duplicate specialist operation.");
    }
  }
  list(context: SpecialistContext): { id: string; service: SpecialistService; operations: {name:string;impactful:boolean}[] }[] {
    return this.connections.filter(c => c.tenantId === context.tenantId && c.subject === context.subject)
      .map(c => ({id:c.id,service:c.service,operations:c.operations.map(o=>({name:o.name,impactful:o.impactful}))}));
  }
  async invoke(input: unknown, context: SpecialistContext): Promise<string> {
    if (!context.tenantId || !context.subject || !context.project || !context.runId) throw new SpecialistPrerequisiteError("identity_missing", "An authenticated tenant, user, project and run are required.");
    if (!object(input) || Object.keys(input).some(k => !["service","operation","connectionId","args"].includes(k)) || typeof input.service !== "string" || !SERVICES.has(input.service as SpecialistService) || typeof input.operation !== "string" || typeof input.connectionId !== "string" || !object(input.args)) throw new SpecialistPrerequisiteError("invalid_request", "Specialist request must identify one registered service, connection and structured operation.");
    if (Buffer.byteLength(JSON.stringify(input.args)) > 32000) throw new SpecialistPrerequisiteError("args_budget", "Specialist arguments exceed the bounded input size.");
    const connection = this.connections.find(c => c.id === input.connectionId && c.service === input.service && c.tenantId === context.tenantId && c.subject === context.subject);
    if (!connection) throw new SpecialistPrerequisiteError("connection_required", "This user has no approved connection for the requested specialist service. No server identity or token fallback is permitted.");
    const operation = connection.operations.find(o=>o.name===input.operation);
    if (!operation || !operation.validate(input.args)) throw new SpecialistPrerequisiteError("operation_not_granted", "The connection does not grant this operation or its exact structured arguments.");
    const request: SpecialistInvocation = {service:connection.service,operation:operation.name,connectionId:connection.id,args:input.args};
    context.signal.throwIfAborted();
    if (operation.impactful && !await this.authorizeImpactful(request,context)) throw new SpecialistPrerequisiteError("approval_required", "This exact specialist action needs explicit server approval before execution.");
    context.signal.throwIfAborted();
    return safeResult(await connection.invoke(operation.name,input.args,context));
  }
  tools(context: SpecialistContext): CopilotToolDefinition[] {
    const failure = (error: unknown): CopilotToolResult => {
      if (!(error instanceof SpecialistPrerequisiteError)) throw error;
      return {resultType:"failure",textResultForLlm:JSON.stringify({code:error.code,reason:error.message})};
    };
    return [{name:"list_specialist_connections",description:"List only this authenticated user's approved specialist service connections and operations. Missing services need connection setup; no credentials are returned.",parameters:{type:"object",properties:{},additionalProperties:false},skipPermission:true,handler:()=>({resultType:"success",textResultForLlm:JSON.stringify(this.list(context))})},
      {name:"invoke_specialist_operation",description:"Execute one explicitly granted server-mediated specialist operation. The server checks user/tenant binding, typed input and exact impactful approval; credentials never enter the sandbox.",parameters:{type:"object",properties:{service:{type:"string",enum:[...SERVICES]},connectionId:{type:"string"},operation:{type:"string"},args:{type:"object"}},required:["service","connectionId","operation","args"],additionalProperties:false},skipPermission:true,handler:async input=>{try{return {resultType:"success",textResultForLlm:await this.invoke(input,context)}}catch(error){return failure(error)}}}];
  }
}
