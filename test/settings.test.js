// The kit's own settings (kit/settings.js) and the update it does by itself (updater.auto).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-settings-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-settings-home-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
process.env.GIRAFE_KIT_HOME = HOME;
process.env.GIRAFE_KIT_NO_SIGNIN = '1';
const KIT = path.join(__dirname, '..');

// A fake GIRAFE and a fake release branch, so "is there a newer kit?" can be answered offline.
let release = null; // { version, zip }
const fake = http.createServer((req, res) => {
  req.resume();
  const json = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.url === '/api/kit/compat') return json(200, { girafeVersion: '0.92.0', hostApi: 2, hostApis: [0, 1, 2], minKit: '0.4.0', keyServices: [], kit: { repo: 'x/y', branch: 'release' } });
  if (req.url === '/rel/package.json') return release ? json(200, { name: 'girafe-node-kit', version: release.version, engines: { node: '>=22' } }) : json(404, {});
  if (req.url === '/rel/kit.zip') { if (!release) return json(404, {}); res.writeHead(200, { 'content-type': 'application/zip', 'content-length': release.zip.length }); return res.end(release.zip); }
  json(404, {});
});

let settings, updater, zip, server, base;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${fake.address().port}`;
  process.env.KIT_GIRAFE_URL = b;
  process.env.KIT_UPDATE_URL = b + '/rel';
  settings = require('../kit/settings');
  updater = require('../kit/updater');
  zip = require('../kit/zip');
  ({ server } = await require('../kit/server').start({ port: 0 }));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); fake.close(); fs.rmSync(WS, { recursive: true, force: true }); fs.rmSync(HOME, { recursive: true, force: true }); });

test('settings start sensible and are kept with your work, not with the kit folder', async () => {
  assert.deepEqual(settings.all(), { autoUpdate: true, autostart: false });
  settings.set({ autoUpdate: false });
  assert.equal(settings.all().autoUpdate, false);
  assert.ok(fs.existsSync(path.join(WS, '.kit', 'settings.json')), 'kept in the workspace');
  settings.set({ autoUpdate: true });
  assert.equal(settings.all().autoUpdate, true);
});

test('the page reads and writes them', async () => {
  const get = await (await fetch(base + '/api/kit-settings')).json();
  assert.equal(get.autoUpdate, true);
  assert.equal(get.autostart, false);
  assert.ok(get.kitDir);
  const set = await (await fetch(base + '/api/kit-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoUpdate: false }) })).json();
  assert.equal(set.autoUpdate, false);
  assert.equal((await (await fetch(base + '/api/kit-settings')).json()).autoUpdate, false);
  settings.set({ autoUpdate: true });
});

test('a git clone never updates itself', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-auto-git-'));
  try {
    fs.mkdirSync(path.join(T, '.git'));
    assert.equal(await updater.auto({ root: T }), null);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('an update that fails is written down once and never tried again by itself', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-auto-'));
  try {
    for (const t of fs.readdirSync(KIT)) if (!['.git', 'workspace', 'node_modules', '.runtime', 'test'].includes(t)) fs.cpSync(path.join(KIT, t), path.join(T, t), { recursive: true });
    // A "release" that is really an empty zip: the download fails where it is checked.
    release = { version: '99.9.9', zip: zip.write([{ name: 'girafe-node-kit-release/README.md', data: 'nothing' }]) };
    const bad = await updater.auto({ root: T });
    assert.equal(bad.ok, false);
    assert.equal(bad.version, '99.9.9');
    assert.equal(updater.autoFailed().version, '99.9.9');
    assert.equal(await updater.auto({ root: T }), null, 'the same version is never tried again');
    assert.ok(fs.existsSync(path.join(T, 'kit.js')), 'the kit it has is untouched');
  } finally { release = null; fs.rmSync(T, { recursive: true, force: true }); fs.rmSync(path.join(WS, '.kit', 'update', 'auto-failed.json'), { force: true }); }
});

test('nothing newer out: nothing happens', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-auto-same-'));
  try {
    for (const t of ['kit.js', 'kit', 'package.json']) fs.cpSync(path.join(KIT, t), path.join(T, t), { recursive: true });
    release = { version: '0.0.1', zip: Buffer.alloc(0) };
    assert.equal(await updater.auto({ root: T }), null);
  } finally { release = null; fs.rmSync(T, { recursive: true, force: true }); }
});
