// Billing: what a node's service costs, declared with the package (see HOST_API.md "Billing").
// "billing": [{ service, unit, units?, usdPerUnit, balance?, history?, csv? }] in a node manifest
// (host API 2) or a pack.json, one entry per key service the node pays with. The node reports what a
// run spent with ctx.usage({ service, units, taskId?, type?, label?, model?, failed? }); GIRAFE
// prices it (the user may set their own price) and files it in AI reports and Settings › Usage.
// "balance" and "history" are GET calls GIRAFE makes with the user's key, only to the service's own
// hosts; "csv" maps the columns of the history file the service exports.
// Same rules as GIRAFE (server/plugins/manifest.js checkBilling) - keep the two in step.
const { OFFICIAL } = require('./netguard');
const KEY_SERVICES = ['anthropic', 'openai', 'gemini', 'tripo'];
const KEY_HOSTS = Object.fromEntries(KEY_SERVICES.map((s) => [s, OFFICIAL[s] || []]));

const BILL_PATH_RE = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,5}$/;
const BILL_FIELDS = ['taskId', 'units', 'type', 'model', 'status', 'createdAt', 'completedAt'];
function billingUrlProblem(url, service, what) {
  let u; try { u = new URL(String(url).replace(/\{(start|end|page)\}/g, '0')); } catch { return `${what}: "url" is not a valid address`; }
  if (u.protocol !== 'https:') return `${what}: "url" must be https`;
  if (!(KEY_HOSTS[service] || []).includes(u.hostname)) return `${what}: "url" must go to ${(KEY_HOSTS[service] || []).join(' or ')} (the key is sent there)`;
  if (/\{(?!start\}|end\}|page\})/.test(String(url))) return `${what}: "url" may only use {start}, {end} and {page}`;
  return null;
}
function checkBilling(list, services, where) {
  const problems = [];
  if (list === undefined) return problems;
  if (!Array.isArray(list) || list.length > 8) return [`${where}"billing": a list of { service, unit, usdPerUnit, ... }`];
  const seen = new Set();
  for (const b of list) {
    const s = b && b.service;
    const name = `${where}billing "${s}"`;
    if (!b || typeof b !== 'object') { problems.push(`${where}"billing": each entry is an object`); continue; }
    if (!KEY_SERVICES.includes(s)) { problems.push(`${name}: unknown service`); continue; }
    if (!services.includes(s)) problems.push(`${name}: no key slot uses this service`);
    if (seen.has(s)) problems.push(`${name}: listed twice`);
    seen.add(s);
    if (typeof b.unit !== 'string' || !/^[\p{L} ]{1,20}$/u.test(b.unit)) problems.push(`${name}: "unit" is a short word, like "credit"`);
    if (b.units !== undefined && (typeof b.units !== 'string' || !/^[\p{L} ]{1,20}$/u.test(b.units))) problems.push(`${name}: "units" is the plural, like "credits"`);
    if (typeof b.usdPerUnit !== 'number' || !(b.usdPerUnit >= 0) || b.usdPerUnit > 1000) problems.push(`${name}: "usdPerUnit" is a number of dollars (0 to 1000)`);
    if (b.balance !== undefined) {
      const x = b.balance;
      const p = x && billingUrlProblem(x.url, s, `${name} balance`);
      if (!x || typeof x !== 'object' || p) problems.push(p || `${name}: "balance" is { url, left, held? }`);
      else if (!BILL_PATH_RE.test(x.left || '') || (x.held !== undefined && !BILL_PATH_RE.test(x.held))) problems.push(`${name} balance: "left" / "held" are dot paths like "data.balance"`);
    }
    if (b.history !== undefined) {
      const x = b.history;
      const p = x && billingUrlProblem(x.url, s, `${name} history`);
      if (!x || typeof x !== 'object' || p) problems.push(p || `${name}: "history" is { url, items, fields, ok?, maxDays? }`);
      else if (!BILL_PATH_RE.test(x.items || '')) problems.push(`${name} history: "items" is a dot path like "data.items"`);
      else if (!x.fields || typeof x.fields !== 'object' || !BILL_PATH_RE.test(x.fields.taskId || '') || !BILL_PATH_RE.test(x.fields.units || '')) problems.push(`${name} history: "fields" needs at least "taskId" and "units"`);
      else if (Object.entries(x.fields).some(([k, v]) => !BILL_FIELDS.includes(k) || !BILL_PATH_RE.test(String(v)))) problems.push(`${name} history: "fields" keys are ${BILL_FIELDS.join(', ')}, values dot paths`);
      else if (x.ok !== undefined && (!Array.isArray(x.ok) || x.ok.some((v) => typeof v !== 'string' || v.length > 30))) problems.push(`${name} history: "ok" is a list of status words`);
      else if (x.maxDays !== undefined && !(Number.isInteger(x.maxDays) && x.maxDays >= 1 && x.maxDays <= 366)) problems.push(`${name} history: "maxDays" is 1 to 366`);
    }
    if (b.csv !== undefined) {
      const x = b.csv;
      if (!x || typeof x !== 'object' || typeof x.taskId !== 'string' || typeof x.units !== 'string') problems.push(`${name}: "csv" maps at least "taskId" and "units" to column names`);
      else if (Object.entries(x).some(([k, v]) => !BILL_FIELDS.includes(k) || typeof v !== 'string' || !v || v.length > 60)) problems.push(`${name} csv: keys are ${BILL_FIELDS.join(', ')}, values column names`);
    }
  }
  return problems;
}


// The billing a node runs under: its pack's entries, then its own for services the pack doesn't describe.
function billingFor(manifestBilling, packBilling) {
  const out = [...(packBilling || [])];
  for (const b of manifestBilling || []) if (!out.some((x) => x.service === b.service)) out.push(b);
  return out;
}

module.exports = { checkBilling, billingFor };
