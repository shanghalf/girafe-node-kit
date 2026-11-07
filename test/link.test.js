// Pack, verify, connect to GIRAFE (device link) and send, against a fake GIRAFE server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-link-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
fs.cpSync(path.join(__dirname, '..', 'workspace', 'nodes', 'gemini-image'), path.join(WS, 'nodes', 'gemini-image'), { recursive: true });

const TOKEN = 'gk_live_FAKE_TOKEN_123456789';
const seen = [];
let approve = 'approved';
const installed = {}; // id -> { version, authorKey }
let pkgs;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization || null, body: b });
    const j = b ? JSON.parse(b) : {};
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/kit/link/start') return send(200, { deviceCode: 'dev-1', userCode: 'GIRA-FE42', verifyUrl: `http://${req.headers.host}/link?code=GIRA-FE42`, interval: 2, expiresIn: 600 });
    if (req.url === '/api/kit/link/poll') return send(200, approve === 'approved' ? { status: 'approved', token: TOKEN, account: { name: 'Alf', email: 'alf@example.com' } } : { status: approve });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'not linked' });
    if (req.url === '/api/kit/link/revoke') return send(200, { ok: true });
    if (req.url === '/api/kit/packages') {
      let v; try { v = pkgs.verify(j); } catch (e) { return send(400, { error: e.message }); }
      const had = installed[v.id];
      if (had && had.authorKey !== v.authorKey) return send(403, { error: 'signed by another author' });
      if (had && !(require('../kit/plugins').cmpVersion(v.version, had.version) > 0)) return send(409, { error: `${v.id} ${had.version} is already in your account; raise the version.` });
      installed[v.id] = { version: v.version, authorKey: v.authorKey };
      return send(200, { ok: true, status: had ? 'updated' : 'installed', message: `${v.manifest.name} ${v.version} ${had ? 'updated' : 'installed'} in your account.` });
    }
    send(404, { error: 'no' });
  });
});

let link, keys;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.KIT_GIRAFE_URL = `http://127.0.0.1:${fake.address().port}`;
  pkgs = require('../kit/package');
  link = require('../kit/girafe-link');
  keys = require('../kit/keys');
});
test.after(() => { fake.close(); fs.rmSync(WS, { recursive: true, force: true }); });

// The example node's version as shipped (read, not hard-coded), and one patch above it.
const GEMINI_VERSION = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'workspace', 'nodes', 'gemini-image', 'manifest.json'), 'utf8')).version;
const BUMPED = GEMINI_VERSION.replace(/(\d+)$/, (d) => String(Number(d) + 1));

test('pack makes a signed package that verifies; any change is detected', () => {
  const r = pkgs.pack('gemini-image');
  assert.equal(r.name, `gemini-image-${GEMINI_VERSION}.gnode`);
  const v = pkgs.verify(JSON.parse(fs.readFileSync(r.file, 'utf8')));
  assert.equal(v.id, 'gemini-image');
  const tamper = (fn) => { const p = JSON.parse(fs.readFileSync(r.file, 'utf8')); fn(p); return () => pkgs.verify(p); };
  assert.throws(tamper((p) => { p.files['node.js'].data = Buffer.from('module.exports={run(){return 1}}').toString('base64'); }), /checksum/);
  assert.throws(tamper((p) => { const d = Buffer.from('evil'); p.files['node.js'] = { data: d.toString('base64'), size: d.length, sha256: require('crypto').createHash('sha256').update(d).digest('hex') }; }), /hash is wrong/);
  assert.throws(tamper((p) => { p.files['../x.js'] = p.files['node.js']; }), /Bad file name/);
  assert.ok(!fs.readFileSync(r.file, 'utf8').includes('PRIVATE KEY'));
});

test('connect: device link, token kept in the key bank, never shown', async () => {
  const st = await link.connect();
  assert.equal(st.pending.userCode, 'GIRA-FE42');
  await new Promise((r) => setTimeout(r, 2600));
  const s = link.status();
  assert.equal(s.connected, true);
  assert.equal(s.account.name, 'Alf');
  const k = keys.list().find((x) => x.service === 'girafe');
  assert.ok(k && !k.masked.includes('FAKE_TOKEN'));
  assert.ok(!fs.readFileSync(path.join(WS, '.kit', 'keys.json'), 'utf8').includes(TOKEN));
});

test('send: new node, then the same version refused, then a raised version updates', async () => {
  seen.length = 0;
  const r = await link.send('gemini-image');
  assert.equal(r.status, 'installed');
  const up = seen.find((x) => x.url === '/api/kit/packages');
  assert.equal(up.auth, `Bearer ${TOKEN}`);
  assert.ok(!up.body.includes(TOKEN), 'the token is only in the header');
  await assert.rejects(link.send('gemini-image'), /already in your account; raise the version/);
  const mf = path.join(WS, 'nodes', 'gemini-image', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.version = BUMPED; fs.writeFileSync(mf, JSON.stringify(m));
  const r2 = await link.send('gemini-image');
  assert.equal(r2.status, 'updated');
  const log = require('../kit/netguard').report().log.find((e) => e.purpose.includes(`Send "gemini-image" ${BUMPED}`));
  assert.equal(log.key, 'GIRAFE link');
});

test('a revoked link disconnects cleanly; a denied one links nothing', async () => {
  const keyId = keys.list().find((x) => x.service === 'girafe').id;
  const saved = keys.use(keyId, 'girafe');
  // simulate revocation on GIRAFE: replace the stored token by one GIRAFE no longer knows
  keys.remove(keyId);
  const k2 = keys.add({ label: 'GIRAFE link', service: 'girafe', value: 'gk_revoked' });
  fs.writeFileSync(path.join(WS, '.kit', 'girafe.json'), JSON.stringify({ keyId: k2.id, account: { name: 'Alf' } }));
  await assert.rejects(link.send('gemini-image'), /no longer accepts.*Connect again/);
  assert.equal(link.status().connected, false);
  assert.ok(saved.value === TOKEN);
  approve = 'denied';
  await link.connect();
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(link.status().pending.state, 'denied');
  assert.equal(link.status().connected, false);
});
