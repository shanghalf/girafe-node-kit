// Host API 2: long runs, ctx.state, ctx.files.fromUrl, ctx.http forms, "*.host" network entries,
// and the tripo key service. Against a fake service; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-api2-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const KEY = 'tsk_FAKE_TRIPO_KEY_0123456789abcdefghij';
const seen = [];
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(200, 7)]);
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, type: req.headers['content-type'] || '', body });
    if (req.url === '/v3/files' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, data: { file_token: body.includes(Buffer.from('PNGDATA')) ? 'tok-ok' : 'tok-bad' } }));
    }
    if (req.url === '/v3/dl/model.glb') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(GLB); }
    res.writeHead(404); res.end();
  });
});

function plugin(id, manifest, code) {
  const dir = path.join(WS, 'nodes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', hostApi: 2, girafe: '>=0.69.0', outputs: ['out'], ...manifest }));
  fs.writeFileSync(path.join(dir, 'node.js'), code);
}

let plugins, keys, store, netguard, keyId;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.KIT_TRIPO_URL = `http://127.0.0.1:${fake.address().port}/v3`;
  plugins = require('../kit/plugins'); keys = require('../kit/keys'); store = require('../kit/store'); netguard = require('../kit/netguard');
  keyId = keys.add({ label: 'My Tripo', value: KEY }).id;
  plugin('api2', {
    limits: { seconds: 120 },
    capabilities: { keys: [{ slot: 'tripo', service: 'tripo', label: 'Tripo' }], network: ['openapi.tripo3d.ai', '*.tripo3d.com'], files: 'readwrite', state: true },
  }, `module.exports = { async run(ctx) {
    const st = await ctx.state.get();
    st.count = (st.count || 0) + 1;
    await ctx.state.set(st);
    const up = await ctx.http({ slot: 'tripo', method: 'POST', url: 'https://openapi.tripo3d.ai/v3/files', form: { file: { file: ctx.inputs.A, name: 'in.png' }, note: 'hello' } });
    const model = await ctx.files.fromUrl('https://openapi.tripo3d.ai/v3/dl/model.glb', { name: 'm.glb', mime: 'model/gltf-binary' });
    let refused = null;
    try { await ctx.files.fromUrl('https://evil.example.com/x.glb'); } catch (e) { refused = e.message; }
    return { count: st.count, token: up.json.data.file_token, model, refused };
  } };`);
  plugin('slow', { limits: { seconds: 1 } }, `module.exports = { async run() { await new Promise((r) => setTimeout(r, 3000)); return 'late'; } };`);
});
test.after(() => { fake.close(); fs.rmSync(WS, { recursive: true, force: true }); });

test('a Tripo key is recognised', () => {
  assert.equal(keys.list().find((k) => k.id === keyId).service, 'tripo');
});

