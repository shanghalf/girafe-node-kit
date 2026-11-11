// The kit profile (kit/session.js applyProfile): GIRAFE answers the hello with the name of the
// person's nodes repository and, once, the GitHub key they marked for their kits - so a kit on a
// new computer sets itself up with nothing to paste.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-profile-'));
process.env.GIRAFE_KIT_WORKSPACE = WS;
process.env.GIRAFE_KIT_NO_SIGNIN = '1';
fs.mkdirSync(path.join(WS, 'nodes'), { recursive: true });

// A fake GitHub holding one node this computer has never seen.
const TOKEN = 'github_pat_FROM_MY_GIRAFE_0123456789';
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const only = Buffer.from('{"id":"only-on-github","name":"Only","version":"1.0.0","hostApi":2,"outputs":["out"]}');
const sha = blobSha(only);
const TREE = 'a'.repeat(40); const COMMIT = 'b'.repeat(40);
const gh = http.createServer((req, res) => {
  req.resume();
  const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
  const p = new URL(req.url, 'http://x').pathname.replace('/repos/alf/my-nodes', '');
  if (p === '') return send(200, { private: true, default_branch: 'main', permissions: { push: true } });
  if (p === '/git/ref/heads/main') return send(200, { object: { sha: COMMIT } });
  if (p === `/git/commits/${COMMIT}`) return send(200, { sha: COMMIT, tree: { sha: TREE } });
  if (p === `/git/trees/${TREE}`) return send(200, { truncated: false, tree: [{ path: 'nodes/only-on-github/manifest.json', sha, type: 'blob', mode: '100644' }] });
  send(404, { message: 'Not Found' });
});

let session, keys, github;
test.before(async () => {
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  process.env.KIT_GITHUB_URL = `http://127.0.0.1:${gh.address().port}`;
  session = require('../kit/session');
  keys = require('../kit/keys');
  github = require('../kit/github');
});
test.after(() => { gh.close(); fs.rmSync(WS, { recursive: true, force: true }); });

test('a profile with a repository and a key connects this computer by itself', async () => {
  assert.equal((await github.status()).connected, false);
  await session.applyProfile({ nodesRepo: 'alf/my-nodes', github: { label: 'My token', value: TOKEN } });
  const st = await github.status();
  assert.equal(st.connected, true);
  assert.equal(`${st.owner}/${st.repo}`, 'alf/my-nodes');
  assert.match(session.profileSays(), /Connected to alf\/my-nodes/);
  // The key went into the kit's own key bank, as if pasted: encrypted, service github, masked.
  const k = keys.list().find((x) => x.service === 'github');
  assert.ok(k, 'the key was kept');
  assert.ok(!k.value, 'a listed key never carries its value');
  assert.ok(!fs.readFileSync(path.join(WS, '.kit', 'keys.json'), 'utf8').includes(TOKEN), 'and it is encrypted at rest');
  // The node that is only on GitHub is seen, so it can be fetched.
  assert.equal(st.nodes['only-on-github']?.state, 'remote');
});

test('a second hello changes nothing: a computer already connected is left alone', async () => {
  const before = await github.status();
  await session.applyProfile({ nodesRepo: 'someone/else' });
  const after = await github.status();
  assert.equal(`${after.owner}/${after.repo}`, `${before.owner}/${before.repo}`);
});

test('the same key twice is kept once', async () => {
  const n = keys.list().filter((k) => k.service === 'github').length;
  await session.applyProfile({ nodesRepo: 'alf/my-nodes', github: { label: 'My token', value: TOKEN } });
  assert.equal(keys.list().filter((k) => k.service === 'github').length, n);
});

test('a profile with a name but no key anywhere says what is missing, and breaks nothing', async () => {
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-profile2-'));
  const env = process.env.GIRAFE_KIT_WORKSPACE;
  try {
    // A fresh workspace in another process would be cleaner; here, drop the key and the link.
    for (const k of keys.list().filter((x) => x.service === 'github')) keys.remove(k.id);
    github.disconnect();
    await session.applyProfile({ nodesRepo: 'alf/my-nodes' });
    assert.match(session.profileSays(), /no GitHub key yet/);
    assert.equal((await github.status()).connected, false);
  } finally { process.env.GIRAFE_KIT_WORKSPACE = env; fs.rmSync(WS2, { recursive: true, force: true }); }
});
