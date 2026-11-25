// Dependency-free receipt/byte verifier. It does NOT verify consent, Graph rights,
// review approval, server status or the truth of test claims. Never executes code.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const schema = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../references/implementation-receipt.schema.json'), 'utf8'));

// Implements only the JSON Schema vocabulary used by this pinned companion.
// Unknown keywords fail closed; tests compare it with the repository's Ajv.
function inspect(rule, value, at = '$') {
  const known = new Set(['$schema', 'title', 'definitions', '$ref', 'type', 'additionalProperties', 'required', 'properties', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'minItems', 'maxItems', 'items', 'uniqueItems', 'allOf', 'if', 'then']);
  for (const key of Object.keys(rule)) if (!known.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (rule.$ref) {
    if (!rule.$ref.startsWith('#/definitions/')) throw new Error('Only local definition references are supported');
    return inspect(schema.definitions[rule.$ref.slice(14)], value, at);
  }
  const errors = [];
  const fail = why => errors.push(`${at}: ${why}`);
  if ('const' in rule && JSON.stringify(value) !== JSON.stringify(rule.const)) fail('const mismatch');
  if (rule.enum && !rule.enum.includes(value)) fail('not in enum');
  if (rule.type) {
    const ok = rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : rule.type === 'array' ? Array.isArray(value)
      : rule.type === 'integer' ? Number.isSafeInteger(value)
      : typeof value === rule.type;
    if (!ok) { fail(`expected ${rule.type}`); return errors; }
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && [...value].length < rule.minLength) fail('too short');
    if (rule.maxLength !== undefined && [...value].length > rule.maxLength) fail('too long');
    if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) fail('pattern mismatch');
  }
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) fail('below minimum');
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) fail('too few items');
    if (rule.maxItems !== undefined && value.length > rule.maxItems) fail('too many items');
    if (rule.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) fail('duplicate items');
    if (rule.items) value.forEach((v, i) => errors.push(...inspect(rule.items, v, `${at}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (rule.properties && Object.hasOwn(rule.properties, key)) errors.push(...inspect(rule.properties[key], v, `${at}.${key}`));
      else if (rule.additionalProperties === false) fail(`unexpected ${key}`);
    }
  }
  for (const child of rule.allOf ?? []) errors.push(...inspect(child, value, at));
  if (rule.if && inspect(rule.if, value, at).length === 0 && rule.then) errors.push(...inspect(rule.then, value, at));
  return errors;
}

export function validateReceipt(receipt) {
  const errors = inspect(schema, receipt);
  if (errors.length) return errors;
  const seen = new Set();
  for (const file of [...receipt.inputs, ...receipt.outputs]) {
    const parts = file.path.split('/');
    const canonical = file.path.normalize('NFC').toLowerCase();
    if (seen.has(canonical)) errors.push(`Duplicate/colliding path: ${file.path}`);
    seen.add(canonical);
    if (parts.some(p => /[. ]$/.test(p) || /[\x00-\x1f\x7f<>"|*?]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) errors.push(`Unsafe path: ${file.path}`);
  }
  for (const output of receipt.outputs) if (/^implementation\/receipts\//i.test(output.path)) errors.push('Receipts cannot include themselves as outputs');
  for (const input of receipt.inputs) if (/^implementation\//i.test(input.path)) errors.push('Implementation evidence is not an HVE specification input');
  for (const evidence of receipt.authorization.approvedInputEvidence) if (!receipt.inputs.some(i => i.path === evidence)) errors.push('Approval evidence must be a versioned input');
  if (receipt.capabilities.codeExecution === 'unavailable' && receipt.tests.some(t => t.status === 'pass' && t.environment !== 'static-inspection')) errors.push('No execution capability for claimed execution pass');
  for (const date of [receipt.createdAt, receipt.authorization.recordedAt]) if (!Number.isFinite(Date.parse(date))) errors.push('Invalid timestamp');
  return errors;
}

export function verifyReceipt(receipt, projectRoot) {
  const errors = validateReceipt(receipt);
  if (errors.length) return { valid: false, errors };
  try {
    const root = realpathSync(projectRoot);
    const contained = path => {
      const target = realpathSync(resolve(root, ...path.split('/')));
      const rel = relative(root, target);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Path escapes selected project: ${path}`);
      return target;
    };
    const manifest = JSON.parse(readFileSync(contained('hve-project.json'), 'utf8'));
    if (manifest.schemaVersion !== 2 || manifest.projectId?.toLowerCase() !== receipt.projectId.toLowerCase() || ['provider', 'driveId', 'folderItemId'].some(k => manifest.storage?.[k] !== receipt.storage[k])) throw new Error('Project/storage binding mismatch');
    for (const file of [...receipt.inputs, ...receipt.outputs]) {
      const bytes = readFileSync(contained(file.path));
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) errors.push(`Byte/hash mismatch: ${file.path}`);
    }
  } catch (error) { errors.push(error.message); }
  return { valid: errors.length === 0, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node verify-receipt.mjs receipt.json bound-project-root');
    const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const result = verifyReceipt(receipt, process.argv[3]);
    console.log(JSON.stringify({ ...result, verifies: 'schema, project binding and staged bytes only; not consent, approval, Graph metadata or test truth' }, null, 2));
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
