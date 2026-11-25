import type { BackendRequest } from "./model-backend.js";

export const TASK_CONTEXT_MAX_CHARS = 32_000;
export const INPUT_SECTION_MAX_CHARS = 256_000;
const MAX_INSPECTED_CHARS = 4_000_000;
const MAX_NODES = 100_000;
const RULES = [
  "credential_private_key", "credential_bearer", "credential_sas", "credential_token",
  "chat_protocol_delimiter", "task_context_schema", "task_context_budget",
  "input_budget", "uninspectable_input",
] as const;
export type PreflightRule = typeof RULES[number];
export interface PreflightIssue { rule: PreflightRule; field: string }
export interface PreflightDiagnostics { schemaVersion: 1; issues: PreflightIssue[] }
export interface TaskContextPacket {
  kind: "hve-task-context";
  schemaVersion: 1;
  facts: string[];
  decisions: string[];
  constraints: string[];
  openQuestions: string[];
  sources: { path: string; purpose: string; sha256?: string; excerpt?: string }[];
  exclusions: { category: "conversation_history" | "diagnostic_history" | "duplicate" | "unrelated"; count: number }[];
}
const TEXT_ARRAYS = ["facts", "decisions", "constraints", "openQuestions"] as const;
const PACKET_KEYS = ["kind", "schemaVersion", ...TEXT_ARRAYS, "sources", "exclusions"];
const EXCLUSIONS = ["conversation_history", "diagnostic_history", "duplicate", "unrelated"];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
const exactKeys = (value: object, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/** Not every business JSON document is a task packet. */
function packetCandidate(value: unknown): value is Record<string, unknown> {
  return object(value) && (
    (typeof value.kind === "string" && value.kind.startsWith("hve-task-context")) ||
    (Object.hasOwn(value, "schemaVersion") &&
      [...TEXT_ARRAYS, "sources", "exclusions"].every(key => Object.hasOwn(value, key)))
  );
}

function claimsPacket(text: string): boolean {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  for (let i = 0; i < tokens.length - 2; i++) {
    if (!tokens[i].startsWith('"') || tokens[i + 1] !== ":" || !tokens[i + 2].startsWith('"')) continue;
    try {
      const key: unknown = JSON.parse(tokens[i]);
      const value: unknown = JSON.parse(tokens[i + 2]);
      if (key === "kind" && typeof value === "string" && value.startsWith("hve-task-context")) return true;
    } catch { /* Invalid individual strings cannot declare a discriminator. */ }
  }
  return false;
}

function duplicateJsonKeys(text: string): boolean {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const objects: Set<string>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") objects.push(new Set());
    else if (token === "}") objects.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = objects.at(-1);
      const key = JSON.parse(token) as string;
      if (keys?.has(key)) return true;
      keys?.add(key);
    }
  }
  return false;
}

function packetIssue(value: Record<string, unknown>, field: string): PreflightIssue | undefined {
  const invalid = (suffix = ""): PreflightIssue => ({ rule: "task_context_schema", field: field + suffix });
  if (!exactKeys(value, PACKET_KEYS) || value.kind !== "hve-task-context" || value.schemaVersion !== 1) return invalid();
  for (const key of TEXT_ARRAYS) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length > 64) return invalid(`.${key}`);
    for (let i = 0; i < entries.length; i++) if (typeof entries[i] !== "string") return invalid(`.${key}[${i}]`);
  }
  if (!Array.isArray(value.sources) || value.sources.length > 16) return invalid(".sources");
  for (let i = 0; i < value.sources.length; i++) {
    const source: unknown = value.sources[i];
    if (!object(source) || !exactKeys(source, ["path", "purpose"], ["sha256", "excerpt"]) ||
      typeof source.path !== "string" || !source.path.trim() ||
      typeof source.purpose !== "string" || !source.purpose.trim() ||
      (Object.hasOwn(source, "sha256") && (typeof source.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(source.sha256))) ||
      (Object.hasOwn(source, "excerpt") && typeof source.excerpt !== "string")) return invalid(`.sources[${i}]`);
  }
  if (!Array.isArray(value.exclusions) || value.exclusions.length > 64) return invalid(".exclusions");
  for (let i = 0; i < value.exclusions.length; i++) {
    const exclusion: unknown = value.exclusions[i];
    if (!object(exclusion) || !exactKeys(exclusion, ["category", "count"]) ||
      typeof exclusion.category !== "string" || !EXCLUSIONS.includes(exclusion.category) ||
      typeof exclusion.count !== "number" || !Number.isSafeInteger(exclusion.count) || exclusion.count < 0) {
      return invalid(`.exclusions[${i}]`);
    }
  }
  return undefined;
}

