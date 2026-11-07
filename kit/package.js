// Packing a plugin node into one file: <id>-<version>.gnode (JSON, no dependencies).
//
//   { format: "girafe-node-package", formatVersion: 1,
//     id, version, hostApi, girafe, manifest,
//     files: { "<path>": { sha256, size, data (base64) } },
//     hash: sha256 of the canonical list "path sha256\n" (sorted),
//     author: { publicKey (Ed25519, base64 DER) }, signature (base64, over hash),
//     packedAt, kit }
//
// The author key pair is made on first pack (workspace/.kit/author-ed25519.pem, mode 600; only
// the public key ever leaves). GIRAFE checks the hash and the signature on upload and remembers
// the author key per node id: an update signed by another key is refused.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const plugins = require('./plugins');
const { KIT_VERSION } = require('./version');

const MAX_FILES = 64;
const MAX_BYTES = 10 * 1024 * 1024;
const OUT = path.join(store.ROOT, 'packages');
const AUTHOR = path.join(store.ROOT, '.kit', 'author-ed25519.pem');
const SKIP = /(^|\/)(\.|node_modules\/|.*\.g(node|pack)$)/;

function authorKey() {
  if (!fs.existsSync(AUTHOR)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(AUTHOR), { recursive: true });
    fs.writeFileSync(AUTHOR, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const priv = crypto.createPrivateKey(fs.readFileSync(AUTHOR));
  return { priv, pub: crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64') };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const canonical = (files) => Object.keys(files).sort().map((p) => `${p} ${files[p].sha256}\n`).join('');

function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(r)) continue;
      if (e.isSymbolicLink()) throw new Error(`${r} is a link; packages hold plain files only`);
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

function pack(id) {
  const plugin = plugins.getPlugin(id);
  if (!plugin) throw new Error(`No node "${id}" in workspace/nodes.`);
  if (plugin.problems.length) throw new Error(`Fix the manifest first: ${plugin.problems[0]}`);
  const dir = path.join(store.NODES, id);
  const names = listFiles(dir);
  if (names.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files in the node's folder.`);
  const files = {};
  let total = 0;
  for (const n of names) {
    const b = fs.readFileSync(path.join(dir, n));
    total += b.length;
    if (total > MAX_BYTES) throw new Error('The node is over 10 MB.');
    files[n] = { sha256: sha(b), size: b.length, data: b.toString('base64') };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const hash = sha(canonical(files));
  const { priv, pub } = authorKey();
  const pkg = {
    format: 'girafe-node-package', formatVersion: 1,
    id, version: manifest.version, hostApi: manifest.hostApi, girafe: manifest.girafe || null, manifest,
    files, hash, author: { publicKey: pub },
    signature: crypto.sign(null, Buffer.from(hash), priv).toString('base64'),
    packedAt: new Date().toISOString(), kit: KIT_VERSION,
  };
  fs.mkdirSync(OUT, { recursive: true });
  const name = `${id}-${manifest.version}.gnode`;
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(pkg));
  return { name, file: path.join(OUT, name), size: Buffer.byteLength(JSON.stringify(pkg)), hash, version: manifest.version, manifest, pkg };
}

// The checks GIRAFE runs on an upload (also usable by anyone holding a .gnode).
function verify(pkg) {
  if (!pkg || pkg.format !== 'girafe-node-package' || pkg.formatVersion !== 1) throw new Error('Not a GIRAFE node package.');
  if (!store.ID_RE.test(pkg.id || '')) throw new Error('Bad node id.');
  if (!pkg.files || !pkg.files['manifest.json'] || !pkg.files['node.js']) throw new Error('The package needs manifest.json and node.js.');
  const names = Object.keys(pkg.files);
  if (names.length > MAX_FILES) throw new Error('Too many files.');
  let total = 0;
  for (const n of names) {
    if (n.includes('..') || n.startsWith('/') || n.includes('\\') || SKIP.test(n)) throw new Error(`Bad file name: ${n}`);
    const b = Buffer.from(pkg.files[n].data || '', 'base64');
    total += b.length;
    if (sha(b) !== pkg.files[n].sha256 || b.length !== pkg.files[n].size) throw new Error(`${n} doesn't match its checksum.`);
  }
  if (total > MAX_BYTES) throw new Error('Package over 10 MB.');
  if (sha(canonical(pkg.files)) !== pkg.hash) throw new Error('The package hash is wrong.');
  const manifest = JSON.parse(Buffer.from(pkg.files['manifest.json'].data, 'base64').toString('utf8'));
  if (manifest.id !== pkg.id || manifest.version !== pkg.version) throw new Error('The package and its manifest disagree.');
  const problems = plugins.checkManifest(manifest, pkg.id);
  if (problems.length) throw new Error(`Manifest: ${problems[0]}`);
  const pub = crypto.createPublicKey({ key: Buffer.from(pkg.author?.publicKey || '', 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(pkg.hash), pub, Buffer.from(pkg.signature || '', 'base64'))) throw new Error('The signature is not valid.');
  return { id: pkg.id, version: pkg.version, manifest, authorKey: pkg.author.publicKey, hash: pkg.hash };
}

// A pack: <pack-id>-<version>.gpack = the pack.json plus a full .gnode for each of its nodes,
// all signed by the same author key.
//   { format: "girafe-pack-package", formatVersion: 1, id, version, pack (pack.json),
//     packFile: { sha256, size, data }, nodes: [ <node packages> ],
//     hash: sha256 of the sorted lines "pack.json <sha256>\n" and "node:<id> <node hash>\n",
//     author: { publicKey }, signature (over hash), packedAt, kit }
const packCanonical = (packSha, nodes) => [`pack.json ${packSha}\n`, ...nodes.map((n) => `node:${n.id} ${n.hash}\n`)].sort().join('');

function packPack(packId) {
  const packs = require('./packs');
  const p = packs.getPack(packId);
  if (!p) throw new Error(`No pack "${packId}" in workspace/nodes.`);
  if (p.problems.length) throw new Error(`Fix the pack first: ${p.problems[0]}`);
  const raw = fs.readFileSync(path.join(store.NODES, packId, packs.PACK_FILE));
  const packJson = JSON.parse(raw.toString('utf8'));
  const nodes = p.nodes.map((id) => pack(id).pkg);
  const total = nodes.reduce((a, n) => a + Buffer.byteLength(JSON.stringify(n)), 0);
  if (total > 4 * MAX_BYTES) throw new Error('The pack is over 40 MB.');
  const packSha = sha(raw);
  const hash = sha(packCanonical(packSha, nodes));
  const { priv, pub } = authorKey();
  const pkg = {
    format: 'girafe-pack-package', formatVersion: 1, id: packId, version: packJson.version, pack: packJson,
    packFile: { sha256: packSha, size: raw.length, data: raw.toString('base64') },
    nodes, hash, author: { publicKey: pub },
    signature: crypto.sign(null, Buffer.from(hash), priv).toString('base64'),
    packedAt: new Date().toISOString(), kit: KIT_VERSION,
  };
  const text = JSON.stringify(pkg);
  fs.mkdirSync(OUT, { recursive: true });
  const name = `${packId}-${packJson.version}.gpack`;
  fs.writeFileSync(path.join(OUT, name), text);
  return { name, file: path.join(OUT, name), size: Buffer.byteLength(text), hash, version: packJson.version, pack: packJson, manifests: nodes.map((n) => n.manifest), pkg };
}

function verifyPack(pkg) {
  const packs = require('./packs');
  if (!pkg || pkg.format !== 'girafe-pack-package' || pkg.formatVersion !== 1) throw new Error('Not a GIRAFE pack package.');
  if (!store.ID_RE.test(pkg.id || '')) throw new Error('Bad pack id.');
  const raw = Buffer.from(pkg.packFile?.data || '', 'base64');
  if (sha(raw) !== pkg.packFile.sha256 || raw.length !== pkg.packFile.size) throw new Error('pack.json doesn\'t match its checksum.');
  const packJson = JSON.parse(raw.toString('utf8'));
  if (packJson.id !== pkg.id || packJson.version !== pkg.version) throw new Error('The package and its pack.json disagree.');
  if (!Array.isArray(pkg.nodes) || !pkg.nodes.length) throw new Error('The pack holds no nodes.');
  const nodes = pkg.nodes.map(verify);
  if (nodes.some((n) => n.authorKey !== pkg.author?.publicKey)) throw new Error('Every node of a pack must be signed by the pack\'s author.');
  const listed = Array.isArray(packJson.nodes) ? packJson.nodes : [];
  if (listed.length !== nodes.length || listed.some((id, i) => nodes[i].id !== id)) throw new Error('The pack\'s nodes don\'t match its pack.json.');
  const problems = packs.checkPack(packJson, pkg.id, Object.fromEntries(nodes.map((n) => [n.id, n.manifest])));
  if (problems.length) throw new Error(`pack.json: ${problems[0]}`);
  if (sha(packCanonical(pkg.packFile.sha256, pkg.nodes)) !== pkg.hash) throw new Error('The pack hash is wrong.');
  const pub = crypto.createPublicKey({ key: Buffer.from(pkg.author.publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(pkg.hash), pub, Buffer.from(pkg.signature || '', 'base64'))) throw new Error('The pack signature is not valid.');
  return { id: pkg.id, version: pkg.version, pack: packJson, nodes, authorKey: pkg.author.publicKey, hash: pkg.hash };
}

const packageFile = (name) => (/^[a-z0-9-]+-\d+\.\d+\.\d+\.g(node|pack)$/.test(name) ? path.join(OUT, name) : null);

module.exports = { pack, verify, packPack, verifyPack, packageFile, authorKey };
