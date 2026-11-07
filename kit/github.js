// Your nodes on GitHub: one repo of yours (private is best) holds workspace/nodes/<id>/ as
// nodes/<id>/. GitHub's API only - no git program - so every request goes through the network
// guard, with a token you pasted in the key bank (service "github"), sent to api.github.com only.
//
// What can ever be uploaded: files inside workspace/nodes/<id>/ of the node you save, nothing
// else. The kit's own folder (workspace/.kit: keys, the signing key, settings) is never read here.
// Before each save the files are scanned for things that look like keys or private keys; a hit
// stops the save.
//
// State per node, kept in workspace/.kit/github.json: the files as they were the last time this
// computer saved or fetched the node ("base", as git blob ids). Comparing this computer's files,
// the base and what is on GitHub gives the node's state:
//   clean · changed (this computer) · behind (GitHub has newer) · conflict (both) · new (never
//   saved) · remote (only on GitHub).
// Taking GitHub's version (update, undo, restore) first copies this computer's files to
// workspace/.kit/backups/<id>-<time>/ when they differ, so nothing is lost.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const keys = require('./keys');
const netguard = require('./netguard');

const SETTINGS = path.join(store.ROOT, '.kit', 'github.json');
const BACKUPS = path.join(store.ROOT, '.kit', 'backups');
const PREFIX = 'nodes/';
const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILES = 300;
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', '.git']);
const SAFE_REL = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._@+ ()-]+(\/[A-Za-z0-9._@+ ()-]+)*$/;

// Things that look like secrets. A file holding one is never uploaded.
const SECRET_PATTERNS = [
  ['an Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{24,}/],
  ['a Google key', /AIza[0-9A-Za-z_-]{30,}/],
  ['a GitHub token', /\b(github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})/],
  ['a Resend key', /\bre_[A-Za-z0-9_]{20,}/],
  ['a Tripo key', /\btsk_[A-Za-z0-9_-]{20,}/],
  ['a GIRAFE kit token', /\bgk_[A-Za-z0-9_-]{20,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const base = () => (process.env.KIT_GITHUB_URL || 'https://api.github.com').replace(/\/+$/, '');
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return null; } }
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (!s) return fs.rmSync(SETTINGS, { force: true });
  fs.writeFileSync(SETTINGS + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(SETTINGS + '.tmp', SETTINGS);
}

class GitHubError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status; } }

// One request to GitHub, through the guard, with the token from the key bank (decrypted for
// this one call).
async function gh(s, method, p, body) {
  const key = keys.use(s.keyId, 'github');
  const init = {
    method,
    headers: { authorization: `Bearer ${key.value}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'girafe-node-kit', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  };
  let res;
  try { res = await netguard.send(base() + p, init, { service: 'github', key: key.value, keyLabel: key.label, purpose: `GitHub: ${method} ${p.replace(/\/repos\/[^/]+\/[^/]+/, '').split('?')[0] || '/'}` }); }
  catch (e) { if (e instanceof netguard.Blocked) throw e; throw new GitHubError(`Could not reach GitHub (${e.cause?.code || e.message}).`, 'network'); }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new GitHubError('GitHub refused the token (expired or revoked?). Make a new one and paste it in 🔑 Keys.', 'token', 401);
    if (res.status === 403 && /rate limit/i.test(msg)) throw new GitHubError('GitHub says too many requests for now. Wait a few minutes.', 'rate', 403);
    throw new GitHubError(msg, 'github', res.status);
  }
  return data;
}

const repoPath = (s) => `/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}`;

function parseRepo(text) {
  const t = String(text || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(t);
  if (!m) throw new GitHubError('Give the repo as owner/name, or paste its github.com address.', 'input');
  return { owner: m[1], repo: m[2] };
}

// ---------- local files ----------
function listLocal(id) {
  const dir = path.join(store.NODES, id);
  const out = {};
  if (!fs.existsSync(dir)) return null;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        if (!SAFE_REL.test(r)) throw new GitHubError(`The file name "${r}" can't be saved to GitHub (use letters, digits, dots and dashes).`, 'input');
        const fp = path.join(dir, r);
        const size = fs.statSync(fp).size;
        if (size > MAX_FILE) throw new GitHubError(`${r} is ${(size / 1048576).toFixed(1)} MB; files over 20 MB are not saved.`, 'input');
        out[r] = blobSha(fs.readFileSync(fp));
        if (Object.keys(out).length > MAX_FILES) throw new GitHubError(`More than ${MAX_FILES} files in ${id}.`, 'input');
      }
    }
  };
  walk('');
  return out;
}
const sameFiles = (a, b) => {
  if (!a || !b) return !a && !b;
  const ka = Object.keys(a); if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

function scanSecrets(id, files) {
  const hits = [];
  for (const rel of Object.keys(files)) {
    const buf = fs.readFileSync(path.join(store.NODES, id, rel));
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => { for (const [what, re] of SECRET_PATTERNS) if (re.test(line)) hits.push({ file: rel, line: i + 1, what }); });
  }
  return hits;
}

