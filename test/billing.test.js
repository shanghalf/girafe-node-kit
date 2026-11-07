// Billing: the "billing" rules (node manifest and pack.json), and ctx.usage checked by the kit and
// shown in the node's log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-billing-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;

const TRIPO = {
  service: 'tripo', unit: 'credit', units: 'credits', usdPerUnit: 0.01,
  balance: { url: 'https://openapi.tripo3d.ai/v3/account/balance', left: 'data.balance', held: 'data.frozen' },
  history: { url: 'https://openapi.tripo3d.ai/v3/account/usage/history?start_time={start}&end_time={end}&page_num={page}', items: 'data.items', fields: { taskId: 'task_id', units: 'credits_consumed' } },
  csv: { taskId: 'task_id', units: 'credits' },
};
const caps = { keys: [{ slot: 'tripo', service: 'tripo' }], network: ['openapi.tripo3d.ai'] };
function plugin(id, manifest, code) {
  const dir = path.join(WS, 'nodes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', hostApi: 2, girafe: '>=0.69.0', outputs: ['out'], capabilities: caps, ...manifest }));
  fs.writeFileSync(path.join(dir, 'node.js'), code || "module.exports = { async run(ctx) { return 'x'; } };");
}
const writePack = (id, p) => { fs.mkdirSync(path.join(WS, 'nodes', id), { recursive: true }); fs.writeFileSync(path.join(WS, 'nodes', id, 'pack.json'), JSON.stringify(p)); };

let plugins, packs, billing;
test.before(() => {
  plugins = require('../kit/plugins'); packs = require('../kit/packs'); billing = require('../kit/billing');
  plugin('spender', { billing: [TRIPO] }, `module.exports = { async run(ctx) {
    const r = await ctx.usage({ service: 'tripo', units: 25, taskId: 'task-0001', type: 'animate_rig' });
    let refused = '';
    try { await ctx.usage({ service: 'gemini', units: 1 }); } catch (e) { refused = e.message; }
    return JSON.stringify({ usd: r.usd, refused });
  } };`);
  plugin('pack-member', {}, "module.exports = { async run(ctx) { return JSON.stringify(await ctx.usage({ service: 'tripo', units: 3 })); } };");
  writePack('pay-pack', { id: 'pay-pack', name: 'Pay pack', version: '0.1.0', nodes: ['pack-member'], keys: [{ slot: 'tripo', service: 'tripo' }], billing: [TRIPO] });
});
test.after(() => fs.rmSync(WS, { recursive: true, force: true }));

test('billing rules: accepted as written, refused when it would send the key elsewhere or lacks basics', () => {
  assert.deepEqual(plugins.listPlugins().find((p) => p.id === 'spender').problems, []);
  const bad = (b) => billing.checkBilling([{ ...TRIPO, ...b }], ['tripo'], '')[0] || '';
  assert.match(bad({ balance: { url: 'https://evil.example.com/b', left: 'data.balance' } }), /must go to openapi\.tripo3d\.ai/);
  assert.match(bad({ usdPerUnit: 'cheap' }), /usdPerUnit/);
  assert.match(bad({ service: 'openai' }), /no key slot/);
  assert.match(bad({ history: { ...TRIPO.history, url: TRIPO.history.url + '&k={key}' } }), /\{start\}/);
  assert.deepEqual(packs.getPack('pay-pack').problems, []);
});

test('ctx.usage: priced from the node billing, logged, an undeclared service refused', async () => {
  const p = plugins.getPlugin('spender');
  const r = await plugins.runPlugin(p, { inputs: {}, settings: {}, keySlots: {}, title: 'T' });
  const out = (typeof r.outputs[0].value === "string" ? JSON.parse(r.outputs[0].value) : r.outputs[0].value);
  assert.equal(out.usd, 0.25);
  assert.match(out.refused, /not in the package's "billing"/);
  assert.ok(r.logs.some((l) => /💲 tripo: 25 credits \(≈ \$0\.25\) · task task-0001/.test(l)));
});

test('ctx.usage in a pack member uses the pack billing', async () => {
  const r = await plugins.runPlugin(plugins.getPlugin('pack-member'), { inputs: {}, settings: {}, keySlots: {}, title: 'T' });
  assert.deepEqual((typeof r.outputs[0].value === "string" ? JSON.parse(r.outputs[0].value) : r.outputs[0].value), { recorded: true, usd: 0.03 });
});
