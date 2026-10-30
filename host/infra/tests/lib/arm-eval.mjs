// Local, credential-free evaluator for compiled ARM (Bicep) templates.
//
// Used by the infra validation scripts (sec-diff.mjs, validate.mjs) to turn a
// compiled main.json / bootstrap.json plus a parameters file into a normalized
// RESOURCE INVENTORY: every resource that would be deployed, with its resolved
// type, id (scope + name), and fully evaluated properties — including resources
// inside nested module deployments, with module parameters flowed across the
// boundary. Nothing here calls Azure.
//
// Runtime-only values (reference(), list*()) evaluate to symbolic Unknown values
// such as <ref(/subscriptions/.../userassignedidentities/x).principalId>, which
// are stable across two templates that reference the same resource, so a before
// / after comparison stays meaningful. A caller can supply `stubs` to give a
// runtime value a concrete value (used to exercise runtime fail() guards).
//
// fail() raises a GuardFailure, so a fixture that should be rejected by a
// template guard can be proven locally. ARM's if() is lazy (only the chosen
// branch is evaluated); this evaluator matches that.

import { createHash } from "node:crypto";

export class Unknown {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return `<${this.text}>`;
  }
  toJSON() {
    return `<${this.text}>`;
  }
}

export class GuardFailure extends Error {
  constructor(message, where) {
    super(`fail(): ${message}${where ? ` [at ${where}]` : ""}`);
    this.guardMessage = message;
    this.where = where;
  }
}

export class EvalError extends Error {}

/** Every guid() the evaluator computed: synthetic guid -> its input tuple (for reports). */
export const guidInputs = new Map();

// ---------------------------------------------------------------------------
// Expression parser
// ---------------------------------------------------------------------------

function isExpression(value) {
  return typeof value === "string" && value.startsWith("[") && !value.startsWith("[[") && value.endsWith("]");
}

