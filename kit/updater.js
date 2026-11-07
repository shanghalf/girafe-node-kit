// "Update the kit": bring the kit's own files to the newest release, keep everything of yours,
// and go back by itself if the new version doesn't start.
//
//  - A git clone with no changes of yours in the kit's files: git pull --ff-only.
//  - Otherwise (a downloaded zip): the release branch's zip from GitHub, through the network
//    guard, checked (a real kit, the version announced, the Node it needs), unpacked next to the
//    kit, then swapped in. Before the swap the kit's files are copied to a backup.
//  - Never touched: workspace/ (your nodes, graphs, keys, files), .runtime/ (the private Node),
//    .git/, node_modules/.
//  - The kit then restarts (exit code 75; kit.js starts it again). When the new version stops
//    before it is up, kit.js puts the backup (or the previous git commit) back and starts that.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const netguard = require('./netguard');
const compat = require('./compat');
const zip = require('./zip');
const { KIT_VERSION } = require('./version');

const ROOT = path.join(__dirname, '..');
const KEEP = new Set(['workspace', '.runtime', '.git', 'node_modules']);
const MAX_ZIP = 40 * 1024 * 1024;
const REQUIRED = ['kit.js', 'package.json', 'kit/version.js', 'kit/server.js', 'web/index.html'];
const RESTART_CODE = 75;
const dir = () => path.join(store.ROOT, '.kit', 'update');
const PENDING = () => path.join(dir(), 'pending.json');
const LAST = () => path.join(dir(), 'last.json');
let busy = false;

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 2)); fs.renameSync(f + '.tmp', f); };

function git(root, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, ...args], { timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => (e ? reject(Object.assign(new Error((err || e.message).trim().split('\n').slice(-3).join(' ')), { stderr: err })) : resolve(String(out).trim())));
  });
}
const versionIn = (text) => /KIT_VERSION:\s*'(\d+\.\d+\.\d+)'/.exec(text)?.[1] || null;

// How this kit can update: { mode: 'git' | 'zip', ready, why }
async function method(root = ROOT) {
  if (fs.existsSync(path.join(root, '.git'))) {
    try { await git(root, ['--version'], 10_000); } catch { return { mode: 'git', ready: false, why: 'This kit is a git clone, but git does not run here. Update it with "git pull" yourself.' }; }
    let changed = '';
    try { changed = await git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.', ':(exclude)workspace'], 20_000); } catch (e) { return { mode: 'git', ready: false, why: `git status failed: ${e.message}` }; }
    if (changed) {
      const files = changed.split('\n').map((l) => l.replace(/^\s*\S+\s+/, '')).slice(0, 6);
      return { mode: 'git', ready: false, why: `You changed kit files (${files.join(', ')}${changed.split('\n').length > 6 ? ', …' : ''}). Commit or undo them, then update, or run "git pull" yourself.` };
    }
    try { await git(root, ['rev-parse', '--abbrev-ref', '@{u}'], 10_000); } catch { return { mode: 'git', ready: false, why: 'This git clone has no upstream branch to pull from. Run "git pull" yourself.' }; }
    return { mode: 'git', ready: true, why: null };
  }
  return { mode: 'zip', ready: true, why: null };
}

function info() {
  return { version: KIT_VERSION, busy, supervised: process.env.GIRAFE_KIT_CHILD === '1', last: readJson(LAST()), pending: !!readJson(PENDING()) };
}

function restartSoon() {
  if (process.env.GIRAFE_KIT_CHILD !== '1') return 'manual';
  setTimeout(() => process.exit(RESTART_CODE), 600);
  return 'auto';
}

// ---- the zip way ----
function unpack(buf, root) {
  const files = zip.read(buf);
  const first = files[0]?.name.split('/')[0];
  if (!first || !files.every((f) => f.name.startsWith(first + '/'))) throw new Error('This zip is not a kit release (no single top folder).');
  const out = [];
  for (const f of files) {
    const rel = f.name.slice(first.length + 1);
    if (!rel || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '' || s === '.') || path.isAbsolute(rel) || /[:\0]/.test(rel)) throw new Error(`Refused a file name in the zip: ${f.name}`);
    if (KEEP.has(rel.split('/')[0])) continue;
    out.push({ rel, data: f.data, mode: f.mode });
  }
  for (const r of REQUIRED) if (!out.some((f) => f.rel === r)) throw new Error(`This zip is not a kit release (${r} missing).`);
  const pkg = JSON.parse(out.find((f) => f.rel === 'package.json').data.toString('utf8'));
  const ver = versionIn(out.find((f) => f.rel === 'kit/version.js').data.toString('utf8'));
  if (pkg.name !== 'girafe-node-kit' || !compat.isVer(pkg.version) || ver !== pkg.version) throw new Error('This zip is not a kit release (its versions disagree).');
  return { files: out, version: pkg.version, node: pkg.engines?.node || null, root };
}

function swap(root, staged, tops, backup) {
  fs.mkdirSync(backup, { recursive: true });
  const present = fs.readdirSync(root).filter((t) => !KEEP.has(t));
  for (const t of present) fs.cpSync(path.join(root, t), path.join(backup, t), { recursive: true, preserveTimestamps: true });
  writeJson(path.join(backup, '.backup.json'), { version: KIT_VERSION, tops: present, at: new Date().toISOString() });
  for (const t of tops) {
    fs.rmSync(path.join(root, t), { recursive: true, force: true });
    try { fs.renameSync(path.join(staged, t), path.join(root, t)); }
    catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(path.join(staged, t), path.join(root, t), { recursive: true }); }
  }
}

