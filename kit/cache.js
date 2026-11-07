// Answers and pictures already paid for: same request = no new call (like GIRAFE's caches).
// workspace/.kit/cache.json, newest 500 entries.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const FILE = path.join(store.ROOT, '.kit', 'cache.json');
const MAX = 500;
let mem = null;
const load = () => { if (!mem) { try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { mem = {}; } } return mem; };

const hash = (...parts) => crypto.createHash('sha256').update(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('␞')).digest('hex');
function get(key) { return load()[key] || null; }
function put(key, value) {
  const m = load();
  delete m[key]; m[key] = { ...value, at: Date.now() };
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete m[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(m));
}
module.exports = { hash, get, put };
