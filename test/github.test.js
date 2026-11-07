// Your nodes on GitHub (kit/github.js), against a fake GitHub that stores real git objects.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-github-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
fs.cpSync(path.join(__dirname, '..', 'workspace', 'nodes', 'gemini-image'), path.join(WS, 'nodes', 'gemini-image'), { recursive: true });

const TOKEN = 'github_pat_FAKE_TOKEN_0123456789abcdefghijklmnop';
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const G = { blobs: {}, trees: {}, commits: {}, ref: null, private: true, push: true, seen: [] };
const hex = () => crypto.randomBytes(20).toString('hex');
function putTree(map) { const sha = crypto.createHash('sha1').update(JSON.stringify(Object.entries(map).sort())).digest('hex'); G.trees[sha] = { ...map }; return sha; }
function commit(treeMap, message, parent) { const sha = hex(); G.commits[sha] = { tree: putTree(treeMap), parents: parent ? [parent] : [], message, date: new Date().toISOString() }; return sha; }
// "Another computer" writes straight into the fake repo.
function pushFromElsewhere(rel, text, message = 'from my other computer') {
  const buf = Buffer.from(text); const sha = blobSha(buf); G.blobs[sha] = buf;
  const map = { ...G.trees[G.commits[G.ref].tree], [rel]: sha };
  G.ref = commit(map, message, G.ref);
}

const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    G.seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: b });
    const j = b ? JSON.parse(b) : {};
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (!req.headers['user-agent']) return send(403, { message: 'no user agent' });
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace('/repos/alf/my-nodes', '');
    if (!u.pathname.startsWith('/repos/alf/my-nodes')) return send(404, { message: 'Not Found' });
    if (req.method === 'GET' && p === '') return send(200, { private: G.private, default_branch: 'main', permissions: { push: G.push } });
    if (req.method === 'GET' && p === '/git/ref/heads/main') return G.ref ? send(200, { object: { sha: G.ref } }) : send(409, { message: 'Git Repository is empty.' });
    if (req.method === 'PUT' && p === '/contents/README.md') {
      if (G.ref) return send(422, { message: 'exists' });
      const buf = Buffer.from(j.content, 'base64'); const sha = blobSha(buf); G.blobs[sha] = buf;
      G.ref = commit({ 'README.md': sha }, j.message, null);
      return send(201, { commit: { sha: G.ref } });
    }
    let m;
    if (req.method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(p))) { const c = G.commits[m[1]]; return c ? send(200, { sha: m[1], tree: { sha: c.tree } }) : send(404, { message: 'Not Found' }); }
    if (req.method === 'GET' && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(p))) { const t = G.trees[m[1]]; return send(200, { truncated: false, tree: Object.entries(t).map(([path, sha]) => ({ path, sha, type: 'blob', mode: '100644' })) }); }
    if (req.method === 'GET' && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(p))) return send(200, { content: G.blobs[m[1]].toString('base64'), encoding: 'base64' });
    if (req.method === 'POST' && p === '/git/blobs') { const buf = Buffer.from(j.content, 'base64'); const sha = blobSha(buf); G.blobs[sha] = buf; return send(201, { sha }); }
    if (req.method === 'POST' && p === '/git/trees') {
      const map = { ...G.trees[j.base_tree] };
      for (const e of j.tree) { if (e.sha === null) delete map[e.path]; else { assert.ok(G.blobs[e.sha], 'tree points to a blob GitHub has'); map[e.path] = e.sha; } }
      return send(201, { sha: putTree(map) });
    }
    if (req.method === 'POST' && p === '/git/commits') { const sha = hex(); G.commits[sha] = { tree: j.tree, parents: j.parents, message: j.message, date: new Date().toISOString() }; return send(201, { sha }); }
    if (req.method === 'PATCH' && p === '/git/refs/heads/main') {
      if (!j.force && !G.commits[j.sha].parents.includes(G.ref)) return send(422, { message: 'Update is not a fast forward' });
      G.ref = j.sha; return send(200, { object: { sha: j.sha } });
    }
    if (req.method === 'GET' && p === '/commits') {
      const want = u.searchParams.get('path') + '/';
      const out = []; let c = G.ref;
      while (c) {
        const cur = G.commits[c]; const par = cur.parents[0] ? G.commits[cur.parents[0]] : null;
        const pick = (t) => JSON.stringify(Object.entries(G.trees[t]).filter(([k]) => k.startsWith(want)).sort());
        if (pick(cur.tree) !== (par ? pick(par.tree) : '[]')) out.push({ sha: c, html_url: 'https://github.com/x', commit: { message: cur.message, author: { name: 'Alf', date: cur.date } } });
        c = cur.parents[0];
      }
      return send(200, out);
    }
    send(404, { message: 'Not Found' });
  });
});

let gh, keys, netguard, keyId;
const NODE = path.join(WS, 'nodes', 'gemini-image');
test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.KIT_GITHUB_URL = `http://127.0.0.1:${fake.address().port}`;
  gh = require('../kit/github'); keys = require('../kit/keys'); netguard = require('../kit/netguard');
  keyId = keys.add({ label: 'My nodes repo', value: TOKEN }).id;
});
test.after(() => { fake.close(); fs.rmSync(WS, { recursive: true, force: true }); });

test('a pasted GitHub token is recognised', () => {
  assert.equal(keys.list().find((k) => k.id === keyId).service, 'github');
});

