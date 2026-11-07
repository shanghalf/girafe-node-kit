// Kit <-> GIRAFE versions, both ways.
//
// GIRAFE says what it runs:   GET <girafe>/api/kit/compat (no login, no key)
//   -> { girafeVersion, hostApi, hostApis, minKit, keyServices, kit: { repo, branch } }
// The kit says what it is on every call to GIRAFE (headers X-Girafe-Kit-Version / -Host-Api),
// and GIRAFE answers 426 to a kit older than minKit, 409 (code host-api | girafe-version) to a
// node it can't run. The newest kit is read from the release branch's package.json.
//
// status() puts it together in plain words: what blocks sending, what to update, and how.
// checkNode() is run before a node is sent, so a mismatch is said before anything leaves.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const netguard = require('./netguard');
const version = require('./version');
const { execFile } = require('child_process');

const KIT_ROOT = path.join(__dirname, '..');

const FILE = path.join(store.ROOT, '.kit', 'compat.json'); // the last answers, for offline starts
const GIRAFE_TTL = 10 * 60_000;
const LATEST_TTL = 60 * 60_000;
const TIMEOUT = 8000;
const DEFAULT_REPO = 'shanghalf/girafe-node-kit';
const DEFAULT_BRANCH = 'release';

const girafeBase = () => (process.env.KIT_GIRAFE_URL || 'https://girafe.live').replace(/\/$/, '');
// Where updates come from: the release branch on GitHub. KIT_UPDATE_URL points tests at a fake
// that serves <base>/package.json and <base>/kit.zip.
function updateSource(repo = DEFAULT_REPO, branch = DEFAULT_BRANCH) {
  if (process.env.KIT_UPDATE_URL) {
    const b = process.env.KIT_UPDATE_URL.replace(/\/$/, '');
    return { packageUrl: `${b}/package.json`, zipUrl: `${b}/kit.zip`, label: b, branch: DEFAULT_BRANCH };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9_./-]+$/.test(branch)) { repo = DEFAULT_REPO; branch = DEFAULT_BRANCH; }
  return {
    packageUrl: `https://raw.githubusercontent.com/${repo}/${branch}/package.json`,
    zipUrl: `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`,
    label: `github.com/${repo} (${branch})`, repo, branch,
  };
}

function cmp(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
const isVer = (v) => /^\d+\.\d+\.\d+$/.test(String(v || ''));
// ">=22" / ">=22.5.0" against a Node version.
function nodeOk(range, have = process.versions.node) {
  const m = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(String(range || '').trim());
  return !range || (m ? cmp(have, m[1]) >= 0 : false);
}

let mem = null;
function readFile() { if (mem) return mem; try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { mem = {}; } return mem; }
function save(patch) {
  mem = { ...readFile(), ...patch };
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem, null, 2)); } catch { /* best effort */ }
}

async function getJson(url, purpose) {
  const res = await netguard.send(url, { headers: { accept: 'application/json', 'x-girafe-kit-version': version.KIT_VERSION, 'x-girafe-kit-host-api': String(version.HOST_API) }, signal: AbortSignal.timeout(TIMEOUT) }, { purpose });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, data };
}

// GIRAFE's own answer. A GIRAFE from before this check answers 404: we say so, and don't block.
async function girafe({ force = false } = {}) {
  const f = readFile();
  const base = girafeBase();
  if (!force && f.girafe && f.girafe.base === base && Date.now() - f.girafe.at < GIRAFE_TTL) return f.girafe;
  try {
    const r = await getJson(`${base}/api/kit/compat`, 'Check GIRAFE\'s version');
    if (r.status === 404) return (save({ girafe: { base, at: Date.now(), old: true } }), readFile().girafe);
    const d = r.data;
    if (!r.ok || !d || !isVer(d.girafeVersion) || !Array.isArray(d.hostApis) || !isVer(d.minKit)) throw new Error(`GIRAFE answered HTTP ${r.status}`);
    const info = { base, at: Date.now(), girafeVersion: d.girafeVersion, hostApi: Number(d.hostApi), hostApis: d.hostApis.map(Number).filter(Number.isInteger), minKit: d.minKit, keyServices: Array.isArray(d.keyServices) ? d.keyServices.map(String) : null, packs: Number(d.packs) || 0, kit: d.kit && typeof d.kit === 'object' ? { repo: String(d.kit.repo || ''), branch: String(d.kit.branch || '') } : null };
    save({ girafe: info });
    return info;
  } catch (e) {
    if (e instanceof netguard.Blocked) throw e;
    // Offline: keep the last answer we had, marked as such.
    const last = f.girafe && f.girafe.base === base && !f.girafe.old ? { ...f.girafe, stale: true } : null;
    return { base, error: `Can't reach GIRAFE (${new URL(base).host}): ${e.message}`, last };
  }
}