test('state, forms, downloads and the key slot work together', async () => {
  const pic = store.saveFile(Buffer.from('PNGDATA'), 'image/png');
  const ref = { imageUrl: '/files/' + pic.key, key: pic.key, mime: 'image/png' };
  const run = () => plugins.runPlugin(plugins.getPlugin('api2'), { inputs: { A: ref }, keySlots: { tripo: keyId }, nodeId: 'n1', settings: {} });
  const first = JSON.parse((await run()).outputs[0].value);
  assert.equal(first.count, 1);
  assert.equal(first.token, 'tok-ok', 'the picture bytes went into the form');
  assert.equal(first.model.mime, 'model/gltf-binary');
  assert.ok(first.model.key.endsWith('.glb'));
  assert.deepEqual(fs.readFileSync(store.filePath(first.model.key)), GLB);
  assert.match(first.refused, /not in the manifest's "network"/);
  // the state survived: a second run (another process) counts on
  assert.equal(JSON.parse((await run()).outputs[0].value).count, 2);
  // another canvas node has its own state
  const other = await plugins.runPlugin(plugins.getPlugin('api2'), { inputs: { A: ref }, keySlots: { tripo: keyId }, nodeId: 'n2', settings: {} });
  assert.equal(JSON.parse(other.outputs[0].value).count, 1);
  const up = seen.find((x) => x.url === '/v3/files');
  assert.equal(up.auth, `Bearer ${KEY}`, 'the host added the key as a Bearer token');
  assert.match(up.type, /^multipart\/form-data/);
  const dl = seen.find((x) => x.url === '/v3/dl/model.glb');
  assert.equal(dl.auth, null, 'no key on a download');
  assert.equal(netguard.report().stats.blocked, 0);
});

test('the time limit comes from the manifest', async () => {
  await assert.rejects(plugins.runPlugin(plugins.getPlugin('slow'), { inputs: {}, nodeId: 'x' }), /longer than 1 s/);
});

test('manifest rules for host API 2', () => {
  const base = { id: 'x', name: 'x', version: '1.0.0', girafe: '>=0.69.0' };
  assert.deepEqual(plugins.checkManifest({ ...base, hostApi: 2, limits: { seconds: 3600 }, capabilities: { state: true, network: ['*.tripo3d.com'] } }, 'x'), []);
  const v1 = plugins.checkManifest({ ...base, hostApi: 1, limits: { seconds: 30 }, capabilities: { state: true, network: ['*.tripo3d.com'], keys: [{ slot: 't', service: 'tripo' }] } }, 'x');
  assert.ok(v1.some((p) => /"limits" needs/.test(p)));
  assert.ok(v1.some((p) => /"state" needs/.test(p)));
  assert.ok(v1.some((p) => /\*\.host/.test(p)));
  assert.ok(v1.some((p) => /needs "hostApi": 2/.test(p)));
  assert.ok(plugins.checkManifest({ ...base, hostApi: 2, limits: { seconds: 7200 } }, 'x').some((p) => /1 to 3600/.test(p)));
  assert.equal(plugins.hostAllowed({ network: ['*.tripo3d.com'] }, 'cdn.tripo3d.com'), true);
  assert.equal(plugins.hostAllowed({ network: ['*.tripo3d.com'] }, 'tripo3d.com.evil.net'), false);
  assert.equal(plugins.hostAllowed({ network: ['*.tripo3d.com'] }, 'eviltripo3d.com'), false);
});

test('file fields, nodes with no outputs, and runs kept by the host', async () => {
  const engine = require('../kit/engine');
  const nodeRuns = require('../kit/node-runs');
  const base = { id: 'x', name: 'x', version: '1.0.0', girafe: '>=0.69.0' };
  assert.deepEqual(plugins.checkManifest({ ...base, hostApi: 2, outputs: [], display: 'runs', fields: [{ key: 'm', type: 'file', accept: '.glb', multiple: true }] }, 'x'), []);
  const v1 = plugins.checkManifest({ ...base, hostApi: 1, outputs: [], display: 'runs', fields: [{ key: 'm', type: 'file' }] }, 'x');
  assert.ok(v1.some((p) => /"outputs": \[\].*hostApi/.test(p)));
  assert.ok(v1.some((p) => /"display": "runs" needs/.test(p)));
  assert.ok(v1.some((p) => /file fields need/.test(p)));
  assert.ok(plugins.checkManifest({ ...base, hostApi: 2, display: 'grid' }, 'x').some((p) => /only "runs"/.test(p)));

  plugin('shelf', { outputs: [], display: 'runs', inputs: { min: 1, max: 4 } }, 'module.exports = { run: (ctx) => Object.values(ctx.inputs) };');
  plugin('noemit', { outputs: [] }, 'module.exports = { async run(ctx) { await ctx.emit("out", 1); } };');
  plugin('filefield', { fields: [{ key: 'files', type: 'file', multiple: true }], capabilities: { files: 'read' } },
    'module.exports = { async run(ctx) { const f = ctx.settings.files[0]; const r = await ctx.files.read(f); return r.bytes.toString() + "|" + ctx.isFile(f); } };');
  const run = (graph) => engine.createRun(graph).promise;
  for (const word of ['one', 'two']) {
    const rs = await run({ nodes: [{ id: 'i', type: 'input', value: word }, { id: 's', type: 'plugin:shelf' }], wires: [{ id: 'w', from: 'i', to: 's', port: 'out' }] });
    assert.equal(rs.nodes.s.status, 'done');
    assert.deepEqual(rs.nodes.s.outputs, [word], 'what it returned is shown on the node');
  }
  const kept = nodeRuns.list('s');
  assert.deepEqual(kept.map((r) => r.values[0]), ['two', 'one'], 'newest run first');
  const bad = await run({ nodes: [{ id: 'i', type: 'input', value: 'x' }, { id: 'n', type: 'plugin:noemit' }], wires: [{ id: 'w', from: 'i', to: 'n', port: 'out' }] });
  assert.match(bad.nodes.n.note, /no outputs/);
  const f = store.saveFile(Buffer.from('MODELDATA'), 'model/gltf-binary');
  const ff = await run({ nodes: [{ id: 'q', type: 'plugin:filefield', settings: { files: [{ imageUrl: '/files/' + f.key, key: f.key, mime: f.mime, name: 'a.glb' }] } }], wires: [] });
  assert.deepEqual(ff.nodes.q.outputs, ['MODELDATA|true'], 'a file chosen in the panel is readable like an input file');
});
