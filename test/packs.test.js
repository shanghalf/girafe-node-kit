// Packs: pack.json rules, membership, the pack's single key, the .gpack package and its checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-packs-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const KEY = 'tsk_FAKE_TRIPO_KEY_0123456789abcdefghij';

function plugin(id, manifest = {}, code = "module.exports = { async run(ctx) { return ctx.inputs.A || 'x'; } };") {
  const dir = path.join(WS, 'nodes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', hostApi: 2, girafe: '>=0.69.0', outputs: ['out'], ...manifest }));
  fs.writeFileSync(path.join(dir, 'node.js'), code);
}
const writePack = (id, p) => { fs.mkdirSync(path.join(WS, 'nodes', id), { recursive: true }); fs.writeFileSync(path.join(WS, 'nodes', id, 'pack.json'), JSON.stringify(p)); };
const tripoCaps = { keys: [{ slot: 'tripo', service: 'tripo' }], network: ['openapi.tripo3d.ai'] };

let packs, plugins, pkgs, keys;
test.before(() => {
  packs = require('../kit/packs'); plugins = require('../kit/plugins'); pkgs = require('../kit/package'); keys = require('../kit/keys');
  plugin('make-a', { capabilities: tripoCaps });
  plugin('make-b', { capabilities: tripoCaps });
  plugin('loose');
  writePack('demo-pack', { id: 'demo-pack', name: 'Demo pack', version: '0.1.0', nodes: ['make-a', 'make-b'], keys: [{ slot: 'tripo', service: 'tripo', label: 'Tripo key' }] });
});
test.after(() => fs.rmSync(WS, { recursive: true, force: true }));

test('a pack folder is not a node; its nodes say which pack they are in', () => {
  const list = plugins.listPlugins();
  assert.ok(!list.some((p) => p.id === 'demo-pack'));
  assert.equal(list.find((p) => p.id === 'make-a').pack, 'demo-pack');
  assert.equal(list.find((p) => p.id === 'loose').pack, null);
  const pk = packs.getPack('demo-pack');
  assert.deepEqual(pk.problems, []);
  assert.deepEqual(pk.nodes, ['make-a', 'make-b']);
});

test('pack rules', () => {
  const nodes = { 'make-a': { capabilities: tripoCaps }, loose: { capabilities: {} } };
  const ok = { id: 'p', name: 'P', version: '1.0.0', nodes: ['make-a'], keys: [{ slot: 'tripo', service: 'tripo' }] };
  assert.deepEqual(packs.checkPack(ok, 'p', nodes), []);
  assert.ok(packs.checkPack({ ...ok, keys: [] }, 'p', nodes).some((x) => /one key for the whole pack/.test(x)));
  assert.ok(packs.checkPack({ ...ok, keys: [{ slot: 'tripo', service: 'gemini' }] }, 'p', nodes).some((x) => /but tripo/.test(x)));
  assert.ok(packs.checkPack({ ...ok, nodes: ['nope'] }, 'p', nodes).some((x) => /no node "nope"/.test(x)));
  assert.ok(packs.checkPack({ ...ok, nodes: ['make-a', 'make-a'] }, 'p', nodes).some((x) => /twice/.test(x)));
  assert.ok(packs.checkPack(ok, 'q', nodes).some((x) => /folder name/.test(x)));
  assert.ok(packs.checkPack({ ...ok, version: '1' }, 'p', nodes).some((x) => /version/.test(x)));
  assert.ok(packs.checkPack(ok, 'p', nodes, { 'make-a': 'other' }).some((x) => /already in the pack/.test(x)));
});

test('one key for the whole pack: members run with it, others keep their own', () => {
  const id = keys.add({ label: 'Tripo', value: KEY }).id;
  packs.setKey('demo-pack', 'tripo', id);
  assert.deepEqual(packs.keySlotsFor('make-a', { tripo: 'other' }), { tripo: id });
  assert.deepEqual(packs.keySlotsFor('make-b', undefined), { tripo: id });
  assert.deepEqual(packs.keySlotsFor('loose', { x: 'mine' }), { x: 'mine' });
  const stored = fs.readFileSync(path.join(WS, '.kit', 'pack-keys.json'), 'utf8');
  assert.ok(!stored.includes(KEY), 'only the key id is stored with the pack');
});

test('a .gpack holds every node, is signed, and is refused when changed', () => {
  const r = pkgs.packPack('demo-pack');
  assert.equal(r.name, 'demo-pack-0.1.0.gpack');
  const v = pkgs.verifyPack(JSON.parse(fs.readFileSync(r.file, 'utf8')));
  assert.deepEqual(v.nodes.map((n) => n.id), ['make-a', 'make-b']);
  const bad = structuredClone(r.pkg); bad.nodes.pop();
  assert.throws(() => pkgs.verifyPack(bad), /don't match|hash/);
  const swapped = structuredClone(r.pkg); swapped.version = '9.9.9';
  assert.throws(() => pkgs.verifyPack(swapped), /disagree/);
  const forged = structuredClone(r.pkg); forged.hash = forged.hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  assert.throws(() => pkgs.verifyPack(forged), /hash/);
});

test('a node in a pack is not sent on its own', async () => {
  const link = require('../kit/girafe-link');
  fs.mkdirSync(path.join(WS, '.kit'), { recursive: true });
  fs.writeFileSync(path.join(WS, '.kit', 'girafe.json'), JSON.stringify({ keyId: 'k-0000000000' }));
  await assert.rejects(link.send('make-a'), /part of the pack "demo-pack"/);
});
