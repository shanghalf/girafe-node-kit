// Packs: nodes made for one use, managed and sent together (see HOST_API.md "Packs").
//
// A pack is a folder in workspace/nodes/<pack-id>/ holding only pack.json:
//   { "id": "tripo-pack", "name": "3D (Tripo)", "version": "0.1.0", "description": "...",
//     "nodes": ["tripo-3d", "tripo-rig"],
//     "keys": [{ "slot": "tripo", "service": "tripo", "label": "Tripo API key" }],
//     "billing": [{ "service": "tripo", "unit": "credit", "usdPerUnit": 0.01, ... }] }   (optional, see kit/billing.js)
// Its nodes stay ordinary node folders next to it. A node belongs to one pack at most.
// "keys" are the pack's key slots: one key chosen for the whole pack fills that slot in every
// member (workspace/.kit/pack-keys.json holds the key ids, never a key).
// GIRAFE installs a pack all at once, keeps its versions together, and turns it on/off as one.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PACK_FILE = 'pack.json';
const KEYS_FILE = path.join(store.ROOT, '.kit', 'pack-keys.json');
const MAX_NODES = 32;
const KEY_SERVICES = ['anthropic', 'openai', 'gemini', 'tripo'];

const isPackDir = (id) => fs.existsSync(path.join(store.NODES, id, PACK_FILE)) && !fs.existsSync(path.join(store.NODES, id, 'node.js'));
function readPack(id) { try { return JSON.parse(fs.readFileSync(path.join(store.NODES, id, PACK_FILE), 'utf8')); } catch (e) { return { __error: e.message }; } }
function packDirs() {
  return fs.readdirSync(store.NODES, { withFileTypes: true }).filter((d) => d.isDirectory() && store.ID_RE.test(d.name) && isPackDir(d.name)).map((d) => d.name).sort();
}

// The rules, same as GIRAFE's (server/plugins/manifest.js checkPack). `nodes` = { id: manifest|null }.
function checkPack(p, dirName, nodes, takenBy = {}) {
  const problems = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['pack.json is not a JSON object'];
  if (p.id !== dirName) problems.push(`"id" must be "${dirName}" (the folder name)`);
  if (!store.ID_RE.test(String(p.id || ''))) problems.push('"id": lowercase letters, digits and dashes only');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) problems.push('"name": the pack\'s title, 40 characters at most');
  if (!/^\d+\.\d+\.\d+$/.test(String(p.version || ''))) problems.push('"version" must look like 1.0.0');
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 300)) problems.push('"description": 300 characters at most');
  const list = Array.isArray(p.nodes) ? p.nodes : null;
  if (!list || !list.length || list.length > MAX_NODES) problems.push(`"nodes": a list of 1 to ${MAX_NODES} node ids`);
  else {
    if (new Set(list).size !== list.length) problems.push('"nodes": a node is listed twice');
    for (const id of list) {
      if (!store.ID_RE.test(String(id))) { problems.push(`"nodes": ${JSON.stringify(id)} is not a node id`); continue; }
      if (id === p.id) { problems.push('"nodes": the pack can\'t list itself'); continue; }
      if (!(id in nodes)) problems.push(`"nodes": no node "${id}" in workspace/nodes`);
      else if (!nodes[id]) problems.push(`"nodes": "${id}" has a broken manifest`);
      if (takenBy[id] && takenBy[id] !== p.id) problems.push(`"nodes": "${id}" is already in the pack "${takenBy[id]}"`);
    }
  }
  const keys = p.keys === undefined ? [] : p.keys;
  if (!Array.isArray(keys)) problems.push('"keys": a list like [{ "slot": "tripo", "service": "tripo", "label": "Tripo API key" }]');
  else {
    for (const k of keys) {
      if (!k || !/^[a-z][a-z0-9_]{0,23}$/.test(k.slot || '')) problems.push(`key slot ${JSON.stringify(k && k.slot)}: a short lowercase name`);
      else if (!KEY_SERVICES.includes(k.service)) problems.push(`key slot "${k.slot}": "service" must be one of ${KEY_SERVICES.join(', ')}`);
    }
    if (new Set(keys.map((k) => k && k.slot)).size !== keys.length) problems.push('"keys": a slot is listed twice');
    // Every key slot a member declares must be one of the pack's, with the same service.
    for (const id of list || []) {
      for (const s of (nodes[id] && nodes[id].capabilities && nodes[id].capabilities.keys) || []) {
        const pk = keys.find((k) => k && k.slot === s.slot);
        if (!pk) problems.push(`"keys": "${id}" uses the key slot "${s.slot}"; add it to the pack (one key for the whole pack)`);
        else if (pk.service !== s.service) problems.push(`"keys": slot "${s.slot}" is ${pk.service} in the pack but ${s.service} in "${id}"`);
      }
    }
    problems.push(...require('./billing').checkBilling(p.billing, keys.map((k) => k && k.service), 'pack '));
  }
  return problems;
}

// Which pack each node belongs to (from pack.json files, valid or not): { nodeId: packId }.
function membership() {
  const out = {};
  for (const id of packDirs()) for (const n of (Array.isArray(readPack(id).nodes) ? readPack(id).nodes : [])) if (store.ID_RE.test(String(n)) && !out[n]) out[n] = id;
  return out;
}

function listPacks() {
  const plugins = require('./plugins');
  const nodes = {};
  for (const pl of plugins.listPlugins()) nodes[pl.id] = pl.problems.some((x) => /^manifest\.json:/.test(x)) ? null : { capabilities: pl.capabilities, version: pl.version, hostApi: pl.hostApi, name: pl.name, problems: pl.problems };
  const taken = {};
  const out = [];
  for (const id of packDirs()) {
    const p = readPack(id);
    const problems = p.__error ? ['pack.json: ' + p.__error] : checkPack(p, id, nodes, taken);
    for (const n of Array.isArray(p.nodes) ? p.nodes : []) if (!taken[n]) taken[n] = id;
    for (const n of Array.isArray(p.nodes) ? p.nodes : []) if (nodes[n] && nodes[n].problems.length) problems.push(`"${n}" can't run: ${nodes[n].problems[0]}`);
    out.push({
      id, name: p.name || id, version: p.version || null, description: p.description || '',
      nodes: Array.isArray(p.nodes) ? p.nodes.filter((n) => typeof n === 'string') : [],
      keys: Array.isArray(p.keys) ? p.keys.filter((k) => k && k.slot) : [],
      keySlots: getKeys(id), problems,
    });
  }
  return out;
}
const getPack = (id) => listPacks().find((p) => p.id === id) || null;

// The pack's chosen keys: key ids only (keys.js decrypts them for one call, never here).
function readKeys() { try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) || {}; } catch { return {}; } }
function getKeys(packId) { const v = readKeys()[packId]; return v && typeof v === 'object' ? v : {}; }
function setKey(packId, slot, keyId) {
  if (!store.ID_RE.test(packId) || !/^[a-z][a-z0-9_]{0,23}$/.test(slot)) throw new Error('bad pack or slot');
  const all = readKeys();
  all[packId] = { ...(all[packId] || {}) };
  if (keyId) all[packId][slot] = String(keyId); else delete all[packId][slot];
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(all, null, 2));
  return all[packId];
}
// The key slots a node runs with: its pack's (one key for the whole pack), else its own.
function keySlotsFor(nodeId, own) {
  const packId = membership()[nodeId];
  return packId ? getKeys(packId) : own;
}

module.exports = { PACK_FILE, isPackDir, readPack, checkPack, listPacks, getPack, membership, getKeys, setKey, keySlotsFor, packDirs };
