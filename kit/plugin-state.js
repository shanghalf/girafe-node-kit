// ctx.state (host API 2): a small JSON object a plugin keeps per node, across runs and restarts
// (a task it is waiting on, results it can reuse). Kept in workspace/.kit/plugin-state.json,
// one entry per plugin and canvas node. Written at once on every set, so a Stop or a crash
// right after doesn't lose it. GIRAFE keeps the same object on the node in the graph.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(store.ROOT, '.kit', 'plugin-state.json');
const MAX_BYTES = 256 * 1024;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
const keyOf = (pluginId, nodeId) => {
  if (!store.ID_RE.test(String(pluginId)) || !NODE_ID_RE.test(String(nodeId))) throw new Error('bad node id for ctx.state');
  return `${pluginId}/${nodeId}`;
};

function get(pluginId, nodeId) {
  const v = readAll()[keyOf(pluginId, nodeId)];
  return v && typeof v === 'object' ? v : {};
}

function set(pluginId, nodeId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ctx.state.set takes an object');
  const text = JSON.stringify(value);
  if (text.length > MAX_BYTES) throw new Error(`ctx.state is over ${MAX_BYTES / 1024} KB; keep file references, not file contents`);
  const all = readAll();
  all[keyOf(pluginId, nodeId)] = JSON.parse(text);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(all));
  fs.renameSync(FILE + '.tmp', FILE);
  return true;
}

module.exports = { get, set, MAX_BYTES };
