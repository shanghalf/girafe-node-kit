// Signing in (kit/session.js): the kit answers nothing before a GIRAFE sign-in; "not my computer"
// erases your work once the page is gone, never a node GitHub doesn't hold; a cut link signs out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-session-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
process.env.KIT_IDLE_MS = '200';
delete process.env.GIRAFE_KIT_NO_SIGNIN;
fs.mkdirSync(path.join(WS, 'nodes'), { recursive: true });

const TOKEN = 'gk_live_FAKE_SESSION_TOKEN_12345';
let revoked = false;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/kit/link/start') return send(200, { deviceCode: 'dev-1', userCode: 'GIRA-FE42', verifyUrl: `http://${req.headers.host}/link?code=GIRA-FE42`, interval: 1, expiresIn: 600 });
    if (req.url === '/api/kit/link/poll') return send(200, { status: 'approved', token: TOKEN, account: { name: 'Alf', email: 'alf@example.com' } });
    if (req.headers.authorization !== `Bearer ${TOKEN}` || revoked) return send(401, { error: 'not linked' });
    if (req.url === '/api/kit/me') return send(200, { account: { name: 'Alf', email: 'alf@example.com' } });
    if (req.url === '/api/kit/link/revoke') return send(200, { ok: true });
    send(404, { error: 'no' });
  });
});

let base, server, session;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.KIT_GIRAFE_URL = `http://127.0.0.1:${fake.address().port}`;
  session = require('../kit/session');
  ({ server } = await require('../kit/server').start({ port: 0 }));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); fake.close(); });

test('nothing answers before sign-in, then everything does', async () => {
  assert.equal((await call('GET', '/api/graphs')).status, 401);
  assert.equal((await call('GET', '/api/graphs')).data.code, 'signin');
  assert.equal((await call('GET', '/api/info')).status, 200);
  const st = await call('GET', '/api/session');
  assert.equal(st.data.signedIn, false); assert.equal(st.data.required, true);
  const s = await call('POST', '/api/session/signin', { trust: 'passing' });
  assert.equal(s.data.pending.userCode, 'GIRA-FE42');
  assert.ok(await until(async () => (await call('GET', '/api/session')).data.signedIn));
  assert.equal((await call('GET', '/api/session')).data.trust, 'passing');
  assert.equal((await call('GET', '/api/graphs')).status, 200);
});

test('not my computer: a node only here is never erased by itself; erase on purpose works', async () => {
  fs.mkdirSync(path.join(WS, 'nodes', 'my-node'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'nodes', 'my-node', 'manifest.json'), '{"id":"my-node"}');
  fs.mkdirSync(path.join(WS, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'graphs', 'g-1.json'), '{}');
  await new Promise((r) => setTimeout(r, 300)); // the page is gone for longer than the idle time
  await session.idleCheck();
  assert.ok(fs.existsSync(path.join(WS, 'nodes', 'my-node')), 'a node not on GitHub stays');
  assert.match(session.status().note, /my-node/);
  const refused = await call('POST', '/api/session/leave', { erase: true });
  assert.equal(refused.status, 409); assert.equal(refused.data.code, 'unsaved');
  assert.deepEqual(refused.data.unsaved.map((x) => x.id), ['my-node']);
  const ok = await call('POST', '/api/session/leave', { erase: true, force: true });
  assert.equal(ok.data.erased, true);
  assert.ok(!fs.existsSync(path.join(WS, 'nodes', 'my-node')));
  assert.ok(!fs.existsSync(path.join(WS, 'graphs')));
  assert.ok(!fs.existsSync(path.join(WS, '.kit', 'girafe.json')));
  assert.equal((await call('GET', '/api/graphs')).status, 401, 'signed out');
});

test('a link cut from GIRAFE signs the kit out at the next check', async () => {
  await call('POST', '/api/session/signin', { trust: 'mine' });
  assert.ok(await until(async () => (await call('GET', '/api/session')).data.signedIn));
  assert.equal((await call('POST', '/api/session/check')).data.signedIn, true);
  revoked = true;
  const st = (await call('POST', '/api/session/check')).data;
  assert.equal(st.signedIn, false); assert.match(st.note, /signed out/i);
  assert.equal((await call('GET', '/api/graphs')).status, 401);
});

test('my computer: an idle page changes nothing', async () => {
  revoked = false;
  await call('POST', '/api/session/signin', { trust: 'mine' });
  assert.ok(await until(async () => (await call('GET', '/api/session')).data.signedIn));
  fs.mkdirSync(path.join(WS, 'nodes', 'kept'), { recursive: true });
  await new Promise((r) => setTimeout(r, 300));
  await session.idleCheck();
  assert.ok(fs.existsSync(path.join(WS, 'nodes', 'kept')));
  assert.equal((await call('GET', '/api/session')).data.signedIn, true);
});
