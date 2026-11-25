import { isIP } from "node:net";

const blockedNames = new Set(["localhost", "metadata", "metadata.google.internal", "metadata.azure.com", "instance-data"]);
const blockedSuffixes = [".localhost", ".local", ".internal", ".home.arpa"];

function blockedIpv4(address) {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function numericIpv4Spelling(host) {
  return host.split(".").length <= 4 && host.split(".").every((part) => /^(0x[0-9a-f]+|\d+)$/i.test(part));
}

export function isNonPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) return blockedIpv4(host);
  if (family === 6) {
    if (host === "::" || host === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return blockedIpv4(mapped[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return blockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return /^(fc|fd|fe[89ab]|ff)/.test(host);
  }
  return host.length === 0 || numericIpv4Spelling(host) || blockedNames.has(host) ||
    !host.includes(".") || blockedSuffixes.some((suffix) => host.endsWith(suffix));
}

export function validateBrowserUrl(raw, allowedHosts = [], { websocket = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "not an absolute URL" };
  }
  const protocols = websocket ? ["wss:"] : ["https:"];
  if (!protocols.includes(url.protocol)) return { allowed: false, reason: "only secure public web URLs are permitted" };
  if (url.username || url.password) return { allowed: false, reason: "credentials in URLs are not permitted" };
  if (url.port && url.port !== "443") return { allowed: false, reason: "non-default ports are not permitted" };
  if (isNonPublicHost(url.hostname)) return { allowed: false, reason: `host ${url.hostname} is not a public destination` };
  if (allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    if (!allowedHosts.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
      return { allowed: false, reason: `host ${url.hostname} is not in the operator allow-list` };
    }
  }
  return { allowed: true, url };
}

export function validateWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be a JSON object.");
  const { url, steps = [] } = value;
  if (typeof url !== "string") throw new Error("A starting https URL is required.");
  if (!Array.isArray(steps) || steps.length > 12) throw new Error("steps must be an array of at most 12 actions.");
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step) || typeof step.action !== "string") {
      throw new Error(`steps[${index}] must be an action object.`);
    }
    switch (step.action) {
      case "click":
        if (!locatorProvided(step)) throw new Error(`steps[${index}] click needs role+name, label, or text.`);
        break;
      case "fill":
        if (!locatorProvided(step) || typeof step.value !== "string" || step.value.length > 1000) {
          throw new Error(`steps[${index}] fill needs a locator and a value of at most 1000 characters.`);
        }
        break;
      case "press":
        if (!["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape", "Space"].includes(step.key)) {
          throw new Error(`steps[${index}] press key is not allowed.`);
        }
        break;
      case "scroll":
        if (!Number.isInteger(step.deltaY) || Math.abs(step.deltaY) > 1500) {
          throw new Error(`steps[${index}] scroll deltaY must be an integer between -1500 and 1500.`);
        }
        break;
      case "wait":
        if (!Number.isInteger(step.ms) || step.ms < 0 || step.ms > 3000) {
          throw new Error(`steps[${index}] wait must be between 0 and 3000 milliseconds.`);
        }
        break;
      case "navigate":
        if (typeof step.url !== "string") throw new Error(`steps[${index}] navigate needs a URL.`);
        break;
      default:
        throw new Error(`steps[${index}] action is unsupported.`);
    }
  }
  return { ...value, steps };
}

function locatorProvided(step) {
  return (typeof step.role === "string" && typeof step.name === "string") ||
    typeof step.label === "string" || typeof step.text === "string";
}
