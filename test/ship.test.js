// Ship: where a node or pack stands in its four places, what version it should become, and the
// three steps in order. The matrix and the bump rule are pure, so most of this needs no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ship-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;

const ship = require('../kit/ship');
const store = require('../kit/store');

function node(id, version = '1.0.0', extra = {}) {
  const dir = path.join(store.NODES, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version, hostApi: 2, girafe: '>=0.69.0', outputs: ['out'], ...extra }, null, 2));
  fs.writeFileSync(path.join(dir, 'node.js'), "module.exports = { async run(ctx) { return ctx.inputs.A || 'x'; } };");
  return dir;
}
function pack(id, version, members) {
  const dir = path.join(store.NODES, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id, name: id, version, nodes: members }, null, 2));
  return dir;
}

test('the matrix: a target with the same files is current, an older one is behind', () => {
  node('ship-a', '1.2.0');
  const h = ship.here('ship-a');
  assert.equal(h.kind, 'node');
  assert.equal(h.version, '1.2.0');
  assert.ok(h.hash && h.hash.length >= 16);

  const m = ship.matrix(h, {
    github: { connected: true, nodes: { 'ship-a': { state: 'clean' } } },
    girafe: { nodes: [{ id: 'ship-a', version: '1.2.0', hash: h.hash }], packs: [] },
    market: { submissions: [{ packageId: 'ship-a', status: 'approved', item: { id: 'i1', version: '1.1.0', status: 'live' } }] },
  });
  assert.equal(m.targets.github.state, 'current');
  assert.equal(m.targets.girafe.state, 'current');
  assert.equal(m.targets.market.state, 'behind');
  // Nothing forces a rise, and the person asked for none.
  assert.deepEqual(ship.plan(h, m, 'none').rise, false);
  assert.equal(ship.plan(h, m, 'none').version, '1.2.0');
});

test('the matrix: nothing set up here says off, never missing', () => {
  const h = ship.here('ship-a');
  const m = ship.matrix(h, {});
  assert.equal(m.targets.github.state, 'off');
  assert.equal(m.targets.girafe.state, 'off');
  assert.equal(m.targets.market.state, 'off');
});

test('the matrix: a target that has never had it is missing; a newer one is ahead', () => {
  const h = ship.here('ship-a');
  const m = ship.matrix(h, {
    github: { connected: true, nodes: { 'ship-a': { state: 'new' } } },
    girafe: { nodes: [], packs: [] },
    market: { submissions: [] },
  });
  assert.equal(m.targets.github.state, 'missing');
  assert.equal(m.targets.girafe.state, 'missing');
  assert.equal(m.targets.market.state, 'missing');

  const ahead = ship.matrix(h, { girafe: { nodes: [{ id: 'ship-a', version: '2.0.0', hash: 'other' }], packs: [] } });
  assert.equal(ahead.targets.girafe.state, 'ahead');
});

test('the matrix: a version in review shows as waiting, with its number', () => {
  const h = ship.here('ship-a');
  const m = ship.matrix(h, { market: { submissions: [{ packageId: 'ship-a', status: 'pending', version: '1.2.0', item: null }] } });
  assert.equal(m.targets.market.state, 'waiting');
  assert.equal(m.targets.market.version, '1.2.0');
});

test('the bump rule: the same number with different files forces a rise, even on "none"', () => {
  const h = ship.here('ship-a');
  const m = ship.matrix(h, { girafe: { nodes: [{ id: 'ship-a', version: '1.2.0', hash: 'DIFFERENT' }], packs: [] } });
  assert.equal(m.targets.girafe.state, 'behind');
  assert.equal(m.targets.girafe.sameNumber, true);
  const p = ship.plan(h, m, 'none');
  assert.equal(p.forced, true);
  assert.deepEqual(p.forcedBy, ['girafe']);
  assert.equal(p.version, '1.2.1', 'a forced rise is the smallest one: patch');
});

test('the bump rule: the new number is above the highest any target knows', () => {
  const h = ship.here('ship-a'); // 1.2.0 here
  const m = ship.matrix(h, { market: { submissions: [{ packageId: 'ship-a', status: 'approved', item: { id: 'i', version: '3.4.5', status: 'live' } }] } });
  assert.equal(ship.plan(h, m, 'patch').version, '3.4.6');
  assert.equal(ship.plan(h, m, 'minor').version, '3.5.0');
  assert.equal(ship.plan(h, m, 'major').version, '4.0.0');
});

test('a pack: only the members whose files changed move', () => {
  node('ship-m1', '2.0.0');
  node('ship-m2', '1.0.0');
  pack('ship-pack', '0.4.0', ['ship-m1', 'ship-m2']);
  const h = ship.here('ship-pack');
  assert.equal(h.kind, 'pack');
  assert.equal(h.members.length, 2);

  const m2hash = h.members.find((x) => x.id === 'ship-m2').hash;
  const m = ship.matrix(h, {
    girafe: {
      packs: [{ id: 'ship-pack', version: '0.4.0', hash: 'OLD' }],
      nodes: [
        { id: 'ship-m1', version: '2.0.0', hash: 'CHANGED' }, // same number, other files
        { id: 'ship-m2', version: '1.0.0', hash: m2hash },    // byte-identical: must not move
      ],
    },
  });
  const p = ship.plan(h, m, 'patch');
  assert.equal(p.version, '0.4.1');
  assert.deepEqual(p.members, [{ id: 'ship-m1', from: '2.0.0', to: '2.0.1' }]);
});