function parse(src) {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = () => src[i];
  const expect = (ch) => {
    ws();
    if (src[i] !== ch) throw new EvalError(`Expected '${ch}' at ${i} in ${src}`);
    i++;
  };
  function primary() {
    ws();
    const ch = peek();
    if (ch === "'") {
      i++;
      let out = "";
      for (;;) {
        if (i >= src.length) throw new EvalError(`Unterminated string in ${src}`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += src[i++];
      }
      return { k: "lit", v: out };
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      i += m[0].length;
      return { k: "lit", v: Number(m[0]) };
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) throw new EvalError(`Unexpected '${ch}' at ${i} in ${src}`);
    i += m[0].length;
    let name = m[0];
    // Namespaced user-defined function: ns.member(
    const nsm = /^\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(src.slice(i));
    if (nsm) {
      name = `${name}.${nsm[1]}`;
      i += 1 + nsm[1].length;
    }
    expect("(");
    const args = [];
    ws();
    if (peek() === ")") {
      i++;
    } else {
      for (;;) {
        args.push(expr());
        ws();
        if (peek() === ",") {
          i++;
          continue;
        }
        expect(")");
        break;
      }
    }
    return { k: "call", name, args };
  }
  function expr() {
    let node = primary();
    for (;;) {
      ws();
      if (peek() === ".") {
        i++;
        ws();
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
        if (!m) throw new EvalError(`Bad property at ${i} in ${src}`);
        i += m[0].length;
        node = { k: "prop", obj: node, name: m[0] };
      } else if (peek() === "[") {
        i++;
        const idx = expr();
        expect("]");
        node = { k: "index", obj: node, idx };
      } else {
        return node;
      }
    }
  }
  const node = expr();
  ws();
  if (i !== src.length) throw new EvalError(`Trailing input at ${i} in ${src}`);
  return node;
}

const parseCache = new Map();
function parseCached(src) {
  let n = parseCache.get(src);
  if (!n) {
    n = parse(src);
    parseCache.set(src, n);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isUnknown = (v) => v instanceof Unknown;
const anyUnknown = (arr) => arr.some(isUnknown);
const repr = (v) => (isUnknown(v) ? v.toString() : typeof v === "string" ? `'${v}'` : JSON.stringify(v));

function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function canonical(v) {
  if (isUnknown(v)) return v.toString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

export function armString(v) {
  if (isUnknown(v)) return v.toString();
  if (typeof v === "boolean") return v ? "True" : "False";
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(canonical(v));
  return String(v);
}

function hashText(parts, len) {
  return createHash("sha256").update(parts.map(armString).join("|")).digest("hex").slice(0, len);
}

function interleave(type, names) {
  const segs = type.split("/");
  let out = `${segs[0]}/${segs[1]}/${names[0]}`;
  for (let j = 2; j < segs.length; j++) out += `/${segs[j]}/${names[j - 1]}`;
  return out;
}

const looksLikeType = (s) => typeof s === "string" && /^[A-Za-z0-9]+\.[A-Za-z0-9.]+\/[A-Za-z0-9]+/.test(s);

// ---------------------------------------------------------------------------
// Evaluation context
// ---------------------------------------------------------------------------

export class TemplateContext {
  /**
   * @param {object} template compiled ARM template
   * @param {object} paramValues map name -> value (already evaluated)
   * @param {object} scope { tenantId, subscriptionId, resourceGroup|null, location, deploymentName, rgLocations }
   * @param {object} opts { stubs, path, secureValues }
   */
  constructor(template, paramValues, scope, opts) {
    this.template = template;
    this.scope = scope;
    this.opts = opts;
    this.path = opts.path || "root";
    this.params = {};
    this.varCache = new Map();
    this.varBusy = new Set();
    this.lambdaStack = [];
    this.copyStack = [];
    this.symbols = new Map();
    this.moduleOutputs = new Map();
    this.secureValues = opts.secureValues || new Set();
    const defs = template.parameters || {};
    for (const [name, def] of Object.entries(defs)) {
      if (Object.prototype.hasOwnProperty.call(paramValues, name)) {
        this.params[name] = paramValues[name];
      } else if (Object.prototype.hasOwnProperty.call(def, "defaultValue")) {
        this.params[name] = { __lazyDefault: def.defaultValue };
      } else if (def.nullable) {
        this.params[name] = null;
      } else {
        throw new EvalError(`${this.path}: required parameter '${name}' has no value`);
      }
      if (/secure/i.test(def.type || "") && typeof paramValues[name] === "string" && paramValues[name] !== "") {
        this.secureValues.add(paramValues[name]);
      }
    }
    this.functions = new Map();
    for (const ns of template.functions || []) {
      for (const [member, def] of Object.entries(ns.members || {})) this.functions.set(`${ns.namespace}.${member}`, def);
    }
  }

  subId() {
    return this.scope.subscriptionId;
  }
  rgName() {
    return this.scope.resourceGroup;
  }
  rgId() {
    return `/subscriptions/${this.subId()}/resourceGroups/${this.rgName()}`;
  }

  param(name) {
    if (!Object.prototype.hasOwnProperty.call(this.params, name)) throw new EvalError(`${this.path}: unknown parameter '${name}'`);
    let v = this.params[name];
    if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, "__lazyDefault")) {
      v = this.deep(v.__lazyDefault);
      this.params[name] = v;
    }
    return v;
  }

  variable(name) {
    if (this.varCache.has(name)) return this.varCache.get(name);
    const vars = this.template.variables || {};
    if (this.varBusy.has(name)) throw new EvalError(`${this.path}: variable cycle at '${name}'`);
    this.varBusy.add(name);
    let v;
    try {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        v = this.deep(vars[name]);
      } else {
        const loop = (vars.copy || []).find((c) => c.name === name);
        if (!loop) throw new EvalError(`${this.path}: unknown variable '${name}'`);
        const count = this.deep(loop.count);
        v = [];
        for (let n = 0; n < count; n++) {
          this.copyStack.push({ name, index: n });
          try {
            v.push(this.deep(loop.input));
          } finally {
            this.copyStack.pop();
          }
        }
      }
    } finally {
      this.varBusy.delete(name);
    }
    this.varCache.set(name, v);
    return v;
  }

  unknown(text) {
    const stubs = this.opts.stubs || {};
    if (Object.prototype.hasOwnProperty.call(stubs, text)) return stubs[text];
    return new Unknown(text);
  }

  // Deep-evaluate a JSON value: strings that are expressions are evaluated;
  // objects carrying a property-copy array are expanded.
  deep(value) {
    if (typeof value === "string") {
      if (isExpression(value)) return this.evalNode(parseCached(value.slice(1, -1)));
      if (value.startsWith("[[")) return value.slice(1);
      return value;
    }
    if (Array.isArray(value)) return value.map((x) => this.deep(x));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "copy" && Array.isArray(v)) {
          for (const loop of v) {
            const count = this.deep(loop.count);
            const items = [];
            for (let n = 0; n < count; n++) {
              this.copyStack.push({ name: loop.name, index: n });
              try {
                items.push(this.deep(loop.input));
              } finally {
                this.copyStack.pop();
              }
            }
            out[loop.name] = items;
          }
          continue;
        }
        out[isExpression(k) ? armString(this.deep(k)) : k] = this.deep(v);
      }
      return out;
    }
    return value;
  }

  evalNode(node) {
    switch (node.k) {
      case "lit":
        return node.v;
      case "prop":
        return this.getProp(this.evalNode(node.obj), node.name);
      case "index": {
        const obj = this.evalNode(node.obj);
        const idx = this.evalNode(node.idx);
        if (isUnknown(obj) || isUnknown(idx)) return this.unknown(`${isUnknown(obj) ? obj.text : armString(obj)}[${armString(idx)}]`);
        if (Array.isArray(obj)) {
          if (typeof idx !== "number" || idx < 0 || idx >= obj.length) {
            throw new EvalError(`${this.path}: index ${idx} out of range (length ${obj.length})`);
          }
          return obj[idx];
        }
        return this.getProp(obj, idx);
      }
      case "call":
        return this.call(node);
      default:
        throw new EvalError(`bad node ${node.k}`);
    }
  }

  getProp(obj, name) {
    if (isUnknown(obj)) {
      if (obj.text.startsWith("refFull(") && name === "properties") return this.unknown(obj.text.replace(/^refFull\(/, "ref("));
      return this.unknown(`${obj.text}.${name}`);
    }
    if (obj === null || obj === undefined) throw new EvalError(`${this.path}: property '${name}' of null`);
    if (typeof obj !== "object") throw new EvalError(`${this.path}: property '${name}' of ${typeof obj}`);
    const key = Object.keys(obj).find((k) => k.toLowerCase() === String(name).toLowerCase());
    if (key === undefined) throw new EvalError(`${this.path}: missing property '${name}'`);
    return obj[key];
  }

  resolveResourceRef(x) {
    // A symbolic name (languageVersion 2.0) or a resource id.
    if (typeof x === "string" && this.symbols.has(x)) return this.symbols.get(x);
    if (typeof x === "string") {
      for (const s of this.symbols.values()) {
        if (s.idKnown && s.id.toLowerCase() === x.toLowerCase()) return s;
      }
      return { id: x };
    }
    return { id: armString(x) };
  }

  moduleOutputObject(sym) {
    if (!this.moduleOutputs.has(sym.symbol)) {
      if (!sym.child) throw new EvalError(`${this.path}: module '${sym.symbol}' is not deployed but its outputs are referenced`);
      this.moduleOutputs.set(sym.symbol, sym.child.outputs());
    }
    const o = {};
    for (const [k, v] of Object.entries(this.moduleOutputs.get(sym.symbol))) o[k] = { value: v };
    return { outputs: o };
  }

  callUserFunction(name, args) {
    const def = this.functions.get(name);
    const bound = {};
    (def.parameters || []).forEach((p, n) => {
      bound[p.name] = args[n];
    });
    const fnTemplate = {
      parameters: Object.fromEntries((def.parameters || []).map((p) => [p.name, { type: p.type }])),
      functions: this.template.functions,
    };
    const child = new TemplateContext(fnTemplate, bound, this.scope, { ...this.opts, path: `${this.path}>${name}` });
    return child.deep(def.output.value);
  }

  call(node) {
    const name = node.name;
    const lname = name.toLowerCase();
    // Lazy / special forms first.
    if (lname === "if") {
      const cond = this.evalNode(node.args[0]);
      if (isUnknown(cond)) return this.unknown(`if(${cond.text}, ...)`);
      return this.evalNode(node.args[cond ? 1 : 2]);
    }
    if (lname === "lambda") {
      const names = node.args.slice(0, -1).map((x) => this.evalNode(x));
      return { __lambda: true, names, body: node.args[node.args.length - 1] };
    }
    if (lname === "lambdavariables") {
      const nm = this.evalNode(node.args[0]);
      for (let n = this.lambdaStack.length - 1; n >= 0; n--) {
        if (Object.prototype.hasOwnProperty.call(this.lambdaStack[n], nm)) return this.lambdaStack[n][nm];
      }
      throw new EvalError(`lambda variable ${nm} not bound`);
    }
    if (this.functions.has(name)) return this.callUserFunction(name, node.args.map((x) => this.evalNode(x)));

    const a = node.args.map((x) => this.evalNode(x));
    const applyLambda = (fn, ...vals) => {
      const frame = {};
      fn.names.forEach((nm, n) => {
        frame[nm] = vals[n];
      });
      this.lambdaStack.push(frame);
      try {
        return this.evalNode(fn.body);
      } finally {
        this.lambdaStack.pop();
      }
    };
    const sym = () => this.unknown(`${name}(${a.map(repr).join(", ")})`);

    switch (lname) {
      case "parameters":
        return this.param(a[0]);
      case "variables":
        return this.variable(a[0]);
      case "fail":
        throw new GuardFailure(armString(a[0]), this.path);
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "json":
        return isUnknown(a[0]) ? sym() : JSON.parse(a[0]);
      case "string":
        return armString(a[0]);
      case "int":
        return isUnknown(a[0]) ? sym() : parseInt(a[0], 10);
      case "bool":
        return isUnknown(a[0]) ? sym() : typeof a[0] === "string" ? a[0].toLowerCase() === "true" : Boolean(a[0]);
      case "createarray":
        return a;
      case "createobject": {
        const o = {};
        for (let n = 0; n < a.length; n += 2) o[armString(a[n])] = a[n + 1];
        return o;
      }
      case "concat":
        if (a.length && Array.isArray(a[0])) return a.flatMap((x) => (Array.isArray(x) ? x : [x]));
        return a.map(armString).join("");
      case "format":
        return armString(a[0]).replace(/\{(\d+)(:[^}]*)?\}/g, (_, n) => armString(a[Number(n) + 1]));
      case "equals":
        if (anyUnknown(a)) return repr(a[0]) === repr(a[1]) ? true : sym();
        return deepEqual(a[0], a[1]);
      case "not":
        return isUnknown(a[0]) ? sym() : !a[0];
      case "and":
        if (a.some((x) => x === false)) return false;
        return anyUnknown(a) ? sym() : a.every(Boolean);
      case "or":
        if (a.some((x) => x === true)) return true;
        return anyUnknown(a) ? sym() : a.some(Boolean);
      case "greater":
        return anyUnknown(a) ? sym() : a[0] > a[1];
      case "greaterorequals":
        return anyUnknown(a) ? sym() : a[0] >= a[1];
      case "less":
        return anyUnknown(a) ? sym() : a[0] < a[1];
      case "lessorequals":
        return anyUnknown(a) ? sym() : a[0] <= a[1];
      case "add":
        return anyUnknown(a) ? sym() : a[0] + a[1];
      case "sub":
        return anyUnknown(a) ? sym() : a[0] - a[1];
      case "mul":
        return anyUnknown(a) ? sym() : a[0] * a[1];
      case "div":
        return anyUnknown(a) ? sym() : Math.trunc(a[0] / a[1]);
      case "mod":
        return anyUnknown(a) ? sym() : a[0] % a[1];
      case "min":
        return anyUnknown(a) ? sym() : Math.min(...a.flat());
      case "max":
        return anyUnknown(a) ? sym() : Math.max(...a.flat());
      case "range":
        return Array.from({ length: a[1] }, (_, n) => a[0] + n);
      case "empty":
        if (isUnknown(a[0])) return sym();
        if (a[0] === null || a[0] === undefined) return true;
        if (typeof a[0] === "string" || Array.isArray(a[0])) return a[0].length === 0;
        if (typeof a[0] === "object") return Object.keys(a[0]).length === 0;
        return false;
      case "length":
        if (isUnknown(a[0])) return sym();
        return typeof a[0] === "object" && !Array.isArray(a[0]) ? Object.keys(a[0]).length : a[0].length;
      case "tolower":
        return isUnknown(a[0]) ? this.unknown(`toLower(${a[0].text})`) : armString(a[0]).toLowerCase();
      case "toupper":
        return isUnknown(a[0]) ? sym() : armString(a[0]).toUpperCase();
      case "trim":
        return isUnknown(a[0]) ? sym() : armString(a[0]).trim();
      case "take":
        return isUnknown(a[0]) ? sym() : a[0].slice(0, Math.max(0, a[1]));
      case "skip":
        return isUnknown(a[0]) ? sym() : a[0].slice(Math.max(0, a[1]));
      case "first":
        return isUnknown(a[0]) ? sym() : a[0][0];
      case "last":
        return isUnknown(a[0]) ? sym() : a[0][a[0].length - 1];
      case "split": {
        if (anyUnknown(a)) return sym();
        const delims = Array.isArray(a[1]) ? a[1] : [a[1]];
        let parts = [a[0]];
        for (const d of delims) parts = parts.flatMap((p) => p.split(d));
        return parts;
      }
      case "join":
        return isUnknown(a[0]) ? sym() : a[0].map(armString).join(armString(a[1]));
      case "replace":
        return anyUnknown(a) ? sym() : armString(a[0]).split(armString(a[1])).join(armString(a[2]));
      case "substring":
        return isUnknown(a[0]) ? sym() : a[0].substr(a[1], a[2] === undefined ? undefined : a[2]);
      case "indexof":
        return anyUnknown(a) ? sym() : a[0].toLowerCase().indexOf(a[1].toLowerCase());
      case "lastindexof":
        return anyUnknown(a) ? sym() : a[0].toLowerCase().lastIndexOf(a[1].toLowerCase());
      case "startswith":
        return anyUnknown(a) ? sym() : a[0].toLowerCase().startsWith(a[1].toLowerCase());
      case "endswith":
        return anyUnknown(a) ? sym() : a[0].toLowerCase().endsWith(a[1].toLowerCase());
      case "contains":
        if (isUnknown(a[0])) return sym();
        if (typeof a[0] === "string") return isUnknown(a[1]) ? sym() : a[0].toLowerCase().includes(armString(a[1]).toLowerCase());
        if (Array.isArray(a[0])) {
          if (a[0].some((x) => repr(x) === repr(a[1]))) return true;
          return anyUnknown(a[0]) || isUnknown(a[1]) ? sym() : false;
        }
        return Object.keys(a[0]).some((k) => k.toLowerCase() === armString(a[1]).toLowerCase());
      case "union": {
        if (anyUnknown(a)) return sym();
        if (Array.isArray(a[0])) {
          const out = [];
          for (const arr of a) for (const x of arr) if (!out.some((y) => deepEqual(x, y))) out.push(x);
          return out;
        }
        return Object.assign({}, ...a);
      }
      case "intersection":
        if (anyUnknown(a)) return sym();
        return a[0].filter((x) => a.slice(1).every((arr) => arr.some((y) => deepEqual(x, y))));
      case "coalesce":
        for (const x of a) if (x !== null && x !== undefined) return x;
        return null;
      case "tryget": {
        let cur = a[0];
        for (const key of a.slice(1)) {
          if (cur === null || cur === undefined) return null;
          if (isUnknown(cur)) return this.getProp(cur, key);
          if (Array.isArray(cur)) cur = cur[key];
          else {
            const k2 = Object.keys(cur).find((k) => k.toLowerCase() === String(key).toLowerCase());
            cur = k2 === undefined ? null : cur[k2];
          }
        }
        return cur === undefined ? null : cur;
      }
      case "objectkeys":
        return isUnknown(a[0]) ? sym() : Object.keys(a[0]);
      case "items":
        return isUnknown(a[0]) ? sym() : Object.entries(a[0]).map(([key, value]) => ({ key, value }));
      case "map":
        return isUnknown(a[0]) ? sym() : a[0].map((x, n) => applyLambda(a[1], x, n));
      case "filter":
        return isUnknown(a[0]) ? sym() : a[0].filter((x, n) => applyLambda(a[1], x, n));
      case "reduce":
        return isUnknown(a[0]) ? sym() : a[0].reduce((acc, x, n) => applyLambda(a[2], acc, x, n), a[1]);
      case "base64":
        return isUnknown(a[0]) ? sym() : Buffer.from(armString(a[0]), "utf8").toString("base64");
      case "base64tostring":
        return isUnknown(a[0]) ? sym() : Buffer.from(armString(a[0]), "base64").toString("utf8");
      case "copyindex": {
        const nm = typeof a[0] === "string" ? a[0] : undefined;
        const offset = typeof a[0] === "number" ? a[0] : a[1] || 0;
        const frame = nm ? [...this.copyStack].reverse().find((f) => f.name === nm) : this.copyStack[this.copyStack.length - 1];
        if (!frame) throw new EvalError(`${this.path}: copyIndex outside a loop`);
        return frame.index + offset;
      }
      case "uniquestring":
        return hashText(a, 13);
      case "utcnow": {
        // Deterministic stand-in for the deployment time (scope.utcNow).
        const d = new Date(this.scope.utcNow || "2026-09-28T12:00:00Z");
        const pad = (n) => String(n).padStart(2, "0");
        const fmt = a.length ? armString(a[0]) : "yyyyMMddTHHmmssZ";
        return fmt
          .replace(/yyyy/g, String(d.getUTCFullYear()))
          .replace(/MM/g, pad(d.getUTCMonth() + 1))
          .replace(/dd/g, pad(d.getUTCDate()))
          .replace(/HH/g, pad(d.getUTCHours()))
          .replace(/mm/g, pad(d.getUTCMinutes()))
          .replace(/ss/g, pad(d.getUTCSeconds()));
      }
      case "guid": {
        const text = a.map(armString).join(",");
        const h = createHash("sha1").update(text).digest("hex");
        const g = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
        guidInputs.set(g, a.map(armString));
        return g;
      }
      case "resourcegroup":
        return {
          id: this.rgId(),
          name: this.rgName(),
          location: (this.scope.rgLocations && this.scope.rgLocations[this.rgName()]) || `location(${this.rgName()})`,
          type: "Microsoft.Resources/resourceGroups",
          properties: {},
        };
      case "subscription":
        return {
          id: `/subscriptions/${this.subId()}`,
          subscriptionId: this.subId(),
          tenantId: this.scope.tenantId,
          displayName: `subscription(${this.subId()})`,
        };
      case "tenant":
        return { tenantId: this.scope.tenantId, id: `/tenants/${this.scope.tenantId}` };
      case "deployment":
        return { name: this.scope.deploymentName, location: this.scope.location, properties: {} };
      case "environment":
        return {
          name: "AzureCloud",
          suffixes: { acrLoginServer: ".azurecr.io", storage: "core.windows.net", keyvaultDns: ".vault.azure.net" },
          authentication: { loginEndpoint: "https://login.microsoftonline.com/" },
        };
      case "resourceid": {
        if (anyUnknown(a)) return sym();
        const t = a.findIndex(looksLikeType);
        const pre = a.slice(0, t);
        const sub = pre.length === 2 ? pre[0] : this.subId();
        const rg = pre.length >= 1 ? pre[pre.length - 1] : this.rgName();
        return `/subscriptions/${sub}/resourceGroups/${rg}/providers/${interleave(a[t], a.slice(t + 1))}`;
      }
      case "subscriptionresourceid": {
        if (anyUnknown(a)) return sym();
        const t = a.findIndex(looksLikeType);
        const sub = t === 1 ? a[0] : this.subId();
        return `/subscriptions/${sub}/providers/${interleave(a[t], a.slice(t + 1))}`;
      }
      case "tenantresourceid":
        return `/providers/${interleave(a[0], a.slice(1))}`;
      case "extensionresourceid":
        return `${armString(a[0])}/providers/${interleave(a[1], a.slice(2))}`;
      case "resourceinfo": {
        const s = this.resolveResourceRef(a[0]);
        return { id: s.id, name: s.name, type: s.type, apiVersion: s.apiVersion };
      }
      case "reference": {
        const s = this.resolveResourceRef(a[0]);
        if (s.isModule) return this.moduleOutputObject(s);
        const full = typeof a[2] === "string" && a[2].toLowerCase() === "full";
        return this.unknown(`${full ? "refFull" : "ref"}(${String(s.id).toLowerCase()})`);
      }
      default:
        if (lname.startsWith("list")) {
          const s = this.resolveResourceRef(a[0]);
          return this.unknown(`${name}(${String(s.id).toLowerCase()})`);
        }
        return sym();
    }
  }
}

