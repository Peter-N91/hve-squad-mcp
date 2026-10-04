import type { BackendTool } from "../model-backend.js";

const CODES = new Set([
  "invalid_request_error", "invalid_request", "invalid_value", "invalid_type", "invalid_json",
  "invalid_function_parameters", "unsupported_parameter", "unsupported_value",
  "missing_required_parameter", "badrequest", "model_not_found", "deploymentnotfound",
  "context_length_exceeded", "string_above_max_length", "rate_limit_exceeded",
  "insufficient_quota", "server_error", "internal_server_error", "no_capacity",
  "content_filter", "contentfiltered", "content_policy", "responsibleaipolicyviolation",
]);
const TYPES = new Set([
  "invalid_request_error", "invalid_request", "server_error", "rate_limit_error",
  "authentication_error", "permission_error", "too_many_requests", "forbidden", "user_error",
]);
const FIELDS = new Set([
  "model", "instructions", "input", "messages", "content", "role", "type", "text", "verbosity",
  "tools", "tool_choice", "parameters", "properties", "items", "required", "additionalProperties",
  "name", "description", "strict", "enum", "format", "anyOf", "oneOf", "allOf", "store", "include",
  "max_output_tokens", "max_tokens", "max_completion_tokens", "reasoning", "reasoning_effort",
  "effort", "temperature", "top_p", "function",
  "call_id", "arguments", "output", "encrypted_content",
]);
// A vocabulary, not a list of complete errors: novel combinations remain useful
// without allowing arbitrary provider text into logs. Never add customer nouns.
const DIAGNOSTIC_WORDS = new Set(`
  a an the this that these those is are was were be been being not no none only
  and or but for from to of in on at with without as by than if when while
  must should cannot can does do did has have had will may would could
  provided requested received expected actual allowed supported unsupported
  required missing invalid valid unknown unrecognized unexpected incorrect
  incompatible unavailable disabled enabled forbidden denied failed failure error
  request response parameter parameters argument arguments value values type types
  format schema property properties object array string number integer boolean null role roles
  empty nonempty non nullable nullability additional length size count limit limits
  maximum minimum max min exceeds exceeded exceeding below above greater less equal
  too many much large long small short characters bytes tokens token total
  input output content message messages instructions prompt prompts system user assistant tool tools
  function functions call calls result results item items text image images audio
  video file files data json body header headers field fields index indices
  model models deployment deployments version api operation operations feature features
  capability capabilities configuration combination option options resource resources
  context window capacity quota rate exceeded exhausted throttled
  temperature reasoning effort verbosity sampling top stop streaming stream
  completion completions responses chat endpoint service server internal upstream
  bad validation validate validationerror conflict duplicate duplicates mismatch
  unique match matching must supplied supply set setting settings used use using
  support supports supported accept accepts accepted reject rejects rejected
  contain contains containing include includes included excluding exclude
  one two multiple single both either neither all any each every other same different
  before after previous next first last sequence order ordered ordering position
  pending completed incomplete cancelled canceled timeout timed out expired
  unavailable overload overloaded busy retry retryable transient processing processed
  authentication authorization permission permissions access account subscription region
  policy filter filtered filtering violation responsible safety prohibited blocked
  cannot exceed compatible available currently yet supported false true
`.trim().split(/\s+/));
const MARKER = "[redacted]";

export interface ProviderValidationContext {
  /** Exact authentication values; retained nowhere, including partially. */
  secrets?: readonly string[];
  /** Serialized outgoing request, for identifying contextual input echoes. */
  requestText?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

function own(error: Record<string, unknown>, key: string): unknown {
  // Only JSON data properties; do not execute a custom backend's getters.
  try { return Object.getOwnPropertyDescriptor(error, key)?.value; } catch { return undefined; }
}

function diagnosticIdentifier(value: unknown, allowed: ReadonlySet<string>, context: ProviderValidationContext): string | null {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || text.length > 96 || !text.length ||
    context.secrets?.some(secret => secret && text.includes(secret))) return null;
  if (allowed.has(text.toLowerCase())) return text;
  if (context.requestText?.includes(text)) return null;
  // Numeric Azure error codes are not HTTP statuses; keep them only in typed
  // code/type/reason slots, never take arbitrary numbers from provider prose.
  if (/^\d{3,6}$/.test(text)) return text;
  if (!/^[A-Za-z]+(?:[_-][A-Za-z]+)*$/.test(text)) return null;
  const parts = text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[_ -]/);
  const vocabulary = [...DIAGNOSTIC_WORDS].filter(word => word.length >= 3);
  const segment = (word: string): boolean => {
    const reachable = new Set([0]);
    for (let i = 0; i < word.length; i++) {
      if (!reachable.has(i)) continue;
      for (const token of vocabulary) if (word.startsWith(token, i)) reachable.add(i + token.length);
    }
    return reachable.has(word.length);
  };
  return /invalid|unsupported|missing|required|error|request|response|failure|failed|limit|exceed|denied|forbidden|not|timeout|unavailable|validation|filter|quota|capacity|conflict|incompatible/i.test(text) &&
    parts.every(part => DIAGNOSTIC_WORDS.has(part) || segment(part)) ? text : null;
}

function fieldPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 180 ||
    !/^[a-zA-Z_]+(?:\[\d{1,6}\]|\.(?:[a-zA-Z_]+|\d{1,6}))*$/.test(value)) return null;
  return value.match(/[a-zA-Z_]+/g)?.every(part => FIELDS.has(part)) ? value : null;
}

/** Raw records stay inside the adapter; never pass these to logging or persistence. */
export function providerErrorEnvelopes(payload: unknown) {
  const pending = [{ path: "root", error: record(payload), depth: 0 }];
  const seen = new Set<object>();
  const result: { path: string; error: Record<string, unknown> }[] = [];
  while (pending.length && result.length < 8) {
    const current = pending.shift()!;
    if (seen.has(current.error)) continue;
    seen.add(current.error);
    result.push({ path: current.path, error: current.error });
    if (current.depth >= 4) continue;
    for (const key of ["error", "innererror", "inner_error", "reason"]) {
      const child = own(current.error, key);
      if (child && typeof child === "object" && !Array.isArray(child)) {
        pending.push({
          path: `${current.path}.${key}`,
          error: child as Record<string, unknown>,
          depth: current.depth + 1,
        });
      }
    }
  }
  return result;
}

function diagnosticMessage(value: unknown, context: ProviderValidationContext): string | null {
  if (typeof value !== "string" || value.length > 4096 ||
    (context.requestText?.length ?? 0) > 2_000_000) return null;
  let text = value;
  for (const secret of context.secrets ?? []) {
    if (secret) text = text.split(secret).join(MARKER);
  }
  // Drop the rest of an explicitly echoed payload or instruction, not just its
  // label. Context matching below also catches unlabeled copied input.
  text = text.split(/\b(?:(?:prompt|tool output|tool result|user input|input text)\s*[:=]|(?:customer|chain.of.thought|encrypted.content|private reasoning|ignore previous|ignore all|authorization|bearer|api.key|password|secret|email|address|phone|ssn)\b)/i, 1)[0]!;
  text = text
    .replace(/https?:\/\/[^\s]+|www\.[^\s]+|[\w.+-]+@[\w.-]+|\b(?:sk|eyJ)[\w.-]+/gi, MARKER)
    .replace(/```[\s\S]*?(?:```|$)|\{[\s\S]*|\<[\s\S]*/g, MARKER)
    .replace(/(["'`])(?:(?!\1)[\s\S])*?\1/g, quoted => {
      const field = fieldPath(quoted.slice(1, -1));
      return field ? ` ${field} ` : MARKER;
    });
  const tokens = text.match(/[A-Za-z_]+(?:\[\d{1,6}\]|\.(?:[A-Za-z_]+|\d{1,6}))*|[^\sA-Za-z_]+/g) ?? [];
  const projected = tokens.map(token => {
    if (/^[.,:;!?()-]+$/.test(token)) return token;
    if (fieldPath(token)) return token;
    const word = token.toLowerCase();
    return DIAGNOSTIC_WORDS.has(word) ? word : MARKER;
  });
  if (context.requestText) {
    const request = context.requestText.toLowerCase().replace(/\\[nrt]|\s+/g, " ");
    // Every copied span of three words (including all-diagnostic vocabulary)
    // is withheld. Only bounded provider text is scanned against the request.
    for (let i = 0; i < tokens.length - 2; i++) {
      const phrase = tokens.slice(i, i + 3).join(" ").toLowerCase();
      if (phrase.length >= 12 && request.includes(phrase)) {
        projected.fill(MARKER, i, i + 3);
      }
    }
  }
  const result = projected.join(" ").replace(/(?:\[redacted\]\s*)+/g, `${MARKER} `).trim().slice(0, 512);
  return /\b(?:invalid|unsupported|missing|required|exceed\w*|expected|failed|error|not|cannot|rejected|limit|incompatible|unavailable|denied|must|only|too|above|below|greater|less|maximum|minimum|incomplete|exhausted|overloaded)\b/.test(result)
    ? result : null;
}

/** Operator rejection logs only. Public/durable failure metadata stays stricter. */
function projectError(error: Record<string, unknown>, tools: readonly BackendTool[], context: ProviderValidationContext) {
  const providerCode = diagnosticIdentifier(own(error, "code"), CODES, context);
  const providerType = diagnosticIdentifier(own(error, "type"), TYPES, context);
  const providerParam = fieldPath(own(error, "param"));
  const providerReason = diagnosticIdentifier(own(error, "reason"), CODES, context);
  const fields = { code: providerCode, type: providerType, param: providerParam, reason: providerReason };
  const fieldStates = Object.fromEntries(Object.entries(fields).map(([key, safe]) => [
    key, own(error, key) === undefined || own(error, key) === null ? "absent" : safe === null ? "omitted_unsafe_or_unknown" : "validated",
  ]));
  let explanation: { rule: string; field?: string; tool?: string; text: string } | null = null;
  let explanationState = "absent";
  const messageValue = own(error, "message") ?? own(error, "reason");
  if (messageValue !== undefined && messageValue !== null) {
    explanationState = "omitted_unsafe_or_unrecognized";
    if (typeof messageValue === "string" && messageValue.length <= 4096) {
      const message = messageValue;
      const parameter = /^(Unsupported|Unknown|Unrecognized|Missing required) parameter:\s*['"]([^'"]+)['"]/i.exec(message);
      const field = parameter && fieldPath(parameter[2]);
      if (parameter && field) {
        const missing = parameter[1].toLowerCase() === "missing required";
        explanation = {
          rule: missing ? "missing_required_parameter" : "unsupported_parameter", field,
          text: missing ? "The provider requires this request parameter." : "The provider does not recognize or support this request parameter.",
        };
      }
      const schema = /^Invalid schema for function ['"]([A-Za-z_][A-Za-z0-9_]{0,63})['"]:/i.exec(message);
      if (schema && tools.some(tool => tool.name === schema[1])) {
        const rule = /array schema missing items/i.test(message) ? "array_schema_missing_items"
          : /'additionalProperties'.*required.*false/i.test(message) ? "additional_properties_must_be_false"
            : /'required'.*required to be supplied/i.test(message) ? "required_keys_constraint"
              : /must have a ['"]type['"] key/i.test(message) ? "schema_type_required"
                : "invalid_function_schema";
        explanation = { rule, tool: schema[1], text: "The provider rejected this server-declared function's JSON schema." };
      }
      if (explanation) explanationState = "recognized";
      else {
        const text = diagnosticMessage(message, context);
        if (text) {
          explanation = { rule: "diagnostic_vocabulary_projection", text };
          explanationState = "redacted_projection";
        }
      }
    }
  }
  return {
    providerCode, providerType, providerParam, providerReason, fieldStates, explanation, explanationState,
  };
}

export function safeProviderValidation(payload: unknown, tools: readonly BackendTool[] = [], context: ProviderValidationContext = {}) {
  const envelopes = providerErrorEnvelopes(payload).map(({ path, error }) => ({
    path, ...projectError(error, tools, context),
  }));
  const deepestFirst = [...envelopes].reverse();
  const empty = projectError({}, tools, context);
  const code = deepestFirst.find(item => item.fieldStates.code !== "absent") ?? empty;
  const type = deepestFirst.find(item => item.fieldStates.type !== "absent") ?? empty;
  const param = deepestFirst.find(item => item.fieldStates.param !== "absent") ?? empty;
  const reason = deepestFirst.find(item => item.fieldStates.reason !== "absent") ?? empty;
  const explanation = deepestFirst.find(item => item.explanationState !== "absent") ?? empty;
  return {
    schemaVersion: 2,
    policy: "bounded_diagnostic_vocabulary",
    providerCode: code.providerCode,
    providerType: type.providerType,
    providerParam: param.providerParam,
    providerReason: reason.providerReason,
    fieldStates: { code: code.fieldStates.code, type: type.fieldStates.type, param: param.fieldStates.param, reason: reason.fieldStates.reason },
    explanation: explanation.explanation,
    explanationState: explanation.explanationState,
    envelopes,
    rawMessageRetained: false,
    rawBodyRetained: false,
  };
}