// The newest kit on the release branch.
async function latest({ force = false, repo, branch } = {}) {
  const src = updateSource(repo, branch);
  const f = readFile();
  if (!force && f.latest && f.latest.src === src.label && Date.now() - f.latest.at < LATEST_TTL) return { ...f.latest, source: src };
  // A git clone asks git: it uses your own git login, so a private repo works too.
  let gitWhy = null;
  if (!process.env.KIT_UPDATE_URL && fs.existsSync(path.join(KIT_ROOT, '.git'))) {
    try {
      const pkg = await gitLatest(src.branch);
      if (!pkg || !isVer(pkg.version)) throw new Error('no version in package.json');
      const info = { src: src.label, at: Date.now(), version: pkg.version, node: pkg.engines?.node || null, via: 'git' };
      save({ latest: info });
      return { ...info, source: src };
    } catch (e) { gitWhy = e.message; }
  }
  try {
    const r = await getJson(src.packageUrl, 'Check for a newer kit');
    if (r.status === 404 && src.repo) throw new Error(`HTTP 404 - the repository is private or has no ${src.branch} branch. A kit installed with git clone checks with your git login instead${gitWhy ? ` (git said: ${gitWhy})` : ''}`);
    if (!r.ok || !r.data || !isVer(r.data.version)) throw new Error(`HTTP ${r.status}`);
    const info = { src: src.label, at: Date.now(), version: r.data.version, node: r.data.engines?.node || null };
    save({ latest: info });
    return { ...info, source: src };
  } catch (e) {
    if (e instanceof netguard.Blocked) throw e;
    return { src: src.label, error: `Can't check for a newer kit (${src.label}): ${e.message}`, source: src };
  }
}

// git fetch <remote> <branch>, then read package.json from it. The remote is the one the
// current branch pulls from (else origin). Nothing in the working copy changes.
function runGit(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', KIT_ROOT, ...args], { timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n').slice(-2).join(' '))) : resolve(String(out))));
  });
}
async function gitLatest(branch) {
  let remote = 'origin';
  try { remote = (await runGit(['rev-parse', '--abbrev-ref', '@{u}'], 10_000)).trim().split('/')[0] || 'origin'; } catch { /* no upstream: origin */ }
  netguard.note({ host: 'git remote', path: `${remote}/${branch}`, purpose: 'Check for a newer kit (git fetch)', result: 'started by the kit (git)' });
  await runGit(['fetch', '--quiet', remote, `refs/heads/${branch}`]);
  return JSON.parse(await runGit(['show', 'FETCH_HEAD:package.json'], 10_000));
}

// What GIRAFE would say about one node, from its manifest. null when it can be sent.
function checkNode(manifest, g) {
  if (!g || !g.hostApis) return null; // unknown (offline, old GIRAFE): GIRAFE itself will check
  const name = manifest.name || manifest.id;
  if (!g.hostApis.includes(manifest.hostApi)) {
    return manifest.hostApi > Math.max(...g.hostApis)
      ? { code: 'girafe-behind', text: `${name} is written for host API ${manifest.hostApi}; GIRAFE ${g.girafeVersion} runs host API ${g.hostApis.join(' and ')}. It can't be sent until GIRAFE is updated (or write it for host API ${Math.max(...g.hostApis)}).` }
      : { code: 'node-outdated', text: `${name} is written for host API ${manifest.hostApi}, which GIRAFE ${g.girafeVersion} no longer runs. Move it to host API ${g.hostApi} (see CHANGELOG.md).` };
  }
  const m = /^>=\s*(\d+\.\d+(?:\.\d+)?)$/.exec(String(manifest.girafe || '').trim());
  if (m && cmp(g.girafeVersion, m[1]) < 0) return { code: 'girafe-behind', text: `${name} needs GIRAFE ${m[1]}; GIRAFE is ${g.girafeVersion}.` };
  if (g.keyServices) {
    const missing = (manifest.capabilities?.keys || []).map((k) => k.service).filter((s) => !g.keyServices.includes(s));
    if (missing.length) return { code: 'girafe-behind', text: `${name} uses a ${missing.join(', ')} key, which GIRAFE ${g.girafeVersion} doesn't offer yet.` };
  }
  return null;
}

