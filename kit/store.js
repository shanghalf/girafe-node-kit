// Everything the kit keeps lives in one folder: workspace/. No database.
//   workspace/nodes/<id>/        your plugin nodes (manifest.json + node.js)
//   workspace/graphs/<id>.json   your test graphs
//   workspace/.kit/files/        pictures added to Image nodes, files nodes produced
// Delete the folder and the kit has left nothing behind.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.GIRAFE_KIT_WORKSPACE || path.join(__dirname, '..', 'workspace'));
const NODES = path.join(ROOT, 'nodes');
const GRAPHS = path.join(ROOT, 'graphs');
const FILES = path.join(ROOT, '.kit', 'files');
for (const d of [NODES, GRAPHS, FILES]) fs.mkdirSync(d, { recursive: true });

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[a-f0-9]{16}\.(png|jpg|webp|gif|bin|txt|json|glb|fbx|obj|stl)$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'text/plain': 'txt', 'application/json': 'json', 'model/gltf-binary': 'glb', 'model/fbx': 'fbx', 'model/obj': 'obj', 'model/stl': 'stl' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

function listGraphs() {
  return fs.readdirSync(GRAPHS).filter((f) => f.endsWith('.json')).map((f) => {
    const id = f.slice(0, -5);
    try { const g = JSON.parse(fs.readFileSync(path.join(GRAPHS, f), 'utf8')); return { id, title: g.title || id, updatedAt: g.updatedAt }; }
    catch { return { id, title: id + ' (unreadable)' }; }
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function readGraph(id) {
  if (!ID_RE.test(id)) return null;
  const p = path.join(GRAPHS, id + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeGraph(id, g) {
  if (!ID_RE.test(id)) throw new Error('bad graph id');
  const clean = { title: String(g.title || 'Untitled').slice(0, 120), nodes: g.nodes || [], wires: g.wires || [], updatedAt: new Date().toISOString() };
  const p = path.join(GRAPHS, id + '.json');
  fs.writeFileSync(p + '.tmp', JSON.stringify(clean, null, 2));
  fs.renameSync(p + '.tmp', p);
  return clean;
}

function deleteGraph(id) {
  if (ID_RE.test(id)) fs.rmSync(path.join(GRAPHS, id + '.json'), { force: true });
}

function saveFile(buf, mime) {
  const ext = EXT[mime] || 'bin';
  const key = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  const p = path.join(FILES, key);
  if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
  return { key, mime: MIME[ext] || 'application/octet-stream', size: buf.length };
}

function filePath(key) {
  return FILE_RE.test(key) ? path.join(FILES, key) : null;
}

function mimeOf(key) {
  return MIME[key.split('.').pop()] || 'application/octet-stream';
}

module.exports = { ROOT, NODES, GRAPHS, FILES, ID_RE, listGraphs, readGraph, writeGraph, deleteGraph, saveFile, filePath, mimeOf };
