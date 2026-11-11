// Kit <-> GIRAFE versions both ways, and "Update the kit" end to end (a copy of the kit is
// updated from a fake release, restarted, and put back when the new version doesn't start).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-versions-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const KIT = path.join(__dirname, '..');

let girafeAnswer = { status: 200, body: { girafeVersion: '0.68.3', hostApi: 1, hostApis: [0, 1], minKit: '0.4.0', keyServices: ['anthropic', 'openai', 'gemini'], kit: { repo: 'x/y', branch: 'release' } } };
const seen = [];
let release = null; // { version, zip }
let packagesAnswer = () => ({ status: 200, body: { ok: true } });
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    seen.push({ url: req.url, method: req.method, kitVersion: req.headers['x-girafe-kit-version'] || null });
    const json = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url === '/api/kit/compat') return girafeAnswer.status === 200 ? json(200, girafeAnswer.body) : json(girafeAnswer.status, {});
    if (req.url === '/api/kit/link/start') return json(200, { deviceCode: 'dc', userCode: 'AAAA-BBBB', verifyUrl: `http://127.0.0.1:${fake.address().port}/?link=AAAA-BBBB`, expiresIn: 600, interval: 2 });
    if (req.url === '/api/kit/link/poll') return json(200, { status: 'approved', token: 'gk_test', account: { name: 'Alf' } });
    if (req.url === '/api/kit/packages') { const a = packagesAnswer(Buffer.concat(chunks).toString()); return json(a.status, a.body); }
    if (req.url === '/rel/package.json') return release ? json(200, { name: 'girafe-node-kit', version: release.version, engines: { node: '>=22' } }) : json(404, {});
    if (req.url === '/rel/kit.zip') { if (!release) return json(404, {}); res.writeHead(200, { 'content-type': 'application/zip', 'content-length': release.zip.length }); return res.end(release.zip); }
    json(404, {});
  });
});

let compat, link, keys, zip, updater;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  process.env.KIT_GIRAFE_URL = base;
  process.env.KIT_UPDATE_URL = base + '/rel';
  compat = require('../kit/compat'); link = require('../kit/girafe-link'); keys = require('../kit/keys'); zip = require('../kit/zip'); updater = require('../kit/updater');
});
test.after(() => { fake.close(); fs.rmSync(WS, { recursive: true, force: true }); });

test('GIRAFE behind the kit: a warning, and host API 2 nodes are refused before sending', async () => {
  compat._reset();
  const s = await compat.status({ force: true });
  assert.equal(s.girafe.version, '0.68.3');
  assert.ok(s.problems.some((p) => p.code === 'girafe-behind' && p.level === 'warn'));
  assert.ok(!s.problems.some((p) => p.level === 'block'));
  assert.ok(seen.some((x) => x.url === '/api/kit/compat' && x.kitVersion === require('../kit/version').KIT_VERSION), 'the kit says its version');
  const g = await compat.girafe({});
  assert.match(compat.checkNode({ name: 'T', hostApi: 2 }, g).text, /can't be sent until GIRAFE is updated/);
  assert.equal(compat.checkNode({ name: 'T', hostApi: 1 }, g), null);
  assert.match(compat.checkNode({ name: 'T', hostApi: 1, girafe: '>=0.70.0' }, g).text, /needs GIRAFE 0.70.0/);
  assert.match(compat.checkNode({ name: 'T', hostApi: 1, capabilities: { keys: [{ service: 'tripo' }] } }, g).text, /tripo key/);
  assert.equal(compat.checkNode({ name: 'T', hostApi: 0 }, { ...g, hostApis: [1, 2] }).code, 'node-outdated');
});

test('a kit older than GIRAFE wants blocks sending; an update is offered', async () => {
  girafeAnswer.body = { ...girafeAnswer.body, minKit: '9.0.0' };
  release = { version: '9.0.0', zip: Buffer.alloc(0) };
  const s = await compat.status({ force: true });
  assert.ok(s.problems.some((p) => p.code === 'kit-outdated' && p.level === 'block'));
  assert.equal(s.updateAvailable, true);
  assert.equal((await compat.beforeSend({ name: 'T', hostApi: 1 })).code, 'kit-outdated');
  girafeAnswer.body = { ...girafeAnswer.body, minKit: '0.4.0' };
  release = null;
});

test('send: refused in the kit, nothing reaches GIRAFE', async () => {
  const dir = path.join(WS, 'nodes', 'big');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'big', name: 'Big', version: '1.0.0', hostApi: 2, girafe: '>=0.69.0', outputs: ['out'] }));
  fs.writeFileSync(path.join(dir, 'node.js'), 'module.exports = { run() { return 1; } };');
  const k = keys.add({ label: 'GIRAFE link', service: 'girafe', value: 'gk_' + 'a'.repeat(40) });
  fs.writeFileSync(path.join(WS, '.kit', 'girafe.json'), JSON.stringify({ keyId: k.id, base: process.env.KIT_GIRAFE_URL }));
  seen.length = 0;
  await assert.rejects(link.send('big'), (e) => e.code === 'girafe-behind');
  assert.ok(!seen.some((x) => x.url === '/api/kit/packages'));
});