// Everything the page shows. problems: level block (sending refused) | warn | info.
async function status({ force = false } = {}) {
  const g = await girafe({ force });
  const known = g.hostApis ? g : g.last || null;
  const l = await latest({ force, repo: known?.kit?.repo, branch: known?.kit?.branch });
  const kit = { version: version.KIT_VERSION, hostApi: version.HOST_API, hostApis: version.SUPPORTED_HOST_APIS, simulates: version.GIRAFE_VERSION, node: process.versions.node };
  const problems = [];
  if (g.old) problems.push({ level: 'info', code: 'girafe-unknown', text: `${new URL(g.base).host} doesn't say its version yet; GIRAFE itself checks each node you send.` });
  if (g.error) problems.push({ level: 'info', code: 'offline', text: g.error + (g.last ? ` (last known: GIRAFE ${g.last.girafeVersion}).` : '.') });
  if (known) {
    if (cmp(kit.version, known.minKit) < 0) problems.push({ level: 'block', code: 'kit-outdated', text: `GIRAFE ${known.girafeVersion} needs kit ${known.minKit} or newer; this is kit ${kit.version}. Update the kit to send nodes.` });
    if (!known.hostApis.includes(kit.hostApi)) {
      if (kit.hostApi > Math.max(...known.hostApis)) problems.push({ level: 'warn', code: 'girafe-behind', text: `This kit builds nodes for host API ${kit.hostApi} (GIRAFE ${kit.simulates}); GIRAFE ${known.girafeVersion} runs host API ${known.hostApis.join(' and ')}. Nodes written for host API ${Math.max(...known.hostApis)} can be sent; newer ones wait for GIRAFE.` });
      else problems.push({ level: 'warn', code: 'kit-behind', text: `GIRAFE ${known.girafeVersion} no longer runs host API ${kit.hostApi}. Update the kit.` });
    } else if (known.hostApi > kit.hostApi || cmp(known.girafeVersion, kit.simulates) > 0) {
      problems.push({ level: 'info', code: 'kit-behind', text: `GIRAFE is ${known.girafeVersion} (host API ${known.hostApi}); this kit simulates ${kit.simulates} (host API ${kit.hostApi}). Your nodes still work; a kit update brings the new features.` });
    }
  }
  const updateAvailable = !!(l.version && cmp(l.version, kit.version) > 0);
  if (updateAvailable) problems.push({ level: problems.some((p) => p.code === 'kit-outdated') ? 'block' : 'info', code: 'update-available', text: `Kit ${l.version} is available (you have ${kit.version}).${l.node && !nodeOk(l.node) ? ` It needs Node ${l.node.replace('>=', '')} or newer; you have ${kit.node}.` : ''}` });
  if (l.error) problems.push({ level: 'info', code: 'latest-unknown', text: l.error });
  return {
    kit, girafe: known ? { base: g.base, version: known.girafeVersion, hostApi: known.hostApi, hostApis: known.hostApis, minKit: known.minKit, stale: !!known.stale } : { base: g.base, version: null },
    latest: l.version ? { version: l.version, node: l.node, from: l.src } : null,
    updateAvailable, problems, checkedAt: new Date().toISOString(),
  };
}

// The block-level answer for sending a node: null when it may go.
async function beforeSend(manifest) {
  const g = await girafe({ force: true });
  const known = g.hostApis ? g : null; // offline or old GIRAFE: GIRAFE checks on arrival
  if (!known) return null;
  if (cmp(version.KIT_VERSION, known.minKit) < 0) return { code: 'kit-outdated', text: `GIRAFE ${known.girafeVersion} needs kit ${known.minKit} or newer; this is kit ${version.KIT_VERSION}. Click "Update the kit" first.` };
  return checkNode(manifest, known);
}

// A pack: GIRAFE must know packs, and every node in it must pass.
async function beforeSendPack(manifests) {
  const g = await girafe({ force: true });
  const known = g.hostApis ? g : null;
  if (!known) return null;
  if (cmp(version.KIT_VERSION, known.minKit) < 0) return { code: 'kit-outdated', text: `GIRAFE ${known.girafeVersion} needs kit ${known.minKit} or newer; this is kit ${version.KIT_VERSION}. Click "Update the kit" first.` };
  if (!known.packs) return { code: 'no-packs', text: `GIRAFE ${known.girafeVersion} doesn't take packs yet (GIRAFE 0.70.0 or newer does).` };
  for (const m of manifests) { const why = checkNode(m, known); if (why) return { ...why, text: `"${m.id}": ${why.text}` }; }
  return null;
}

// After GIRAFE refused with 426/409, keep its answer so the page shows it at once.
function remember(compat) {
  if (compat && isVer(compat.girafeVersion)) save({ girafe: { base: girafeBase(), at: Date.now(), girafeVersion: compat.girafeVersion, hostApi: Number(compat.hostApi), hostApis: (compat.hostApis || []).map(Number), minKit: compat.minKit, keyServices: compat.keyServices || null, packs: Number(compat.packs) || 0, kit: compat.kit || null } });
}

module.exports = { status, girafe, latest, checkNode, beforeSend, beforeSendPack, remember, updateSource, cmp, nodeOk, isVer, _reset: () => { mem = null; } };
