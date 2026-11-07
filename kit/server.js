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

const WEB = path.join(__dirname, '..', 'web');
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
// The page may load and contact only this kit: nothing from or to the internet.
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const runs = new Map(); // runId -> { run, at }
const MAX_UPLOAD = 25 * 1024 * 1024;

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

  if (req.method === 'GET' && p === '/api/info') return send(res, 200, { kit: version.KIT_VERSION, girafe: version.GIRAFE_VERSION, hostApi: version.HOST_API, workspace: store.ROOT });
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
      const key = keys.add(await readJson(req));
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

  if (req.method === 'POST' && p === '/api/files') {
    const mime = String(req.headers['content-type'] || '').split(';')[0];
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return send(res, 400, { error: 'PNG, JPEG, WebP or GIF only' });
    const buf = await readBody(req, MAX_UPLOAD);
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
