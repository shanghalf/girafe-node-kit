// "tasks" field (host API 2): manifest rules, the service history (cursor pages, window, key) and
// the exported history file, read through the package's billing declaration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-tasks-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;

const HISTORY = {
  url: 'https://openapi.tripo3d.ai/v3/account/usage/history?start_time={start}&end_time={end}&page_size=100',
  items: 'data.items', next: 'data.next_cursor', cursorParam: 'cursor', maxDays: 31, ok: ['success'],
  fields: { taskId: 'task_id', units: 'credits_consumed', type: 'type', model: 'model_version', status: 'status', createdAt: 'created_at' },
};
const BILL = { service: 'tripo', unit: 'credit', units: 'credits', usdPerUnit: 0.01, history: HISTORY,
  csv: { taskId: 'task_id', units: 'credits', type: 'type', model: 'model_version', status: 'status', createdAt: 'create_time' } };
const caps = { keys: [{ slot: 'tripo', service: 'tripo' }], network: ['openapi.tripo3d.ai'] };
function plugin(id, manifest) {
  const dir = path.join(WS, 'nodes', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', hostApi: 2, girafe: '>=0.69.0', outputs: ['out'], capabilities: caps, billing: [BILL], ...manifest }));
  fs.writeFileSync(path.join(dir, 'node.js'), "module.exports = { async run() { return 'x'; } };");
}

let server; const seen = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ auth: req.headers.authorization, cursor: u.searchParams.get('cursor'), start: u.searchParams.get('start_time'), end: u.searchParams.get('end_time') });
    const page = u.searchParams.get('cursor') === 'c2'
      ? { items: [{ task_id: 'task-0003', type: 'animate_rig', model_version: 'v2.5', status: 'success', created_at: '2026-11-01T10:00:00Z', credits_consumed: 25 }], has_more: false, next_cursor: null }
      : { items: [{ task_id: 'task-0001', type: 'image_to_model', model_version: 'v3.1', status: 'success', created_at: '2026-11-05T10:00:00Z', credits_consumed: 30 },
        { task_id: 'task-0002', type: 'image_to_model', status: 'failed', created_at: '2026-11-04T10:00:00Z', credits_consumed: 0 }], has_more: true, next_cursor: 'c2' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, data: page }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.KIT_TRIPO_URL = `http://127.0.0.1:${server.address().port}/v3`;
});
test.after(() => { server.close(); fs.rmSync(WS, { recursive: true, force: true }); delete process.env.KIT_TRIPO_URL; });

test('a tasks field must name one of the node\'s key slots', () => {
  plugin('picker', { fields: [{ key: 'collect', type: 'tasks', label: 'Tasks', slot: 'tripo', types: ['image_to_model', ['animate_rig', 'Rigged']], multiple: true }] });
  plugin('bad-picker', { fields: [{ key: 'collect', type: 'tasks', slot: 'nope' }] });
  const plugins = require('../kit/plugins');
  assert.deepStrictEqual(plugins.getPlugin('picker').problems || [], []);
  assert.ok((plugins.getPlugin('bad-picker').problems || []).some((p) => /slot/.test(p)), JSON.stringify(plugins.getPlugin('bad-picker').problems));
});

test('the history is read page by page with the cursor, failed tasks left out', async () => {
  const keys = require('../kit/keys');
  const k = keys.add({ label: 'Tripo', service: 'tripo', value: 'tsk_test_12345678' });
  const st = require('../kit/service-tasks');
  const r = await st.fromService(BILL, k.id, '2026-11-10T00:00:00Z');
  assert.deepStrictEqual(r.tasks.map((t) => t.taskId), ['task-0001', 'task-0003']);
  assert.strictEqual(r.tasks[0].type, 'image_to_model');
  assert.strictEqual(r.tasks[1].units, 25);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].auth, 'Bearer tsk_test_12345678');
  assert.strictEqual(seen[1].cursor, 'c2');
  assert.strictEqual(r.to, '2026-11-10T00:00:00.000Z');
  assert.strictEqual(r.from, '2026-10-10T00:00:00.000Z');
});

test('the exported history file gives the same tasks', () => {
  const st = require('../kit/service-tasks');
  const csv = '"task_id","type","model_version","status","credits","client_id","create_time","end_time"\n'
    + '"a1b2c3d4-0001","image_to_model","v3.1-20260211","success","30","tcli_x","2026-11-05 10:00:00","2026-11-05 10:01:00"\n'
    + '"a1b2c3d4-0002","animate_prerigcheck","","success","0","tcli_x","2026-11-05 11:00:00",""\n'
    + '"a1b2c3d4-0003","convert_model","","failed","0","tcli_x","2026-11-05 12:00:00",""\n';
  const r = st.fromCsv(BILL, csv);
  assert.deepStrictEqual(r.tasks.map((t) => [t.taskId, t.type, t.units]), [['a1b2c3d4-0002', 'animate_prerigcheck', 0], ['a1b2c3d4-0001', 'image_to_model', 30]]);
  assert.throws(() => st.fromCsv(BILL, 'a,b\n1,2'), /task_id/);
});