function putBack(root, backup, tops) {
  const meta = readJson(path.join(backup, '.backup.json')) || { tops: [] };
  for (const t of new Set([...(tops || []), ...meta.tops])) if (!KEEP.has(t)) fs.rmSync(path.join(root, t), { recursive: true, force: true });
  for (const t of meta.tops) fs.cpSync(path.join(backup, t), path.join(root, t), { recursive: true, preserveTimestamps: true });
}

async function viaZip(root, latest) {
  const res = await netguard.send(latest.source.zipUrl, { signal: AbortSignal.timeout(180_000) }, { purpose: `Download kit ${latest.version}` });
  if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}).`);
  if (Number(res.headers.get('content-length') || 0) > MAX_ZIP) throw new Error('The download is too large.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP) throw new Error('The download is too large.');
  const u = unpack(buf, root);
  if (compat.cmp(u.version, KIT_VERSION) <= 0) throw new Error(`The download is kit ${u.version}; you already have ${KIT_VERSION}.`);
  if (!compat.nodeOk(u.node)) throw new Error(`Kit ${u.version} needs Node ${String(u.node).replace('>=', '')} or newer; this computer runs ${process.versions.node}. Install a newer Node (nodejs.org), or delete the .runtime folder so the starter gets one.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staged = path.join(dir(), `staged-${u.version}-${stamp}`);
  fs.rmSync(staged, { recursive: true, force: true });
  for (const f of u.files) {
    const fp = path.join(staged, f.rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, f.data);
    if (f.mode && process.platform !== 'win32') fs.chmodSync(fp, f.mode);
  }
  const tops = [...new Set(u.files.map((f) => f.rel.split('/')[0]))];
  const backup = path.join(dir(), `backup-${KIT_VERSION}-${stamp}`);
  writeJson(PENDING(), { mode: 'zip', from: KIT_VERSION, to: u.version, backup, tops, root, at: new Date().toISOString() });
  try { swap(root, staged, tops, backup); }
  catch (e) { putBack(root, backup, tops); fs.rmSync(PENDING(), { force: true }); throw new Error(`The update could not be put in place (${e.message}); nothing changed.`); }
  finally { fs.rmSync(staged, { recursive: true, force: true }); }
  return u.version;
}

async function viaGit(root) {
  const before = await git(root, ['rev-parse', 'HEAD'], 10_000);
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '@{u}'], 10_000);
  netguard.note({ host: 'git remote', path: upstream, purpose: 'git pull (Update the kit)', result: 'started by the kit (git)' });
  await git(root, ['pull', '--ff-only']);
  const after = await git(root, ['rev-parse', 'HEAD'], 10_000);
  if (after === before) return null;
  const to = versionIn(fs.readFileSync(path.join(root, 'kit', 'version.js'), 'utf8')) || KIT_VERSION;
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && !compat.nodeOk(pkg.engines?.node)) {
    await git(root, ['reset', '--hard', before]);
    throw new Error(`Kit ${to} needs Node ${String(pkg.engines.node).replace('>=', '')} or newer; this computer runs ${process.versions.node}. Nothing changed.`);
  }
  writeJson(PENDING(), { mode: 'git', from: KIT_VERSION, to, prevHead: before, root, at: new Date().toISOString() });
  return to;
}

async function start({ root = ROOT } = {}) {
  if (busy) throw new Error('An update is already running.');
  if (readJson(PENDING())) throw new Error('An update is waiting for a restart. Close the kit and start it again.');
  busy = true;
  try {
    const how = await method(root);
    if (!how.ready) throw Object.assign(new Error(how.why), { code: 'cannot-update' });
    const g = await compat.girafe({});
    const known = g.hostApis ? g : g.last;
    const latest = await compat.latest({ force: true, repo: known?.kit?.repo, branch: known?.kit?.branch });
    if (how.mode === 'zip') {
      if (!latest.version) throw new Error(latest.error || 'Could not find the newest kit.');
      if (compat.cmp(latest.version, KIT_VERSION) <= 0) return { upToDate: true, version: KIT_VERSION };
    }
    const to = how.mode === 'git' ? await viaGit(root) : await viaZip(root, latest);
    if (!to) return { upToDate: true, version: KIT_VERSION, mode: how.mode };
    const restart = restartSoon();
    return { ok: true, mode: how.mode, from: KIT_VERSION, to, restart };
  } finally { busy = false; }
}

// The new version is up: keep it, tidy old backups (the two newest stay).
function confirm() {
  const p = readJson(PENDING());
  if (!p) return null;
  writeJson(LAST(), { ok: true, from: p.from, to: p.to, mode: p.mode, at: new Date().toISOString() });
  fs.rmSync(PENDING(), { force: true });
  try {
    const old = fs.readdirSync(dir()).filter((d) => d.startsWith('backup-')).sort().reverse().slice(2);
    for (const d of old) fs.rmSync(path.join(dir(), d), { recursive: true, force: true });
  } catch { /* best effort */ }
  return p;
}

// Called by kit.js when the kit stopped before confirm(): put the previous version back.
async function rollback() {
  const p = readJson(PENDING());
  if (!p) return null;
  let error = null;
  try {
    if (p.mode === 'zip') putBack(p.root, p.backup, p.tops);
    else await git(p.root, ['reset', '--hard', p.prevHead], 30_000);
  } catch (e) { error = e.message; }
  writeJson(LAST(), { ok: false, rolledBack: !error, from: p.from, to: p.to, mode: p.mode, at: new Date().toISOString(), error: error ? `Kit ${p.to} did not start and putting ${p.from} back failed: ${error}. The backup is in ${p.backup || 'git history'}.` : `Kit ${p.to} did not start; the kit put ${p.from} back.` });
  fs.rmSync(PENDING(), { force: true });
  return { ...p, error };
}

module.exports = { method, info, start, confirm, rollback, unpack, RESTART_CODE, KEEP };