test('connect refuses a public repo unless confirmed, and a token that cannot write', async () => {
  G.private = false;
  await assert.rejects(gh.connect({ keyId, repo: 'alf/my-nodes' }), (e) => e.code === 'public');
  G.private = true; G.push = false;
  await assert.rejects(gh.connect({ keyId, repo: 'https://github.com/alf/my-nodes.git' }), /not write/);
  G.push = true;
  await assert.rejects(gh.connect({ keyId, repo: 'alf/someone-else' }), /doesn't show/);
  const st = await gh.connect({ keyId, repo: 'https://github.com/alf/my-nodes' });
  assert.equal(st.connected, true);
  assert.equal(st.private, true);
  assert.equal(st.nodes['gemini-image'].state, 'new');
});

test('save starts an empty repo, uploads only the node folder, and is then clean', async () => {
  const r = await gh.save({ id: 'gemini-image', message: 'First save' });
  assert.ok(r.commit);
  const files = Object.keys(G.trees[G.commits[G.ref].tree]);
  assert.ok(files.includes('README.md'));
  assert.ok(files.includes('nodes/gemini-image/manifest.json'));
  assert.ok(files.every((f) => f === 'README.md' || f.startsWith('nodes/gemini-image/')), 'nothing outside the node folder');
  assert.equal((await gh.status({ remote: true })).nodes['gemini-image'].state, 'clean');
  // saving again with nothing changed sends no commit
  const before = G.ref;
  assert.equal((await gh.save({ id: 'gemini-image' })).nothing, true);
  assert.equal(G.ref, before);
});

test('a change here pulses as changed, shows in the diff, and saves', async () => {
  fs.appendFileSync(path.join(NODE, 'node.js'), '\n// a new line\n');
  assert.equal((await gh.status()).nodes['gemini-image'].state, 'changed');
  const d = await gh.diff({ id: 'gemini-image' });
  assert.equal(d.files[0].file, 'node.js');
  assert.ok(d.files[0].lines.some((l) => l.t === '+' && l.s === '// a new line'));
  await gh.save({ id: 'gemini-image', message: 'Add a comment' });
  assert.equal((await gh.status({ remote: true })).nodes['gemini-image'].state, 'clean');
});

test('a newer version on GitHub: behind, save refused, update fetches it', async () => {
  pushFromElsewhere('nodes/gemini-image/NOTES.md', 'from the other computer\n');
  assert.equal((await gh.status({ remote: true })).nodes['gemini-image'].state, 'behind');
  await assert.rejects(gh.save({ id: 'gemini-image' }), (e) => e.code === 'behind');
  const r = await gh.update({ id: 'gemini-image' });
  assert.equal(r.backup, null, 'no backup needed: nothing changed here');
  assert.equal(fs.readFileSync(path.join(NODE, 'NOTES.md'), 'utf8'), 'from the other computer\n');
  assert.equal(r.status.nodes['gemini-image'].state, 'clean');
});

test('changed on both sides: conflict; taking GitHub keeps a backup of mine', async () => {
  fs.writeFileSync(path.join(NODE, 'NOTES.md'), 'mine\n');
  pushFromElsewhere('nodes/gemini-image/NOTES.md', 'theirs\n');
  assert.equal((await gh.status({ remote: true })).nodes['gemini-image'].state, 'conflict');
  await assert.rejects(gh.save({ id: 'gemini-image' }), (e) => e.code === 'conflict');
  const r = await gh.update({ id: 'gemini-image' });
  assert.ok(r.backup);
  assert.equal(fs.readFileSync(path.join(WS, r.backup, 'NOTES.md'), 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(NODE, 'NOTES.md'), 'utf8'), 'theirs\n');
  // and "save mine over it" works
  fs.writeFileSync(path.join(NODE, 'NOTES.md'), 'mine again\n');
  pushFromElsewhere('nodes/gemini-image/NOTES.md', 'theirs again\n');
  await gh.status({ remote: true });
  await gh.save({ id: 'gemini-image', mine: true, message: 'Keep mine' });
  assert.equal(G.blobs[G.trees[G.commits[G.ref].tree]['nodes/gemini-image/NOTES.md']].toString(), 'mine again\n');
});

test('a file holding something that looks like a key is never uploaded', async () => {
  const before = G.ref; const blobs = Object.keys(G.blobs).length;
  fs.writeFileSync(path.join(NODE, 'oops.js'), `const key = "AIza${'x'.repeat(35)}";\n`);
  await assert.rejects(gh.save({ id: 'gemini-image' }), (e) => e.code === 'secret' && /oops\.js line 1/.test(e.message));
  assert.equal(G.ref, before);
  assert.equal(Object.keys(G.blobs).length, blobs, 'not even sent as a blob');
  fs.rmSync(path.join(NODE, 'oops.js'));
});

test('history lists versions; restore puts an older one back as a change', async () => {
  const { commits } = await gh.history({ id: 'gemini-image' });
  assert.ok(commits.length >= 4);
  const first = commits[commits.length - 1];
  assert.equal(first.message, 'First save');
  const r = await gh.restore({ id: 'gemini-image', commit: first.sha });
  assert.equal(r.backup, null, 'what was here is saved on GitHub: no backup needed');
  assert.equal(fs.existsSync(path.join(NODE, 'NOTES.md')), false);
  assert.equal(r.status.nodes['gemini-image'].state, 'changed');
});

test('the token only ever went to GitHub, in the login header', async () => {
  for (const s of G.seen) {
    assert.ok(!s.url.includes(TOKEN));
    assert.ok(!s.body.includes(TOKEN));
  }
  const r = netguard.report();
  assert.equal(r.stats.blocked, 0);
  assert.equal(r.stats.unexpected, 0);
  assert.ok(r.log.some((e) => e.service === 'github' && e.key === 'My nodes repo'));
  // the guard refuses the token toward any other address
  await assert.rejects(netguard.send('https://example.com/x', { headers: { authorization: `Bearer ${TOKEN}` } }, { service: 'github', key: TOKEN }), /network guard/);
});