test('GIRAFE from before the check, or offline: told, not blocked', async () => {
  girafeAnswer = { ...girafeAnswer, status: 404 };
  let s = await compat.status({ force: true });
  assert.ok(s.problems.some((p) => p.code === 'girafe-unknown'));
  assert.equal(await compat.beforeSend({ name: 'T', hostApi: 2 }), null, 'GIRAFE checks on arrival');
  girafeAnswer = { ...girafeAnswer, status: 200 };
  await compat.status({ force: true });
  const port = fake.address().port;
  process.env.KIT_GIRAFE_URL = 'http://127.0.0.1:1';
  s = await compat.status({ force: true });
  assert.ok(s.problems.some((p) => p.code === 'offline'));
  process.env.KIT_GIRAFE_URL = `http://127.0.0.1:${port}`;
});

test('zip: round trip, and bad names refused', () => {
  const z = zip.write([{ name: 'k/a.txt', data: 'hello' }, { name: 'k/b/c.sh', data: 'x', mode: 0o755 }]);
  const files = zip.read(z);
  assert.equal(files[0].data.toString(), 'hello');
  assert.equal(files[1].mode, 0o755);
  assert.throws(() => updater.unpack(zip.write([{ name: 'k/../evil', data: 'x' }])), /Refused|single top/);
  assert.throws(() => updater.unpack(zip.write([{ name: 'k/kit.js', data: 'x' }])), /missing/);
  const bad = Buffer.from(z); bad[40] ^= 0xff; // corrupt the first entry's data
  assert.throws(() => zip.read(bad));
});

