// The kit's local web server. Node built-ins only; listens on 127.0.0.1 (never the network).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const plugins = require('./plugins');
const core = require('./core-nodes');
const engine = require('./engine');
const version = require('./version');
const keys = require('./keys');
const textAI = require('./ai/text');
const gemini = require('./ai/gemini-image');
const netguard = require('./netguard');
const pkgs = require('./package');
const link = require('./girafe-link');
const market = require('./market-link');
const packs = require('./packs');
const compat = require('./compat');
const updater = require('./updater');
const nodeRuns = require('./node-runs');
const github = require('./github');
const home = require('./home');
const session = require('./session');
const serviceTasks = require('./service-tasks');

const WEB = path.join(__dirname, '..', 'web');
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4' };
// The page may load and contact only this kit: nothing from or to the internet.
// 'wasm-unsafe-eval' and blob: workers are for the 3D viewer (web/vendor/model-viewer, the one GIRAFE
// uses): it unpacks compressed models with WebAssembly. No eval of text, no outside script.
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const runs = new Map(); // runId -> { run, at }
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_MODEL_UPLOAD = 150 * 1024 * 1024; // a 3D model for a file field (host API 2)
const MODEL_EXT = { glb: 'model/gltf-binary', fbx: 'model/fbx', obj: 'model/obj', stl: 'model/stl' };

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const readJson = async (req) => { const b = await readBody(req, 5 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

function sweepRuns() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, r] of runs) if (r.run.rs.endedAt && r.run.rs.endedAt < cutoff) runs.delete(id);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = (re) => re.exec(p);
  let k;

  // Only this machine, by its own name (stops DNS-rebinding pages from reaching the kit).
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || ''))) return send(res, 403, { error: 'open the kit at http://localhost' });
  // A page from another site must not drive the kit: only same-origin requests write.
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'cross-site request refused' });

  // Your own GIRAFE - and only it - may READ these two, so its "Open the kit" button can say
  // whether the kit is running, which version, and from which folder, instead of firing a link
  // blind and leaving the browser to say "this site can't be reached". Nothing else is shared
  // cross-origin, and nothing cross-origin may write (the rule just above still holds).
  if (['/api/info', '/api/compat'].includes(p) && req.headers.origin && req.headers.origin === compat.girafeOrigin()) {
    res.setHeader('access-control-allow-origin', req.headers.origin);
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { allow: 'GET, POST, OPTIONS' }); return res.end(); }

  // Signing in (kit/session.js): until the kit is signed in with GIRAFE, only these answer.
  if (req.method === 'GET' && p === '/api/session') return send(res, 200, session.status());
  if (req.method === 'POST' && p === '/api/session/signin') {
    try { const b = await readJson(req); await session.signIn(b.trust); return send(res, 200, session.status()); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (req.method === 'POST' && p === '/api/session/beat') return send(res, 200, session.beat());
  if (req.method === 'POST' && p === '/api/session/check') return send(res, 200, await session.check());
  if (p.startsWith('/api/') && !['/api/info', '/api/compat', '/api/update'].includes(p) && !session.status().signedIn) return send(res, 401, { error: 'Sign in with your GIRAFE account first.', code: 'signin' });
  if (req.method === 'GET' && p === '/api/session/unsaved') { try { return send(res, 200, await session.unsaved()); } catch (e) { return send(res, 502, { error: e.message }); } }
  if (req.method === 'POST' && p === '/api/session/leave') {
    const b = await readJson(req);
    try { const r = await session.leave({ erase: !!b.erase, force: !!b.force }); return send(res, r.ok ? 200 : 409, r); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }

  if (req.method === 'GET' && p === '/api/info') {
    // `kitFolder` and `latest` are here so GIRAFE's "Open the kit" can say, without a second call,
    // which folder is running and whether it is the newest pull from GitHub. `latest` is whatever
    // was last read (kit/compat.js's cache): answering must stay instant, so nothing is fetched.
    const seen = compat.lastLatest();
    return send(res, 200, { kit: version.KIT_VERSION, girafe: version.GIRAFE_VERSION, hostApi: version.HOST_API, workspace: store.ROOT, workspaceMode: home.resolve().mode, migratedFrom: home.resolve().migratedFrom,
      kitFolder: path.join(__dirname, '..'), signedIn: session.status().signedIn, latest: seen.version || null, latestAt: seen.at || null, updateAvailable: !!(seen.version && plugins.cmpVersion(seen.version, version.KIT_VERSION) > 0) });
  }
  // Open a folder in this computer's own file manager. Same-origin only (the cross-site rule
  // above): GIRAFE can't call it, it opens the kit's page with ?folder=… and the page asks.
  if (req.method === 'POST' && p === '/api/open-folder') {
    try {
      const b = await readJson(req).catch(() => ({}));
      const dir = b.which === 'kit' ? path.join(__dirname, '..') : store.ROOT;
      if (!fs.existsSync(dir)) return send(res, 404, { error: `${dir} is not there any more.` });
      const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      // The path is an argument, never part of a command line, and nothing waits on the window.
      const child = require('child_process').spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {}); // no file manager (a server, a bare container): nothing to do
      child.unref();
      return send(res, 200, { ok: true, folder: dir });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  // Your work in one home folder (kit/home.js); other kit folders still holding work can be brought here.
  if (req.method === 'GET' && p === '/api/workspace') return send(res, 200, { root: store.ROOT, mode: home.resolve().mode, others: home.findOtherKits() });
  if (req.method === 'POST' && p === '/api/workspace/import') {
    try {
      const b = await readJson(req);
      const r = home.importFrom(b.path);
      return send(res, 200, { ...r, restart: updater.restartSoon() });
    } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }
  // Versions both ways (kit/compat.js) and "Update the kit" (kit/updater.js).
  if (req.method === 'GET' && p === '/api/compat') {
    try { return send(res, 200, { ...(await compat.status({ force: url.searchParams.get('force') === '1' })), update: { ...updater.info(), ...(await updater.method()) } }); }
    catch (e) { return send(res, e instanceof netguard.Blocked ? 403 : 502, { error: e.message }); }
  }
  // "Align with GIRAFE": one button for the whole version web (kit/compat.js align()).
  if (req.method === 'POST' && p === '/api/align') {
    try {
      const b = await readJson(req).catch(() => ({}));
      return send(res, 200, await compat.align({ id: b.id ? String(b.id) : null, send: !!b.send }));
    } catch (e) { return send(res, e instanceof netguard.Blocked ? 403 : 502, { error: e.message }); }
  }
  if (req.method === 'POST' && p === '/api/update') {
    try { return send(res, 200, await updater.start()); }
    catch (e) { return send(res, e.code === 'cannot-update' ? 409 : 502, { error: e.message, code: e.code || null }); }
  }
  // display "runs" (host API 2): what a node kept over its last runs.
  if ((k = m(/^\/api\/node-runs\/([A-Za-z0-9_-]{1,64})$/))) {
    if (req.method === 'GET') return send(res, 200, { runs: nodeRuns.list(k[1]) });
    if (req.method === 'DELETE') { nodeRuns.clear(k[1]); return send(res, 200, { ok: true }); }
  }
  // A "tasks" field (host API 2): past tasks of a key service, from its history or its export file.
  if (req.method === 'POST' && p === '/api/service-tasks') {
    try {
      const { plugin: pluginId, field, keyId, before, csv } = await readJson(req);
      const pl = plugins.getPlugin(String(pluginId || ''));
      const f = pl && (pl.fields || []).find((x) => x.key === field && x.type === 'tasks');
      const slot = f && (pl.capabilities.keys || []).find((x) => x.slot === f.slot);
      if (!slot) return send(res, 404, { error: 'no such tasks field' });
      const packBilling = pl.pack ? (packs.readPack(pl.pack).billing || []) : [];
      const billing = require('./billing').billingFor(pl.billing, packBilling).find((b) => b && b.service === slot.service);
      if (!billing) return send(res, 400, { error: `The package declares no "billing" for ${slot.service}: the kit can't read its history.` });
      if (typeof csv === 'string' && csv.trim()) return send(res, 200, serviceTasks.fromCsv(billing, csv));
      if (!keyId) return send(res, 400, { error: `Choose a ${slot.service} key for this node first.` });
      return send(res, 200, await serviceTasks.fromService(billing, String(keyId), before || null));
    } catch (e) { return send(res, e instanceof netguard.Blocked ? 403 : 400, { error: e.message }); }
  }
  if (req.method === 'GET' && p === '/api/kinds') return send(res, 200, { core: core.describe(), plugins: plugins.listPlugins() });

  if (req.method === 'GET' && p === '/api/graphs') return send(res, 200, { graphs: store.listGraphs() });
  if (req.method === 'POST' && p === '/api/graphs') {
    const body = await readJson(req);
    const id = 'g-' + crypto.randomBytes(4).toString('hex');
    return send(res, 200, { id, graph: store.writeGraph(id, { title: body.title || 'New graph', nodes: [], wires: [] }) });
  }
  if ((k = m(/^\/api\/graphs\/([a-z0-9-]+)$/))) {
    if (req.method === 'GET') { const g = store.readGraph(k[1]); return g ? send(res, 200, { graph: g }) : send(res, 404, { error: 'no such graph' }); }
    if (req.method === 'POST') return send(res, 200, { graph: store.writeGraph(k[1], await readJson(req)) });
    if (req.method === 'DELETE') { store.deleteGraph(k[1]); return send(res, 200, { ok: true }); }
  }

  // Key bank: values go in, only masked forms come out.
  if (req.method === 'GET' && p === '/api/keys') return send(res, 200, { keys: keys.list(), services: keys.SERVICES });
  if (req.method === 'POST' && p === '/api/keys') {
    // The paste step: the key arrives from the page (on this computer) and is saved encrypted.
    // We count what the kit sent to the internet meanwhile, to show you: it should be nothing.
    const before = netguard.mark();
    try {
      const body = await readJson(req);
      if (body.service === 'girafe') return send(res, 400, { error: 'The GIRAFE link is made with "Connect to GIRAFE", not pasted.' });
      if (body.service === 'market') return send(res, 400, { error: 'The market link is made with "Connect" in 🛒 Market, not pasted.' });
      const key = keys.add(body);
      return send(res, 200, { key, during: netguard.since(before) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method === 'DELETE' && (k = m(/^\/api\/keys\/(k-[0-9a-f]{10})$/))) { keys.remove(k[1]); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && p === '/api/network') return send(res, 200, netguard.report());
  if (req.method === 'POST' && p === '/api/models') {
    const { keyId, kind } = await readJson(req);
    try {
      const key = keys.use(keyId);
      if (kind === 'image' && key.service === 'gemini') return send(res, 200, { models: gemini.IMAGE_MODELS });
      return send(res, 200, { models: await textAI.listModels({ service: key.service, key: key.value, keyLabel: key.label, kind }) });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  // Packages and the GIRAFE link
  if (req.method === 'GET' && p === '/api/packs') return send(res, 200, { packs: packs.listPacks() });
  if (req.method === 'POST' && (k = m(/^\/api\/packs\/([a-z0-9][a-z0-9-]{0,63})\/keys$/))) {
    const { slot, keyId } = await readJson(req);
    const pk = packs.getPack(k[1]);
    if (!pk) return send(res, 404, { error: 'no such pack' });
    if (!pk.keys.some((x) => x.slot === slot)) return send(res, 400, { error: 'that pack has no such key slot' });
    if (keyId && !keys.list().some((x) => x.id === keyId)) return send(res, 400, { error: 'no such key' });
    return send(res, 200, { keySlots: packs.setKey(k[1], String(slot), keyId ? String(keyId) : null) });
  }
  if (req.method === 'POST' && p === '/api/pack') {
    const { id, pack: packId } = await readJson(req);
    if (packId) {
      try { const r = pkgs.packPack(String(packId)); return send(res, 200, { name: r.name, size: r.size, hash: r.hash, version: r.version, url: '/packages/' + r.name }); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    try { const r = pkgs.pack(String(id || '')); return send(res, 200, { name: r.name, size: r.size, hash: r.hash, version: r.version, url: '/packages/' + r.name }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (req.method === 'GET' && (k = m(/^\/packages\/([a-z0-9.-]+\.g(?:node|pack))$/))) {
    const fp = pkgs.packageFile(k[1]);
    if (!fp || !fs.existsSync(fp)) return send(res, 404, { error: 'no such package' });
    return send(res, 200, fs.readFileSync(fp), { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${k[1]}"` });
  }
  if (req.method === 'GET' && p === '/api/girafe') return send(res, 200, link.status());
  if (req.method === 'POST' && p === '/api/girafe/connect') { try { return send(res, 200, await link.connect()); } catch (e) { return send(res, 502, { error: e.message }); } }
  if (req.method === 'POST' && p === '/api/girafe/disconnect') return send(res, 200, await link.disconnect());
  if (req.method === 'POST' && p === '/api/girafe/send') {
    const { id } = await readJson(req);
    try { return send(res, 200, await link.send(String(id || ''))); } catch (e) { return send(res, e.needsLink ? 409 : e.code ? 409 : 400, { error: e.message, needsLink: !!e.needsLink, code: e.code || null }); }
  }

  if (req.method === 'POST' && p === '/api/girafe/send-pack') {
    const { id } = await readJson(req);
    try { return send(res, 200, await link.sendPack(String(id || ''))); } catch (e) { return send(res, e.needsLink ? 409 : e.code ? 409 : 400, { error: e.message, needsLink: !!e.needsLink, code: e.code || null }); }
  }

  // Publishing to the GIRAFE Market (kit/market-link.js).
  if (req.method === 'GET' && p === '/api/market') return send(res, 200, market.status());
  if (req.method === 'POST' && p === '/api/market/connect') { try { return send(res, 200, await market.connect()); } catch (e) { return send(res, 502, { error: e.message }); } }
  if (req.method === 'POST' && p === '/api/market/disconnect') return send(res, 200, await market.disconnect());
  if (req.method === 'GET' && (k = m(/^\/api\/market\/listing\/([a-z0-9][a-z0-9-]{0,63})$/))) return send(res, 200, market.listing(k[1]));
  if (req.method === 'GET' && p === '/api/market/submissions') {
    try { return send(res, 200, await market.submissions()); } catch (e) { return send(res, e.needsLink ? 409 : 502, { error: e.message, needsLink: !!e.needsLink }); }
  }
  if (req.method === 'POST' && p === '/api/market/submit') {
    const { id, kind, notes } = await readJson(req);
    try { return send(res, 200, await market.submit(String(id || ''), { kind: kind === 'pack' ? 'pack' : 'node', notes: String(notes || '') })); }
    catch (e) { return send(res, e instanceof netguard.Blocked ? 403 : e.needsLink || e.code ? 409 : 400, { error: e.message, needsLink: !!e.needsLink, code: e.code || null }); }
  }

  // Your nodes on GitHub (kit/github.js). Errors say what to do; a secret found stops a save.
  if (p.startsWith('/api/github')) {
    const fail = (e) => send(res, e instanceof netguard.Blocked ? 403 : e.status === 401 ? 401 : ['behind', 'conflict', 'race', 'public', 'secret'].includes(e.code) ? 409 : e.code === 'network' || e.code === 'github' || e.code === 'rate' ? 502 : 400, { error: e.message, code: e.code || null, hits: e.hits || undefined });
    try {
      if (req.method === 'GET' && p === '/api/github') return send(res, 200, await github.status({ remote: url.searchParams.get('remote') === '1' }));
      if (req.method === 'GET' && p === '/api/github/history') return send(res, 200, await github.history({ id: url.searchParams.get('id') }));
      if (req.method === 'GET' && p === '/api/github/diff') return send(res, 200, await github.diff({ id: url.searchParams.get('id') }));
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (p === '/api/github/connect') return send(res, 200, await github.connect(body));
        if (p === '/api/github/disconnect') return send(res, 200, github.disconnect());
        if (p === '/api/github/save') return send(res, 200, await github.save(body));
        if (p === '/api/github/update') return send(res, 200, await github.update(body));
        if (p === '/api/github/restore') return send(res, 200, await github.restore(body));
      }
    } catch (e) { return fail(e); }
  }

  if (req.method === 'POST' && p === '/api/files') {
    let mime = String(req.headers['content-type'] || '').split(';')[0];
    const ext = (String(url.searchParams.get('name') || '').toLowerCase().match(/\.(glb|fbx|obj|stl)$/) || [])[1];
    // A 3D model (for a file field): told by its name, browsers rarely know its type.
    if (ext) mime = MODEL_EXT[ext];
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime) && !Object.values(MODEL_EXT).includes(mime)) return send(res, 400, { error: 'PNG, JPEG, WebP or GIF pictures, or GLB, FBX, OBJ or STL models only' });
    const buf = await readBody(req, ext ? MAX_MODEL_UPLOAD : MAX_UPLOAD);
    if (mime === 'model/gltf-binary' && buf.subarray(0, 4).toString('latin1') !== 'glTF') return send(res, 400, { error: 'This .glb file is not a GLB model.' });
    const f = store.saveFile(buf, mime);
    return send(res, 200, { ref: { imageUrl: '/files/' + f.key, key: f.key, mime: f.mime, size: f.size, name: String(url.searchParams.get('name') || '').slice(0, 120) || undefined } });
  }
  if (req.method === 'GET' && (k = m(/^\/files\/([a-f0-9]{16}\.[a-z]+)$/))) {
    const fp = store.filePath(k[1]);
    if (!fp || !fs.existsSync(fp)) return send(res, 404, { error: 'no such file' });
    return send(res, 200, fs.readFileSync(fp), { 'Content-Type': store.mimeOf(k[1]), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  if (req.method === 'POST' && p === '/api/run') {
    sweepRuns();
    const { graph } = await readJson(req);
    if (!graph || !Array.isArray(graph.nodes)) return send(res, 400, { error: 'graph missing' });
    const run = engine.createRun({ nodes: graph.nodes, wires: graph.wires || [] });
    runs.set(run.rs.id, { run, at: Date.now() });
    return send(res, 202, { runId: run.rs.id });
  }
  if ((k = m(/^\/api\/runs\/([0-9a-f-]{36})(\/stop|\/answer)?$/))) {
    const r = runs.get(k[1]);
    if (!r) return send(res, 404, { error: 'run not found (it may have ended a while ago)' });
    if (req.method === 'GET' && !k[2]) return send(res, 200, { run: r.run.rs });
    if (req.method === 'POST' && k[2] === '/stop') { r.run.stop(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && k[2] === '/answer') {
      const { askId, answer } = await readJson(req);
      if (!['yes', 'no'].includes(answer)) return send(res, 400, { error: 'answer is yes or no' });
      return r.run.answer(askId, answer) ? send(res, 200, { ok: true }) : send(res, 409, { error: 'that question is no longer waiting' });
    }
  }

  if (req.method === 'GET' && (p === '/docs' || p === '/docs.html')) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, '..', 'docs.html')), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
  }
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const fp = path.join(WEB, path.normalize(rel));
    if (!fp.startsWith(WEB + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(fp), { 'Content-Type': STATIC[path.extname(fp)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
  }
  return send(res, 404, { error: 'not found' });
}

function start({ port = 4747, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => { if (!res.headersSent) send(res, e.status || 500, { error: e.message }); });
    });
    const tryListen = (p, left) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && left > 0 ? tryListen(p + 1, left - 1) : reject(e)));
      server.listen(p, host, () => resolve({ server, url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${server.address().port}/` }));
    };
    tryListen(port, 10);
  });
}

module.exports = { start, handle };