// ---------------------------------------------------------------------------
// Template walker -> resource inventory
// ---------------------------------------------------------------------------

function resourceEntries(template) {
  const r = template.resources || [];
  return Array.isArray(r) ? r.map((def, n) => [`#${n}`, def]) : Object.entries(r);
}

function absoluteScope(ctx, scopeValue) {
  const s = armString(scopeValue);
  if (s.startsWith("/")) return s;
  return `${ctx.rgId()}/providers/${s}`;
}

function resourceIdFor(ctx, def, name, override) {
  const type = def.type;
  const names = armString(name).split("/");
  if (def.scope !== undefined) {
    return `${absoluteScope(ctx, ctx.deep(def.scope))}/providers/${interleave(type, names)}`;
  }
  const sub = override?.subscriptionId ?? ctx.subId();
  const rg = override?.resourceGroup ?? ctx.rgName();
  if (type.toLowerCase() === "microsoft.resources/resourcegroups") return `/subscriptions/${sub}/resourceGroups/${names[0]}`;
  if (!rg) return `/subscriptions/${sub}/providers/${interleave(type, names)}`;
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/${interleave(type, names)}`;
}

function scopeOverride(ctx, def) {
  const o = {};
  if (def.subscriptionId !== undefined) o.subscriptionId = ctx.deep(def.subscriptionId);
  if (def.resourceGroup !== undefined) o.resourceGroup = ctx.deep(def.resourceGroup);
  return o;
}

export class DeploymentEvaluation {
  constructor(template, paramValues, scope, opts = {}) {
    this.inventory = opts.inventory || [];
    this.ctx = new TemplateContext(template, paramValues, scope, { ...opts, path: opts.path || "main" });
    this.template = template;
    this.registerSymbols();
  }

  registerSymbols() {
    const ctx = this.ctx;
    for (const [symbol, def] of resourceEntries(this.template)) {
      const entry = {
        symbol,
        def,
        type: def.type,
        apiVersion: def.apiVersion,
        isModule: def.type === "Microsoft.Resources/deployments" && !!def.properties?.template,
        idKnown: false,
      };
      let cached;
      Object.defineProperty(entry, "id", {
        enumerable: true,
        get() {
          if (cached === undefined) {
            const name = ctx.deep(def.name);
            cached = resourceIdFor(ctx, def, name, scopeOverride(ctx, def));
            entry.name = armString(name);
            entry.idKnown = true;
          }
          return cached;
        },
      });
      ctx.symbols.set(symbol, entry);
    }
  }

  run() {
    const ctx = this.ctx;
    // Optional worst-case model: evaluate EVERY variable up front, as if ARM were
    // eager, to prove no guard fires for a valid fixture under either model.
    if (ctx.opts.eagerVariables) {
      for (const k of Object.keys(this.template.variables || {})) if (k !== "copy") ctx.variable(k);
      for (const loop of this.template.variables?.copy || []) ctx.variable(loop.name);
    }
    for (const [symbol, def] of resourceEntries(this.template)) {
      const entry = ctx.symbols.get(symbol);
      if (def.existing) continue;
      const cond = def.condition === undefined ? true : ctx.deep(def.condition);
      if (cond === false) continue;
      const count = def.copy ? ctx.deep(def.copy.count) : null;
      const iterations = count === null ? [null] : Array.from({ length: count }, (_, n) => n);
      for (const n of iterations) {
        if (n !== null) ctx.copyStack.push({ name: def.copy.name, index: n });
        try {
          if (entry.isModule) this.runModule(entry, def, cond);
          else this.record(entry, def, cond, n);
        } finally {
          if (n !== null) ctx.copyStack.pop();
        }
      }
    }
    return this;
  }

  record(entry, def, cond, n) {
    const ctx = this.ctx;
    const name = armString(ctx.deep(def.name));
    const id = resourceIdFor(ctx, def, name, scopeOverride(ctx, def));
    const rec = {
      id,
      type: def.type,
      apiVersion: def.apiVersion,
      name,
      deployedBy: ctx.path + (n === null ? "" : `[${n}]`),
      symbol: entry.symbol,
      conditionUnknown: isUnknown(cond),
    };
    for (const field of ["location", "kind", "sku", "identity", "tags", "properties"]) {
      if (def[field] !== undefined) rec[field] = ctx.deep(def[field]);
    }
    // Extensible (Microsoft Graph) resources carry their body at the top level.
    if (def.import) {
      const skip = new Set(["type", "import", "dependsOn", "condition", "copy", "existing", "name"]);
      rec.body = ctx.deep(Object.fromEntries(Object.entries(def).filter(([k]) => !skip.has(k))));
    }
    this.inventory.push(rec);
  }

  runModule(entry, def, cond) {
    const ctx = this.ctx;
    const name = armString(ctx.deep(def.name));
    const childScope = { ...ctx.scope, deploymentName: name };
    const o = scopeOverride(ctx, def);
    if (o.subscriptionId !== undefined) childScope.subscriptionId = o.subscriptionId;
    if (o.resourceGroup !== undefined) childScope.resourceGroup = o.resourceGroup;
    const childParams = {};
    for (const [k, v] of Object.entries(def.properties.parameters || {})) {
      // Bicep may compile a whole parameter entry to one expression, e.g.
      // "[if(cond, createObject('value', x), createObject('value', fail(...)))]".
      const entryValue = typeof v === "string" ? ctx.deep(v) : v;
      childParams[k] = typeof v === "string" ? entryValue.value : ctx.deep(v.value);
    }
    const child = new DeploymentEvaluation(def.properties.template, childParams, childScope, {
      ...ctx.opts,
      path: `${ctx.path}/${entry.symbol}`,
      inventory: this.inventory,
      secureValues: ctx.secureValues,
    });
    entry.child = child;
    child.run();
    this.inventory.push({
      id: entry.id,
      type: def.type,
      name,
      deployedBy: ctx.path,
      symbol: entry.symbol,
      module: true,
      targetScope: { subscriptionId: childScope.subscriptionId, resourceGroup: childScope.resourceGroup ?? null },
      conditionUnknown: isUnknown(cond),
    });
  }

  outputs() {
    const out = {};
    for (const [k, def] of Object.entries(this.template.outputs || {})) out[k] = this.ctx.deep(def.value);
    return out;
  }
}

/** Evaluate a compiled template. Returns { inventory, outputs, secureValues }. */
export function evaluateTemplate(template, paramValues, scope, opts = {}) {
  const ev = new DeploymentEvaluation(template, paramValues, scope, opts).run();
  return { inventory: ev.inventory, outputs: ev.outputs(), secureValues: ev.ctx.secureValues };
}

/** Load parameter values from an ARM deploymentParameters JSON object. */
export function parameterValues(parametersJson) {
  const out = {};
  for (const [k, v] of Object.entries(parametersJson.parameters || {})) out[k] = v.value;
  return out;
}

/** Replace every occurrence of a secure value in a JSON-able structure. */
export function redact(value, secureValues) {
  let text = JSON.stringify(canonical(value));
  for (const s of secureValues) if (s) text = text.split(JSON.stringify(s).slice(1, -1)).join("<secure-value-redacted>");
  return JSON.parse(text);
}

/** Default synthetic scope for local evaluation (documentation-only ids). */
export function defaultScope(overrides = {}) {
  return {
    tenantId: "22222222-2222-2222-2222-222222222222",
    subscriptionId: "33333333-3333-3333-3333-333333333333",
    resourceGroup: "rg-squadmcp-fixture",
    location: "eastus",
    deploymentName: "main",
    utcNow: "2026-09-28T12:00:00Z",
    rgLocations: { "rg-squadmcp-fixture": "eastus" },
    ...overrides,
  };
}