// ---- end to end on a copy of the kit ----
const SKIP = new Set(['.git', 'workspace', 'node_modules', '.runtime']);
function copyKit(to) {
  for (const t of fs.readdirSync(KIT)) if (!SKIP.has(t)) fs.cpSync(path.join(KIT, t), path.join(to, t), { recursive: true });
  fs.mkdirSync(path.join(to, 'workspace', 'nodes'), { recursive: true });
}
function releaseZip(from, version, edit) {
  const files = [];
  const walk = (d, rel) => { for (const n of fs.readdirSync(d)) { if (!rel && SKIP.has(n)) continue; const p = path.join(d, n); const r = rel ? `${rel}/${n}` : n; if (fs.statSync(p).isDirectory()) walk(p, r); else files.push({ name: `girafe-node-kit-release/${r}`, data: fs.readFileSync(p) }); } };
  walk(from, '');
  for (const f of files) {
    const r = f.name.slice('girafe-node-kit-release/'.length);
    if (r === 'package.json') f.data = Buffer.from(f.data.toString().replace(/"version": "[^"]+"/, `"version": "${version}"`));
    if (r === 'kit/version.js') f.data = Buffer.from(f.data.toString().replace(/KIT_VERSION: '[^']+'/, `KIT_VERSION: '${version}'`));
    if (edit) edit(r, f);
  }
  files.push({ name: 'girafe-node-kit-release/NEW_FILE.txt', data: version });
  return zip.write(files);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function info(port) { try { return await (await fetch(`http://localhost:${port}/api/info`)).json(); } catch { return null; } }
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(250); } throw new Error('timed out'); }

test('update end to end: swap, restart, keep the workspace; a broken release is put back', { timeout: 90000 }, async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-copy-'));
  try {
    copyKit(T);
    fs.writeFileSync(path.join(T, 'workspace', 'nodes', 'mine.txt'), 'my work');
    const env = { ...process.env, GIRAFE_KIT_WORKSPACE: path.join(T, 'workspace'), PORT: String(47000 + Math.floor(Math.random() * 900)), CI: '1' };
    delete env.GIRAFE_KIT_CHILD;
    const kit = spawn(process.execPath, [path.join(T, 'kit.js'), '--no-open'], { env, stdio: 'pipe' });
    let out = ''; kit.stdout.on('data', (d) => { out += d; }); kit.stderr.on('data', (d) => { out += d; });
    try {
      const portFile = path.join(T, 'workspace', '.kit', 'port');
      const port = await until(() => fs.existsSync(portFile) && Number(fs.readFileSync(portFile, 'utf8')));
      assert.equal((await until(() => info(port))).kit, require('../kit/version').KIT_VERSION);

      // a good release
      release = { version: '9.9.9', zip: releaseZip(T, '9.9.9') };
      const r = await (await fetch(`http://localhost:${port}/api/update`, { method: 'POST' })).json();
      assert.equal(r.to, '9.9.9', JSON.stringify(r));
      assert.equal(r.restart, 'auto');
      await until(async () => (await info(port))?.kit === '9.9.9');
      assert.equal(fs.readFileSync(path.join(T, 'NEW_FILE.txt'), 'utf8'), '9.9.9');
      assert.equal(fs.readFileSync(path.join(T, 'workspace', 'nodes', 'mine.txt'), 'utf8'), 'my work', 'workspace untouched');
      const last = JSON.parse(fs.readFileSync(path.join(T, 'workspace', '.kit', 'update', 'last.json'), 'utf8'));
      assert.equal(last.ok, true);
      assert.ok(fs.readdirSync(path.join(T, 'workspace', '.kit', 'update')).some((d) => d.startsWith('backup-' + require('../kit/version').KIT_VERSION)));

      // a release that crashes on start: put back, 9.9.9 runs again
      release = { version: '9.9.10', zip: releaseZip(T, '9.9.10', (rel, f) => { if (rel === 'kit/server.js') f.data = Buffer.from('throw new Error("broken release");'); }) };
      const r2 = await (await fetch(`http://localhost:${port}/api/update`, { method: 'POST' })).json();
      assert.equal(r2.to, '9.9.10', JSON.stringify(r2));
      await until(async () => { const l = (() => { try { return JSON.parse(fs.readFileSync(path.join(T, 'workspace', '.kit', 'update', 'last.json'), 'utf8')); } catch { return null; } })(); return l && l.to === '9.9.10' && l.rolledBack; });
      assert.equal((await until(() => info(port))).kit, '9.9.9');
      assert.equal(fs.readFileSync(path.join(T, 'NEW_FILE.txt'), 'utf8'), '9.9.9');
      assert.doesNotMatch(fs.readFileSync(path.join(T, 'kit', 'server.js'), 'utf8'), /broken release/);
    } finally { kit.kill('SIGINT'); await new Promise((r) => kit.once('exit', r)); }
  } finally { fs.rmSync(T, { recursive: true, force: true }); release = null; }
});

