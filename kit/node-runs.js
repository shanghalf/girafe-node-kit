// display "runs" (host API 2): for a plugin that declares it, the host keeps what the node sent or
// returned over its last runs (newest first), so its panel can show the latest run and the earlier
// ones - GIRAFE's Result stack, as a plugin. Kept in workspace/.kit/node-runs.json, per canvas node.
// Only file references and text are kept, never file contents.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(store.ROOT, '.kit', 'node-runs.json');
const MAX_RUNS = 10;
const MAX_VALUES = 60;
const MAX_CHARS = 40000;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }

function record(nodeId, values) {
  if (!NODE_ID_RE.test(String(nodeId)) || !values.length) return;
  const all = readAll();
  const run = { at: new Date().toISOString(), values: values.slice(0, MAX_VALUES).map((v) => (typeof v === 'string' ? v.slice(0, MAX_CHARS) : v)) };
  all[nodeId] = [run, ...(all[nodeId] || [])].slice(0, MAX_RUNS);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(all));
  fs.renameSync(FILE + '.tmp', FILE);
}

function list(nodeId) { return NODE_ID_RE.test(String(nodeId)) ? readAll()[nodeId] || [] : []; }

function clear(nodeId) {
  const all = readAll();
  if (!all[nodeId]) return;
  delete all[nodeId];
  fs.writeFileSync(FILE, JSON.stringify(all));
}

module.exports = { record, list, clear, MAX_RUNS };