// ---------- GitHub side ----------
let remoteCache = null; // { at, head, files: { id: { rel: sha } }, empty }

async function head(s) {
  try {
    const ref = await gh(s, 'GET', `${repoPath(s)}/git/ref/heads/${encodeURIComponent(s.branch)}`);
    return ref.object.sha;
  } catch (e) {
    if (e.status === 404 || e.status === 409) return null; // empty repo (or no such branch yet)
    throw e;
  }
}

async function remoteState(s, { fresh = false } = {}) {
  if (!fresh && remoteCache && Date.now() - remoteCache.at < 20_000) return remoteCache;
  const h = await head(s);
  const files = {};
  if (h) {
    const commit = await gh(s, 'GET', `${repoPath(s)}/git/commits/${h}`);
    const tree = await gh(s, 'GET', `${repoPath(s)}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new GitHubError('This repo is too big for the kit to read in one go.', 'input');
    for (const e of tree.tree || []) {
      if (e.type !== 'blob' || !e.path.startsWith(PREFIX)) continue;
      const rest = e.path.slice(PREFIX.length);
      const cut = rest.indexOf('/');
      if (cut <= 0) continue;
      const id = rest.slice(0, cut); const rel = rest.slice(cut + 1);
      if (!store.ID_RE.test(id) || !SAFE_REL.test(rel)) continue;
      (files[id] ||= {})[rel] = e.sha;
    }
  }
  remoteCache = { at: Date.now(), head: h, empty: !h, files };
  return remoteCache;
}

function stateOf(local, baseFiles, remote) {
  if (!local) return remote ? 'remote' : 'gone';
  if (!baseFiles) {
    if (!remote) return 'new';
    return sameFiles(local, remote) ? 'clean' : 'conflict';
  }
  const mine = !sameFiles(local, baseFiles);
  const theirs = remote ? !sameFiles(remote, baseFiles) : true;
  if (!mine && !theirs) return 'clean';
  if (mine && !theirs) return 'changed';
  if (!mine && theirs) return remote ? 'behind' : 'deleted';
  return remote && sameFiles(local, remote) ? 'clean' : 'conflict';
}

// ---------- public ----------
function localIds() {
  return fs.readdirSync(store.NODES, { withFileTypes: true }).filter((d) => d.isDirectory() && store.ID_RE.test(d.name)).map((d) => d.name);
}

// status({ remote }): without remote, only this computer is looked at (no internet).
async function status({ remote = false } = {}) {
  const s = readSettings();
  if (!s) return { connected: false };
  const out = { connected: true, owner: s.owner, repo: s.repo, branch: s.branch, private: s.private, url: `https://github.com/${s.owner}/${s.repo}`, keyId: s.keyId, nodes: {} };
  let r = remoteCache;
  if (remote) {
    try { r = await remoteState(s, { fresh: true }); } catch (e) { out.error = e.message; }
  }
  out.checkedAt = r ? new Date(r.at).toISOString() : null;
  const ids = new Set([...localIds(), ...Object.keys(s.synced || {}), ...(r ? Object.keys(r.files) : [])]);
  for (const id of ids) {
    let local; try { local = listLocal(id); } catch (e) { out.nodes[id] = { state: 'error', error: e.message }; continue; }
    const baseFiles = s.synced?.[id]?.files || null;
    let state;
    if (r) state = stateOf(local, baseFiles, r.files[id] || null);
    else state = !local ? 'gone' : !baseFiles ? 'new' : sameFiles(local, baseFiles) ? 'clean' : 'changed';
    if (state === 'gone') continue;
    out.nodes[id] = { state, savedAt: s.synced?.[id]?.at || null, commit: s.synced?.[id]?.commit || null };
  }
  return out;
}

async function connect({ keyId, repo, allowPublic = false }) {
  const { owner, repo: name } = parseRepo(repo);
  keys.use(keyId, 'github'); // the key exists and is a GitHub token
  const s = { keyId, owner, repo: name, branch: 'main', synced: {} };
  let info;
  try { info = await gh(s, 'GET', repoPath(s)); }
  catch (e) { if (e.status === 404) throw new GitHubError(`GitHub doesn't show ${owner}/${name} to this token. Check the name, and that the token was made for this repo.`, 'input', 404); throw e; }
  if (info.permissions && !info.permissions.push) throw new GitHubError('This token can read the repo but not write to it. Give it "Contents: Read and write".', 'input');
  if (!info.private && !allowPublic) throw new GitHubError('This repo is public: anyone could read your nodes. Make it private on GitHub, or confirm you want a public repo.', 'public');
  const old = readSettings();
  s.branch = info.default_branch || 'main';
  s.private = !!info.private;
  // Same repo again: keep what this computer knows.
  if (old && old.owner === owner && old.repo === name) s.synced = old.synced || {};
  s.connectedAt = new Date().toISOString();
  writeSettings(s);
  remoteCache = null;
  return status({ remote: true });
}

function disconnect() { writeSettings(null); remoteCache = null; return { connected: false }; }

function need() {
  const s = readSettings();
  if (!s) throw new GitHubError('Use GitHub first (GitHub at the top).', 'setup');
  return s;
}
const checkId = (id) => { if (!store.ID_RE.test(String(id || ''))) throw new GitHubError('Bad node id.', 'input'); return id; };

async function save({ id, message, mine = false }) {
  const s = need(); checkId(id);
  const local = listLocal(id);
  if (!local || !Object.keys(local).length) throw new GitHubError(`There is no ${id} folder with files to save.`, 'input');
  const hits = scanSecrets(id, local);
  if (hits.length) {
    const e = new GitHubError(`Not saved: ${hits.slice(0, 5).map((h) => `${h.file} line ${h.line} looks like ${h.what}`).join('; ')}. Keys belong in 🔑 Keys, never in a node's files.`, 'secret');
    e.hits = hits; throw e;
  }
  let r = await remoteState(s, { fresh: true });
  const baseFiles = s.synced?.[id]?.files || null;
  const st = stateOf(local, baseFiles, r.files[id] || null);
  if (st === 'clean') return { ok: true, nothing: true, status: await status() };
  if ((st === 'behind' || st === 'conflict') && !mine) {
    throw new GitHubError(st === 'behind' ? 'GitHub has a newer version of this node. Get it first, or save yours over it.' : 'This node changed both here and on GitHub. Choose which one to keep.', st);
  }
  if (r.empty) {
    // An empty repo can't take a commit through the data API: start it with a README.
    const readme = `# My GIRAFE nodes\n\nSaved by the GIRAFE node kit. Each folder in nodes/ is one node.\n`;
    await gh(s, 'PUT', `${repoPath(s)}/contents/README.md`, { message: 'Start: my GIRAFE nodes', content: Buffer.from(readme).toString('base64'), branch: s.branch });
    r = await remoteState(s, { fresh: true });
    if (!r.head) throw new GitHubError('GitHub did not start the repo. Try again.', 'github');
  }
  const remote = r.files[id] || {};
  const known = new Set(Object.values(remote));
  const entries = [];
  for (const [rel, sha] of Object.entries(local)) {
    if (!known.has(sha)) {
      const content = fs.readFileSync(path.join(store.NODES, id, rel)).toString('base64');
      const b = await gh(s, 'POST', `${repoPath(s)}/git/blobs`, { content, encoding: 'base64' });
      if (b.sha !== sha) throw new GitHubError(`GitHub stored ${rel} differently than expected. Nothing was changed.`, 'github');
      known.add(sha);
    }
    if (remote[rel] !== sha) entries.push({ path: PREFIX + id + '/' + rel, mode: '100644', type: 'blob', sha });
  }
  for (const rel of Object.keys(remote)) if (!(rel in local)) entries.push({ path: PREFIX + id + '/' + rel, mode: '100644', type: 'blob', sha: null });
  const parent = await gh(s, 'GET', `${repoPath(s)}/git/commits/${r.head}`);
  const tree = await gh(s, 'POST', `${repoPath(s)}/git/trees`, { base_tree: parent.tree.sha, tree: entries });
  const msg = String(message || '').trim().slice(0, 500) || `Update ${id}`;
  const commit = await gh(s, 'POST', `${repoPath(s)}/git/commits`, { message: msg, tree: tree.sha, parents: [r.head] });
  try { await gh(s, 'PATCH', `${repoPath(s)}/git/refs/heads/${encodeURIComponent(s.branch)}`, { sha: commit.sha, force: false }); }
  catch (e) { if (e.status === 422 || e.status === 409) throw new GitHubError('GitHub changed while saving (another computer?). Nothing was lost: try again.', 'race'); throw e; }
  const now = readSettings() || s;
  (now.synced ||= {})[id] = { files: local, commit: commit.sha, at: new Date().toISOString() };
  writeSettings(now);
  remoteCache = null;
  return { ok: true, commit: commit.sha, url: `https://github.com/${s.owner}/${s.repo}/commit/${commit.sha}`, status: await status() };
}

function backup(id) {
  const dir = path.join(store.NODES, id);
  if (!fs.existsSync(dir)) return null;
  const to = path.join(BACKUPS, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.cpSync(dir, to, { recursive: true });
  return path.relative(store.ROOT, to);
}

// Write a set of GitHub files ({ rel: sha }) as the node's folder. Backs up first when this
// computer holds work that is on GitHub nowhere (differs from both the last saved version and
// what is being written).
async function writeFromGitHub(s, id, files) {
  const local = listLocal(id);
  const baseFiles = s.synced?.[id]?.files || null;
  const saved = local && !sameFiles(local, files) && !sameFiles(local, baseFiles) ? backup(id) : null;
  const contents = {};
  for (const [rel, sha] of Object.entries(files)) {
    if (!SAFE_REL.test(rel)) throw new GitHubError(`GitHub holds a file name the kit won't write: ${rel}`, 'input');
    const b = await gh(s, 'GET', `${repoPath(s)}/git/blobs/${sha}`);
    const buf = Buffer.from(b.content || '', 'base64');
    if (blobSha(buf) !== sha) throw new GitHubError(`${rel} came back damaged from GitHub. Nothing was changed.`, 'github');
    contents[rel] = buf;
  }
  // Everything fetched and checked: only now touch the folder.
  const dir = path.join(store.NODES, id);
  if (local) for (const rel of Object.keys(local)) if (!(rel in files)) fs.rmSync(path.join(dir, rel), { force: true });
  for (const [rel, buf] of Object.entries(contents)) {
    const fp = path.join(dir, rel);
    if (!fp.startsWith(dir + path.sep)) throw new GitHubError('Bad path.', 'input');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, buf);
  }
  return saved;
}

// Take GitHub's version of the node (get an update, or undo this computer's changes).
async function update({ id }) {
  const s = need(); checkId(id);
  const r = await remoteState(s, { fresh: true });
  const files = r.files[id];
  if (!files) throw new GitHubError(`${id} is not on GitHub yet.`, 'input');
  const backupDir = await writeFromGitHub(s, id, files);
  const now = readSettings() || s;
  (now.synced ||= {})[id] = { files, commit: r.head, at: new Date().toISOString() };
  writeSettings(now);
  return { ok: true, backup: backupDir, status: await status() };
}

async function history({ id }) {
  const s = need(); checkId(id);
  const list = await gh(s, 'GET', `${repoPath(s)}/commits?sha=${encodeURIComponent(s.branch)}&path=${encodeURIComponent(PREFIX + id)}&per_page=30`);
  return { commits: (list || []).map((c) => ({ sha: c.sha, message: String(c.commit?.message || '').split('\n')[0], at: c.commit?.author?.date || null, author: c.commit?.author?.name || c.author?.login || '', url: c.html_url })) };
}

// Put an older version in the folder. It becomes "changed": save it to make it the latest.
async function restore({ id, commit }) {
  const s = need(); checkId(id);
  if (!/^[0-9a-f]{40}$/.test(String(commit || ''))) throw new GitHubError('Bad version id.', 'input');
  const c = await gh(s, 'GET', `${repoPath(s)}/git/commits/${commit}`);
  const tree = await gh(s, 'GET', `${repoPath(s)}/git/trees/${c.tree.sha}?recursive=1`);
  const files = {};
  for (const e of tree.tree || []) if (e.type === 'blob' && e.path.startsWith(`${PREFIX}${id}/`)) files[e.path.slice(PREFIX.length + id.length + 1)] = e.sha;
  if (!Object.keys(files).length) throw new GitHubError(`${id} did not exist in that version.`, 'input');
  const backupDir = await writeFromGitHub(s, id, files);
  return { ok: true, backup: backupDir, status: await status() };
}

// What changed on this computer compared with GitHub: per file, and line by line for text.
async function diff({ id }) {
  const s = need(); checkId(id);
  const local = listLocal(id) || {};
  const r = await remoteState(s, { fresh: false }).catch(() => null);
  const remote = r?.files[id] || {};
  const files = [];
  for (const rel of [...new Set([...Object.keys(local), ...Object.keys(remote)])].sort()) {
    if (local[rel] === remote[rel]) continue;
    const kind = !remote[rel] ? 'added' : !local[rel] ? 'removed' : 'changed';
    let lines = null;
    const mineBuf = local[rel] ? fs.readFileSync(path.join(store.NODES, id, rel)) : Buffer.alloc(0);
    let theirsBuf = Buffer.alloc(0);
    if (remote[rel]) { const b = await gh(s, 'GET', `${repoPath(s)}/git/blobs/${remote[rel]}`); theirsBuf = Buffer.from(b.content || '', 'base64'); }
    if (!mineBuf.includes(0) && !theirsBuf.includes(0)) lines = lineDiff(theirsBuf.toString('utf8'), mineBuf.toString('utf8'));
    files.push({ file: rel, kind, lines });
  }
  return { files };
}

// A small line diff (LCS), with 2 lines of context around changes.
function lineDiff(a, b) {
  const A = a.split('\n'); const B = b.split('\n');
  if (A.length * B.length > 4_000_000) return [{ t: '…', s: 'Too long to compare line by line.' }];
  const m = A.length, n = B.length;
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { ops.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: '-', s: A[i++] });
    else ops.push({ t: '+', s: B[j++] });
  }
  while (i < m) ops.push({ t: '-', s: A[i++] });
  while (j < n) ops.push({ t: '+', s: B[j++] });
  const keep = ops.map((o, k) => o.t !== ' ' || ops.slice(Math.max(0, k - 2), k + 3).some((x) => x.t !== ' '));
  const out = [];
  ops.forEach((o, k) => { if (keep[k]) out.push(o); else if (out.length && out[out.length - 1].t !== '…') out.push({ t: '…', s: '' }); });
  return out;
}

module.exports = { status, connect, disconnect, save, update, history, restore, diff, scanSecrets, blobSha, parseRepo, stateOf, GitHubError, SECRET_PATTERNS };