test('a git clone with changed kit files is not updated by the kit', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-git-'));
  try {
    copyKit(T);
    const g = (...a) => execFileSync('git', ['-C', T, ...a], { stdio: 'pipe' });
    g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
    let m = await updater.method(T);
    assert.equal(m.mode, 'git');
    assert.match(m.why, /no upstream/);
    fs.appendFileSync(path.join(T, 'kit', 'server.js'), '\n// mine\n');
    m = await updater.method(T);
    assert.equal(m.ready, false);
    assert.match(m.why, /kit\/server\.js/);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('git clone: pull --ff-only, and rollback goes back to the previous commit', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-gitpull-'));
  try {
    const up = path.join(T, 'up'), work = path.join(T, 'work');
    fs.mkdirSync(up); copyKit(up);
    const g = (d, ...a) => execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
    g(up, 'init', '-q', '-b', 'release'); g(up, 'add', '.'); g(up, 'commit', '-qm', 'v1');
    execFileSync('git', ['clone', '-q', up, work]);
    const before = g(work, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(up, 'kit', 'version.js'), fs.readFileSync(path.join(up, 'kit', 'version.js'), 'utf8').replace(/KIT_VERSION: '[^']+'/, "KIT_VERSION: '9.1.0'"));
    g(up, 'commit', '-qam', 'v2');
    const r = await updater.start({ root: work });
    assert.equal(r.mode, 'git'); assert.equal(r.to, '9.1.0'); assert.equal(r.restart, 'manual');
    assert.notEqual(g(work, 'rev-parse', 'HEAD'), before);
    const back = await updater.rollback();
    assert.equal(back.error, null);
    assert.equal(g(work, 'rev-parse', 'HEAD'), before);
    assert.equal((await updater.start({ root: work })).to, '9.1.0', 'can pull again after a rollback');
    updater.confirm();
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

// ---------- Align with GIRAFE (0.13.0): the kit never checks against its own frozen guess ----------

test('local checks follow the live GIRAFE, not version.js, and unknown things only warn', async () => {
  girafeAnswer.body = { girafeVersion: '0.73.0', hostApi: 2, hostApis: [1, 2], minKit: '0.4.0', keyServices: ['gemini'], packs: 1, billing: 1, kit: { repo: 'x/y', branch: 'release' } };
  compat._reset();
  await compat.status({ force: true });
  const plugins = require('../kit/plugins');
  assert.equal(plugins.rules().girafeVersion, '0.73.0', 'what GIRAFE said, not version.js');
  assert.ok(plugins.rules().live);

  // A node asking for a GIRAFE newer than the live one: said, never blocked by the kit.
  const far = plugins.checkManifestFull({ id: 'a', name: 'A', version: '1.0.0', hostApi: 2, girafe: '>=9.9.9', inputs: { min: 0, max: 1 }, outputs: ['out'] }, 'a');
  assert.equal(far.problems.length, 0);
  assert.ok(far.warnings.some((w) => /9\.9\.9/.test(w)));

  // A field type this kit has never heard of: a warning, because GIRAFE may well know it.
  const odd = plugins.checkManifestFull({ id: 'b', name: 'B', version: '1.0.0', hostApi: 2, inputs: { min: 0, max: 1 }, outputs: ['out'], fields: [{ key: 'x', type: 'brandnew', label: 'X' }] }, 'b');
  assert.equal(odd.problems.length, 0);
  assert.ok(odd.warnings.some((w) => /brandnew/.test(w)));

  // Real mistakes still block.
  assert.ok(plugins.checkManifestFull({ id: 'c', name: 'C', version: 'x', hostApi: 2, inputs: { min: 0, max: 1 }, outputs: ['out'] }, 'c').problems.length);
});

test('align() reports one picture and raises a node version GIRAFE already holds', async () => {
  const plugins = require('../kit/plugins');
  const dir = path.join(WS, 'nodes', 'align-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'align-demo', name: 'Align demo', version: '1.0.0', hostApi: 2, inputs: { min: 0, max: 1 }, outputs: ['out'] }, null, 2));
  fs.writeFileSync(path.join(dir, 'node.js'), 'module.exports = { async run() { return { value: "x" }; } };\n');

  assert.ok(plugins.getPlugin('align-demo').changedAt, 'the kit knows when a node was last touched');

  release = { version: require('../kit/version').KIT_VERSION, zip: Buffer.alloc(0) };
  const r = await compat.align({});
  assert.equal(r.girafe.version, '0.73.0');
  assert.equal(r.kitOld, false);
  assert.ok(r.nodes.some((n) => n.id === 'align-demo'));
  assert.ok(r.steps.some((s) => s.level === 'ok' && /host API/.test(s.text)));

  // GIRAFE refuses the version it already has, once; the kit raises it and sends again.
  let asked = 0;
  packagesAnswer = (body) => (++asked === 1
    ? { status: 409, body: { code: 'version-not-higher', installed: '1.0.0', error: 'align-demo 1.0.0 is already in your account' } }
    : { status: 200, body: { ok: true, version: JSON.parse(body || '{}').manifest?.version } });
  try {
    await link.connect();
    for (let i = 0; i < 40 && !link.status().connected; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(link.status().connected, 'linked to the fake GIRAFE');
    const sentRun = await compat.align({ send: true });
    assert.equal(sentRun.picked, 'align-demo', 'the node touched last');
    assert.equal(asked, 2, 'refused once, sent again');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, '1.0.1');
    assert.ok(sentRun.steps.some((s2) => /version raised to 1\.0\.1/.test(s2.text)));
  } finally { packagesAnswer = () => ({ status: 200, body: { ok: true } }); fs.rmSync(dir, { recursive: true, force: true }); }
});