/** Revalidate receipts without accepting caller-controlled prose or object keys. */
export function readPreflightDiagnostics(value: unknown): PreflightDiagnostics | undefined {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.issues) ||
    value.issues.length < 1 || value.issues.length > 8) return undefined;
  const issues: PreflightIssue[] = [];
  for (const item of value.issues) {
    if (!object(item) || !RULES.includes(item.rule as PreflightRule) || typeof item.field !== "string" ||
      item.field.length > 240 ||
      !/^(?:system|messages|tools|request|context|priorArtifact)(?:\[\d{1,6}\]|\.(?:content|toolCalls|toolCallId|id|arguments|responseItems|description|parameters|name|values|keys|facts|decisions|constraints|openQuestions|sources|exclusions))*$/.test(item.field)) return undefined;
    issues.push({ rule: item.rule as PreflightRule, field: item.field });
  }
  return { schemaVersion: 1, issues };
}

class Inspector {
  readonly issues: PreflightIssue[] = [];
  private chars = 0;
  private nodes = 0;
  private readonly ancestors = new Set<object>();

  issue(rule: PreflightRule, field: string) {
    if (field.length > 220) field = field.split(".").slice(0, 12).join(".");
    if (this.issues.length < 8 && !this.issues.some(item => item.rule === rule && item.field === field)) {
      this.issues.push({ rule, field });
    }
  }

  text(value: string, field: string, depth = 0) {
    if (this.issues.length >= 8) return;
    if (typeof value !== "string") { this.issue("uninspectable_input", field); return; }
    this.chars += value.length;
    if (this.chars > MAX_INSPECTED_CHARS) { this.issue("input_budget", field); return; }
    if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{32,}/.test(value)) this.issue("credential_private_key", field);
    if (/\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/i.test(value)) this.issue("credential_bearer", field);
    if ((/(?:^|[?&])sv=\d{4}-\d{2}-\d{2}/i.test(value) && /[?&]sig=[A-Za-z0-9%+/_=-]{16,}/i.test(value)) ||
      (/\bSharedAccessSignature[ \t]+/i.test(value) &&
        /(?:^|[?&\s])sig=[A-Za-z0-9%+/_=-]{16,}/i.test(value))) this.issue("credential_sas", field);
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/.test(value) ||
      /\b(?:AccountKey|SharedAccessKey)["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{32,}={0,2}(?:["';\s]|$)/i.test(value) ||
      /\b(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_.~-]{24,}/i.test(value) ||
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/.test(value)) this.issue("credential_token", field);
    if (/<\|(?:im_start|im_end|start_header_id|end_header_id|eot_id|endoftext|system|user|assistant|tool|start|end|channel|message)\|>|<\/?(?:start_of_turn|end_of_turn)>|\[\/?INST\]|<<\/?SYS>>/.test(value)) {
      this.issue("chat_protocol_delimiter", field);
    }
    // Decode JSON string values, not arbitrary encodings. This closes escaped
    // tool-argument/result bypasses without rejecting ordinary nested JSON.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (packetCandidate(parsed)) {
          const issue = value.length > TASK_CONTEXT_MAX_CHARS
            ? { rule: "task_context_budget" as const, field }
            : duplicateJsonKeys(value) ? { rule: "task_context_schema" as const, field } : packetIssue(parsed, field);
          if (issue) this.issue(issue.rule, issue.field);
        }
        this.walk(parsed, field, depth + 1);
      } catch {
        if (claimsPacket(value)) this.issue("task_context_schema", field);
      }
    }
  }

  walk(value: unknown, field: string, depth = 0, opaqueReasoning = false): void {
    if (this.issues.length >= 8) return;
    if (++this.nodes > MAX_NODES || depth > 32) { this.issue("uninspectable_input", field); return; }
    if (typeof value === "string") { this.text(value, field, depth); return; }
    if (value === null || typeof value !== "object") return;
    if (this.ancestors.has(value)) { this.issue("uninspectable_input", field); return; }
    this.ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const sasVersion = descriptors.sv?.value;
      const sasSignature = descriptors.sig?.value;
      if (typeof sasVersion === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sasVersion) &&
        typeof sasSignature === "string" && /^[A-Za-z0-9%+/_=-]{16,}$/.test(sasSignature)) {
        this.issue("credential_sas", field);
      }
      let i = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(value) && key === "length") continue;
        if (opaqueReasoning && key === "encrypted_content") continue;
        const child = `${field}.values[${i}]`;
        if (!("value" in descriptor)) this.issue("uninspectable_input", child);
        else {
          this.text(key, `${field}.keys[${i}]`, depth + 1);
          this.walk(descriptor.value, child, depth + 1);
        }
        i++;
        if (this.issues.length >= 8 || this.nodes > MAX_NODES) break;
      }
    } catch { this.issue("uninspectable_input", field); }
    finally { this.ancestors.delete(value); }
  }

  result(): PreflightDiagnostics | undefined {
    return this.issues.length ? { schemaVersion: 1, issues: this.issues } : undefined;
  }
}

