// What a hostile node must not be able to do in the sandbox (kit/plugins.js + kit/sandbox-child.js).
// Same checks as GIRAFE's server/plugins-sandbox.test.mjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-sbx-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const plugins = require('../kit/plugins');
function plugin(id, code) {
  const dir = path.join(WS, 'nodes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', hostApi: 2, girafe: '>=0.69.0', outputs: ['out'] }));
  fs.writeFileSync(path.join(dir, 'node.js'), code);
  return plugins.getPlugin(id);
}

test('a node cannot reach the network (require or import), processes or eval', async () => {
  const srv = http.createServer((q, r) => r.end('LOCAL')).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const r = await plugins.runPlugin(plugin('hostile', `module.exports = { async run() {
    const out = {};
    const t = async (k, f) => { try { out[k] = String(await f()); } catch (e) { out[k] = 'REFUSED'; } };
    await t('require_net', () => require('net').connect(${port}, '127.0.0.1'));
    await t('import_net', async () => { const net = await import('node:net'); return await new Promise((res, rej) => { const s = net.connect(${port}, '127.0.0.1', () => res('CONNECTED')); s.on('error', rej); }); });
    await t('import_http', async () => { const h = await import('node:http'); return await new Promise((res, rej) => h.get('http://127.0.0.1:${port}/', () => res('GOT')).on('error', rej)); });
    await t('import_dns', async () => { const d = await import('node:dns'); return await new Promise((res, rej) => d.lookup('example.com', (e, a) => (e ? rej(e) : res(a)))); });
    await t('child', async () => (await import('node:child_process')).execSync('id'));
    await t('worker', async () => { const w = await import('node:worker_threads'); new w.Worker('1', { eval: true }); return 'STARTED'; });
    await t('fetch', () => fetch('http://127.0.0.1:${port}/'));
    await t('eval', () => eval('1'));
    await t('fn', () => new Function('return 1')());
    out.crypto = require('crypto').createHash('sha256').update('x').digest('hex').length;
    return JSON.stringify(out);
  } };`), { inputs: {}, nodeId: 'n' });
  srv.close();
  const out = JSON.parse(r.outputs[0].value);
  assert.strictEqual(out.crypto, 64);
  for (const [k, v] of Object.entries(out)) if (k !== 'crypto') assert.strictEqual(v, 'REFUSED', `${k}: ${v}`);
});

test('what a node sends back is bounded; only real host calls answer', async () => {
  await assert.rejects(plugins.runPlugin(plugin('big', `module.exports = { async run(ctx) { await ctx.emit('out', 'x'.repeat(6 * 1024 * 1024)); } };`), { inputs: {}, nodeId: 'n' }), /5 MB/);
  const r = await plugins.runPlugin(plugin('calls', `module.exports = { async run() {
    const call = (name) => new Promise((res) => { const id = 9000 + Math.random(); const on = (m) => { if (m.id === id) { process.off('message', on); res(m.ok ? 'OK' : m.error); } }; process.on('message', on); process.send({ t: 'call', id, name, args: {} }); });
    return [await call('constructor'), await call('hasOwnProperty')].join('|');
  } };`), { inputs: {}, nodeId: 'n' });
  assert.match(r.outputs[0].value, /^unknown host call constructor\|unknown host call hasOwnProperty$/);
});

test('memory outside the JS heap is watched (Linux)', { skip: process.platform !== 'linux' }, async () => {
  await assert.rejects(plugins.runPlugin(plugin('mem', `module.exports = { async run() { const a = []; for (let i = 0; i < 40; i++) { a.push(Buffer.alloc(100 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 100)); } return 'kept'; } };`), { inputs: {}, nodeId: 'n' }), /memory/);
});
