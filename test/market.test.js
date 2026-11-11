// Publishing to the GIRAFE Market: device link, submit a node with its market/ folder (listing,
// pictures, a video, the tile background), market/ never packed, revoke. Against a fake market.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-market-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const NODE = path.join(WS, 'nodes', 'gemini-image');
fs.cpSync(path.join(__dirname, '..', 'workspace', 'nodes', 'gemini-image'), NODE, { recursive: true });
const MK = path.join(NODE, 'market');
fs.mkdirSync(MK);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
fs.writeFileSync(path.join(MK, '01-shot.png'), png);
fs.writeFileSync(path.join(MK, '02-demo.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200, 2)]));
fs.writeFileSync(path.join(MK, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(60, 3)]));
fs.writeFileSync(path.join(MK, 'notes.txt'), 'ignored');
fs.writeFileSync(path.join(MK, 'listing.json'), JSON.stringify({ tagline: 'Pictures from words', captions: { '01-shot.png': 'A result' } }));

const TOKEN = 'mk_FAKE_MARKET_TOKEN_1234567890';
const seen = [];
let handoffWorks = false;   // a market (and a GIRAFE) that know about the hand-off
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const b = Buffer.concat(chunks);
    seen.push({ url: req.url, auth: req.headers.authorization || null, type: req.headers['content-type'], size: b.length, body: b });
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/kit/link/handoff') {
      if (!handoffWorks) return send(404, { error: 'no such route' });
      const p = JSON.parse(b);
      if (p.handoff !== 'NOTE-FROM-GIRAFE') return send(401, { error: 'bad hand-off' });
      return send(200, { token: TOKEN, account: { name: 'Alf', email: 'alf@example.com' } });
    }
    if (req.url === '/api/kit/link/start') return send(200, { deviceCode: 'dev-m', userCode: 'MRKT-0001', verifyUrl: `http://${req.headers.host}/link?code=MRKT-0001`, interval: 2, expiresIn: 600 });
    if (req.url === '/api/kit/link/poll') return send(200, { status: 'approved', token: TOKEN, account: { name: 'Alf', email: 'alf@example.com' } });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'not linked' });
    if (req.url === '/api/kit/link/revoke') return send(200, { ok: true });
    if (req.url.startsWith('/api/kit/submit')) { const p = JSON.parse(b); return send(200, { submission: { id: '00000000-0000-4000-8000-000000000001', status: 'pending', version: p.version }, message: 'waiting' }); }
    if (/^\/api\/kit\/submissions\/[0-9a-f-]+\/(listing|media)/.test(req.url)) return send(200, { submission: {} });
    if (req.url === '/api/kit/submissions') return send(200, { submissions: [{ id: 'x', name: 'Gemini image', version: '1.0.0', status: 'pending' }] });
    send(404, { error: 'no' });
  });
});

let market, keys;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.KIT_MARKET_URL = `http://127.0.0.1:${fake.address().port}`;
  market = require('../kit/market-link');
  keys = require('../kit/keys');
});
test.after(() => { fake.close(); fs.rmSync(WS, { recursive: true, force: true }); });

test('market/ is read for the listing and never packed', () => {
  const L = market.listing('gemini-image');
  assert.deepEqual(L.media.map((m) => m.name), ['01-shot.png', '02-demo.mp4']);
  assert.equal(L.cover.name, 'cover.jpg');
  assert.equal(L.media[0].caption, 'A result');
  assert.equal(L.listing.tagline, 'Pictures from words');
  const p = require('../kit/package').pack('gemini-image');
  assert.ok(!Object.keys(p.pkg.files).some((f) => f.startsWith('market')), 'market/ must not be in the package');
});

test('submitting needs a link', async () => {
  await assert.rejects(market.submit('gemini-image'), /Connect the kit to the market first/);
});

test('connect, submit with media, list, disconnect', async () => {
  await market.connect();
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(market.status().connected, true);
  assert.equal(market.status().account.name, 'Alf');
  const k = keys.list().find((x) => x.service === 'market');
  assert.ok(k && !JSON.stringify(keys.list()).includes(TOKEN), 'token kept masked');

  const r = await market.submit('gemini-image', { notes: 'First one' });
  assert.equal(r.submission.status, 'pending');
  assert.deepEqual(r.sent, { listing: true, cover: true, media: 2, problems: [] });
  const sub = seen.find((s) => s.url.startsWith('/api/kit/submit'));
  assert.match(sub.url, /notes=First%20one/);
  assert.equal(sub.auth, `Bearer ${TOKEN}`);
  assert.ok(!sub.body.toString().includes(TOKEN));
  const media = seen.filter((s) => s.url.includes('/media'));
  assert.equal(media.length, 3);
  assert.match(media[0].url, /role=cover/);
  assert.equal(media[0].type, 'image/jpeg');
  assert.ok(media.some((m) => m.type === 'video/mp4'));
  assert.ok(media.some((m) => /caption=A%20result/.test(m.url)));
  assert.equal((await market.submissions()).submissions.length, 1);

  await market.disconnect();
  assert.equal(market.status().connected, false);
  assert.ok(seen.some((s) => s.url === '/api/kit/link/revoke'));
  assert.ok(!keys.list().some((x) => x.service === 'market'));
});

test('the network guard keeps the market token on the market', async () => {
  const netguard = require('../kit/netguard');
  await assert.rejects(netguard.send('https://example.com/x', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }, { service: 'market', key: TOKEN }), /network guard/);
});

// ---- connecting through the person's GIRAFE, with the device flow as the fallback ----
test('with a GIRAFE that vouches, connecting is one call and nothing to approve', async () => {
  const girafe = require('../kit/girafe-link');
  const realStatus = girafe.status;
  const realHandoff = girafe.marketHandoff;
  await market.disconnect().catch(() => {});
  try {
    girafe.status = () => ({ connected: true, account: { name: 'Alf' } });
    girafe.marketHandoff = async () => ({ handoff: 'NOTE-FROM-GIRAFE' });
    handoffWorks = true;
    const st = await market.connect();
    assert.equal(st.connected, true, 'linked straight away');
    assert.equal(st.viaGirafe, true);
    assert.equal(st.account.email, 'alf@example.com');
    assert.ok(!st.pending, 'no code to type anywhere');
    assert.ok(seen.some((x) => x.url === '/api/kit/link/handoff'));
    assert.ok(!seen.slice(-2).some((x) => x.url === '/api/kit/link/start'), 'the device flow was not needed');
  } finally { girafe.status = realStatus; girafe.marketHandoff = realHandoff; }
});

test('a market or a GIRAFE that cannot hand over falls back to the device flow', async () => {
  const girafe = require('../kit/girafe-link');
  const realStatus = girafe.status;
  const realHandoff = girafe.marketHandoff;
  await market.disconnect().catch(() => {});
  try {
    girafe.status = () => ({ connected: true, account: { name: 'Alf' } });
    girafe.marketHandoff = async () => { throw Object.assign(new Error('this GIRAFE and the market share no secret'), { status: 503 }); };
    handoffWorks = true;
    const st = await market.connect();
    assert.equal(st.connected, false);
    assert.equal(st.pending.userCode, 'MRKT-0001', 'the usual code to approve');
  } finally { girafe.status = realStatus; girafe.marketHandoff = realHandoff; handoffWorks = false; await market.disconnect().catch(() => {}); }
});