export function inspectInputSection(text: string, field: "request" | "context" | "priorArtifact") {
  const inspector = new Inspector();
  if (text.length > INPUT_SECTION_MAX_CHARS) inspector.issue("input_budget", field);
  else inspector.text(text, field);
  return inspector.result();
}

/** Accepted text is returned byte-for-byte; no summarization, trimming or rewriting. */
export function inspectTaskContext(text: string): { text: string; packet: boolean; preflight?: PreflightDiagnostics } {
  let packet = false;
  const inspector = new Inspector();
  if (text.length > INPUT_SECTION_MAX_CHARS) {
    inspector.issue("input_budget", "context");
    return { text, packet, preflight: inspector.result() };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    packet = packetCandidate(parsed);
    if (packet) {
      if (text.length > TASK_CONTEXT_MAX_CHARS) inspector.issue("task_context_budget", "context");
      else {
        const issue = duplicateJsonKeys(text)
          ? { rule: "task_context_schema" as const, field: "context" }
          : packetIssue(parsed as Record<string, unknown>, "context");
        if (issue) inspector.issue(issue.rule, issue.field);
      }
    } else if (claimsPacket(text)) {
      packet = true;
      inspector.issue("task_context_schema", "context");
    }
  } catch {
    if (/^\s*[\[{]/.test(text) && claimsPacket(text)) {
      packet = true;
      inspector.issue("task_context_schema", "context");
    }
  }
  inspector.text(text, "context");
  return { text, packet, preflight: inspector.result() };
}

/** Inspects all outbound visible data. Opaque Responses reasoning is never decoded. */
export function inspectBackendRequest(request: BackendRequest): PreflightDiagnostics | undefined {
  const inspector = new Inspector();
  try {
    if (request.messages.length > MAX_NODES || (request.tools?.length ?? 0) > MAX_NODES) {
      inspector.issue("uninspectable_input", "request");
      return inspector.result();
    }
    inspector.text(request.system, "system");
    request.messages.forEach((message, index) => {
      const field = `messages[${index}]`;
      if ((message.toolCalls?.length ?? 0) > MAX_NODES || (message.responseItems?.length ?? 0) > MAX_NODES) {
        inspector.issue("uninspectable_input", field);
        return;
      }
      inspector.text(message.content, `${field}.content`);
      if (message.toolCallId) inspector.text(message.toolCallId, `${field}.toolCallId`);
      message.toolCalls?.forEach((call, i) => {
        inspector.text(call.id, `${field}.toolCalls[${i}].id`);
        inspector.text(call.name, `${field}.toolCalls[${i}].name`);
        inspector.text(call.arguments, `${field}.toolCalls[${i}].arguments`);
      });
      message.responseItems?.forEach((item, i) => {
        inspector.walk(item, `${field}.responseItems[${i}]`, 0, own(item, "type") === "reasoning");
      });
    });
    request.tools?.forEach((tool, index) => {
      inspector.text(tool.name, `tools[${index}].name`);
      inspector.text(tool.description, `tools[${index}].description`);
      inspector.walk(tool.parameters, `tools[${index}].parameters`);
    });
  } catch { inspector.issue("uninspectable_input", "request"); }
  return inspector.result();
}
