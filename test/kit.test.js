// node --test test/   (uses a throwaway workspace; never touches yours)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ws-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const store = require('../kit/store');
const engine = require('../kit/engine');
const plugins = require('../kit/plugins');

function plugin(id, manifest, code) {
  const d = path.join(store.NODES, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id, name: id, version: '0.1.0', hostApi: 0, girafe: '>=0.67.0', outputs: ['out'], ...manifest }));
  fs.writeFileSync(path.join(d, 'node.js'), code);
}
const run = (graph, answers = []) => new Promise((resolve) => {
  const seen = new Set();
  const r = engine.createRun(graph, { onChange: (rs) => { for (const a of rs.asks) if (!seen.has(a.id)) { seen.add(a.id); setImmediate(() => r.answer(a.id, answers.shift() || 'yes')); } } });
  r.promise.then(resolve);
});

plugin('upper', {}, 'module.exports = { run: (ctx) => String(ctx.inputs.A).toUpperCase() };');
plugin('typed', { outputs: ['sum', 'big'] }, 'module.exports = { async run(ctx) { const s = ctx.inputs.A + ctx.inputs.B; return s > 10 ? { big: s } : { sum: s }; } };');
plugin('many', {}, 'module.exports = { async run(ctx) { for (const x of [1,2,3]) await ctx.emit("out", x); } };');
plugin('snoop', {}, 'module.exports = { run: () => require("fs").readFileSync("/etc/hostname", "utf8") };');
plugin('writer', {}, 'module.exports = { run: () => { require("fs").writeFileSync(__dirname + "/x", "1"); return "wrote"; } };');
plugin('envy', {}, 'module.exports = { run: () => JSON.stringify(process.env) };');
plugin('old', { hostApi: 9 }, 'module.exports = { run: () => 1 };');
plugin('future', { girafe: '>=9.0.0' }, 'module.exports = { run: () => 1 };');
plugin('boom', {}, 'module.exports = { run: () => { throw new Error("nope") } };');

test('For each runs a plugin once per item, Collect gathers them', async () => {
  const rs = await run({ nodes: [
    { id: 'i', type: 'input', value: '["a","b","c"]' }, { id: 'f', type: 'forEach' },
    { id: 'u', type: 'plugin:upper' }, { id: 'c', type: 'collect' }],
  wires: [{ id: 'w1', from: 'i', to: 'f' }, { id: 'w2', from: 'f', to: 'u' }, { id: 'w3', from: 'u', to: 'c' }] });
  assert.equal(rs.status, 'done');
  assert.equal(rs.nodes.u.firings, 3);
  assert.deepEqual(JSON.parse(rs.nodes.c.outputs[0]), ['A', 'B', 'C']);
});

test('inputs arrive typed, by letter, and named outputs route', async () => {
  const rs = await run({ nodes: [{ id: 'a', type: 'input', value: '4' }, { id: 'b', type: 'input', value: '9' },
    { id: 't', type: 'plugin:typed' }, { id: 's', type: 'collect' }, { id: 'g', type: 'collect' }],
  wires: [{ id: 'w1', from: 'a', to: 't' }, { id: 'w2', from: 'b', to: 't' }, { id: 'w3', from: 't', port: 'sum', to: 's' }, { id: 'w4', from: 't', port: 'big', to: 'g' }] });
  assert.equal(rs.nodes.g.outputs[0], '["13"]');
  assert.equal(rs.nodes.s.status, 'skipped');
});

test('a plugin emitting several packets becomes a stream', async () => {
  const rs = await run({ nodes: [{ id: 'm', type: 'plugin:many' }, { id: 'u', type: 'plugin:upper' }, { id: 'c', type: 'collect' }],
    wires: [{ id: 'w1', from: 'm', to: 'u' }, { id: 'w2', from: 'u', to: 'c' }] });
  assert.equal(rs.nodes.u.firings, 3);
});