test('setVersion keeps the rest of the file, addChangelog writes the entry on top', () => {
  const dir = node('ship-edit', '0.1.0', { description: 'keep me' });
  ship.setVersion(dir, 'manifest.json', '0.2.0');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(man.version, '0.2.0');
  assert.equal(man.description, 'keep me', 'the rest of the manifest is untouched');

  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# ship-edit\n\n## 0.1.0 - 2026-01-01\n\n- the first one\n');
  ship.addChangelog(dir, '0.2.0', 'Reads the price too.', '2026-11-11');
  const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /## 0\.2\.0 - 2026-11-11\n\n- Reads the price too\./);
  assert.ok(log.indexOf('## 0.2.0') < log.indexOf('## 0.1.0'), 'newest first');
  assert.match(log, /# ship-edit/, 'the title stays on top');

  // No CHANGELOG.md yet: one is made, with the node's own title.
  const fresh = node('ship-fresh', '1.0.0');
  ship.addChangelog(fresh, '1.0.1', 'First note.', '2026-11-11');
  assert.match(fs.readFileSync(path.join(fresh, 'CHANGELOG.md'), 'utf8'), /## 1\.0\.1 - 2026-11-11\n\n- First note\./);
});

test('ship(): the three steps run in order and stop at the first failure', async () => {
  node('ship-run', '1.0.0');
  const calls = [];
  const deps = {
    github: {
      status: async () => ({ connected: true, nodes: { 'ship-run': { state: 'changed' } } }),
      save: async (o) => { calls.push(['github', o.id, o.message]); },
    },
    girafeLink: { send: async (id, o) => { calls.push(['girafe', id, o.notes]); return { version: '1.0.1' }; }, sendPack: async () => { throw new Error('not a pack'); } },
    marketLink: { submit: async (id, o) => { calls.push(['market', id, o.kind, o.notes]); return { submission: { status: 'pending' } }; } },
    girafePlugins: async () => ({ nodes: [{ id: 'ship-run', version: '1.0.0', hash: 'OLD' }], packs: [] }),
    marketSubmissions: async () => ({ submissions: [] }),
  };
  const r = await ship.ship('ship-run', { bump: 'patch', notes: 'Now reads the price.', deps });
  assert.equal(r.stoppedAt, null);
  assert.equal(r.plan.version, '1.0.1');
  assert.deepEqual(calls.map((c) => c[0]), ['github', 'girafe', 'market']);
  assert.equal(calls[2][2], 'node');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.NODES, 'ship-run', 'manifest.json'), 'utf8')).version, '1.0.1');
  assert.match(fs.readFileSync(path.join(store.NODES, 'ship-run', 'CHANGELOG.md'), 'utf8'), /Now reads the price\./);

  // GitHub refuses: GIRAFE and the market are never called, and the step says which failed.
  node('ship-stop', '1.0.0');
  const calls2 = [];
  const bad = { ...deps, github: { status: async () => ({ connected: true, nodes: { 'ship-stop': { state: 'changed' } } }), save: async () => { throw new Error('nothing to push'); } },
    girafeLink: { send: async () => { calls2.push('girafe'); return {}; } },
    marketLink: { submit: async () => { calls2.push('market'); return {}; } },
    girafePlugins: async () => ({ nodes: [], packs: [] }) };
  const r2 = await ship.ship('ship-stop', { bump: 'patch', notes: '', deps: bad });
  assert.equal(r2.stoppedAt, 'github');
  assert.deepEqual(calls2, []);
  assert.equal(r2.steps.find((s) => s.target === 'github').error, 'nothing to push');
});

test('ship(): targets the person left out are not touched', async () => {
  node('ship-one', '1.0.0');
  const calls = [];
  const deps = {
    github: { status: async () => { calls.push('github-status'); return { connected: true, nodes: {} }; }, save: async () => { calls.push('github-save'); } },
    girafeLink: { send: async () => { calls.push('girafe'); return {}; } },
    marketLink: { submit: async () => { calls.push('market'); return {}; } },
    girafePlugins: async () => { calls.push('plugins'); return { nodes: [], packs: [] }; },
    marketSubmissions: async () => { calls.push('subs'); return { submissions: [] }; },
  };
  const r = await ship.ship('ship-one', { bump: 'patch', targets: ['girafe'], deps });
  assert.equal(r.stoppedAt, null);
  assert.ok(calls.includes('girafe'));
  assert.ok(!calls.includes('github-save'), 'GitHub was not asked to save');
  assert.ok(!calls.includes('market'), 'the market was not asked');
  assert.ok(!calls.includes('subs'), 'and its state was not even read');
});

test('a target that does not say which files it holds is taken at its word', () => {
  node('ship-unsure', '1.0.0');
  const h = ship.here('ship-unsure');
  const m = ship.matrix(h, { market: { submissions: [{ packageId: 'ship-unsure', status: 'approved', item: { id: 'i', version: '1.0.0', hash: null, status: 'live' } }] } });
  assert.equal(m.targets.market.state, 'current');
  assert.equal(m.targets.market.unsure, true);
  assert.equal(ship.plan(h, m, 'none').forced, false, 'nothing is forced by a guess');
});