test('Yes / No sends down the answered branch only', async () => {
  const rs = await run({ nodes: [{ id: 'i', type: 'input', value: '["x","y"]' }, { id: 'f', type: 'forEach' }, { id: 'q', type: 'ask', prompt: 'ok {{A}}?' },
    { id: 'y', type: 'collect' }, { id: 'n', type: 'collect' }],
  wires: [{ id: 'w1', from: 'i', to: 'f' }, { id: 'w2', from: 'f', to: 'q' }, { id: 'w3', from: 'q', port: 'yes', to: 'y' }, { id: 'w4', from: 'q', port: 'no', to: 'n' }] }, ['no', 'yes']);
  assert.equal(rs.nodes.y.outputs[0], '["y"]');
  assert.equal(rs.nodes.n.outputs[0], '["x"]');
});

test('the sandbox: no reading outside its folder, no writing, no environment', async () => {
  const g = (t) => ({ nodes: [{ id: 'p', type: 'plugin:' + t }], wires: [] });
  const snoop = await run(g('snoop'));
  assert.equal(snoop.nodes.p.status, 'error'); assert.match(snoop.nodes.p.note, /ERR_ACCESS_DENIED|permission|access/i);
  const writer = await run(g('writer'));
  assert.equal(writer.nodes.p.status, 'error');
  const envy = await run(g('envy'));
  assert.ok(!/GIRAFE_KIT_WORKSPACE|PATH/.test(envy.nodes.p.outputs[0]), 'no host environment leaks');
});

test('a host API the kit cannot run is a problem; a GIRAFE it cannot reach yet is only a warning', async () => {
  const list = plugins.listPlugins();
  // The kit's own runtime: nothing here can run host API 9, so it refuses.
  assert.match(list.find((p) => p.id === 'old').problems.join(), /host API/);
  const rs = await run({ nodes: [{ id: 'p', type: 'plugin:old' }], wires: [] });
  assert.equal(rs.nodes.p.status, 'error');
  // Needing a newer GIRAFE is GIRAFE's business, not the kit's: it is said, and the node still runs,
  // so a node can be built and tried before the GIRAFE that will take it exists.
  const future = list.find((p) => p.id === 'future');
  assert.equal(future.problems.length, 0);
  assert.match(future.warnings.join(), /needs GIRAFE/);
  const ok = await run({ nodes: [{ id: 'p', type: 'plugin:future' }], wires: [] });
  assert.notEqual(ok.nodes.p.status, 'error');
});

test('a failing node stops only its own branch', async () => {
  const rs = await run({ nodes: [{ id: 'b', type: 'plugin:boom' }, { id: 'c', type: 'collect' }, { id: 'i', type: 'input', value: 'ok' }, { id: 'd', type: 'collect' }],
    wires: [{ id: 'w1', from: 'b', to: 'c' }, { id: 'w2', from: 'i', to: 'd' }] });
  assert.equal(rs.nodes.b.note, 'nope');
  assert.equal(rs.nodes.c.status, 'skipped');
  assert.equal(rs.nodes.d.status, 'done');
});

test('flow socket: a node runs only when its flow wire delivers; one output feeds every wire', async () => {
  const rs = await run({ nodes: [{ id: 'i', type: 'input', value: 'hello' }, { id: 'q', type: 'ask', prompt: 'go?' },
    { id: 'u', type: 'plugin:upper' }, { id: 'v', type: 'plugin:upper' }, { id: 'c', type: 'collect' }],
  wires: [{ id: 'w1', from: 'i', port: 'out', to: 'q' }, { id: 'w2', from: 'q', port: 'no', to: 'u', flow: true },
    { id: 'w3', from: 'i', port: 'out', to: 'u' }, { id: 'w4', from: 'i', port: 'B', to: 'v' }, { id: 'w5', from: 'v', to: 'c' }] }, ['yes']);
  assert.equal(rs.nodes.u.status, 'skipped');
  assert.match(rs.nodes.u.note, /flow socket/);
  assert.equal(rs.nodes.v.outputs[0], 'HELLO', 'a lettered output socket carries the node\'s output');
  assert.equal(rs.wires.w2.state, 'dead');
  assert.equal(rs.wires.w4.state, 'delivered');
});

test.after(() => fs.rmSync(WS, { recursive: true, force: true }));
