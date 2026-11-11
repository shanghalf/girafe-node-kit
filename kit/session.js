// Signing in: the kit runs on any computer, but does nothing until you sign in with your GIRAFE
// account (kit/girafe-link.js, one Allow on girafe.live). At sign-in you say whose computer it is:
//   mine     closing the page leaves the kit ready, still signed in, like a browser.
//   passing  a computer that isn't yours (a café, a friend's): when no page of the kit has been
//            open for a few minutes, the kit saves your nodes to GitHub, signs out and erases
//            everything of yours from this computer.
// "Leave" in the top bar offers the same two choices at any time. A link cut from GIRAFE ›
// Settings › Connected kits signs the kit out the next time it checks (on start, then every
// few minutes).
//
// Nothing of yours is erased while a node of yours is not saved on GitHub: the kit keeps it,
// says so, and tries again later.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const link = require('./girafe-link');
const { KIT_VERSION, HOST_API } = require('./version');

const FILE = path.join(store.ROOT, '.kit', 'session.json');
const IDLE_MS = Number(process.env.KIT_IDLE_MS) || 5 * 60_000; // tests shorten it
const CHECK_MS = 3 * 60_000;
const SHIPPED = ['example-upper', 'gemini-image'];

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const write = (d) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2), { mode: 0o600 }); } catch { /* best effort */ } };

let last = { checkedAt: 0, ok: null, error: null };
let busy = null;
let note = null; // what the last automatic leave did (shown on the next open)

// Tests and scripts run the kit without signing in.
const open = () => process.env.GIRAFE_KIT_NO_SIGNIN === '1';

function status() {
  const l = link.status();
  const s = read();
  return {
    required: !open(),
    signedIn: open() || l.connected,
    account: l.account, base: l.base, pending: l.pending,
    trust: s.trust || 'mine',
    idleMinutes: Math.round(IDLE_MS / 60_000),
    note, error: last.error, profileNote,
  };
}

// Start signing in. trust: 'mine' | 'passing'.
async function signIn(trust) {
  const s = read();
  s.trust = trust === 'passing' ? 'passing' : 'mine';
  s.beatAt = Date.now();
  write(s);
  note = null;
  return link.connect();
}

// The page says it is open (every 30 s).
function beat() { const s = read(); s.beatAt = Date.now(); write(s); return { ok: true }; }

// What this computer tells GIRAFE about itself on every check (POST /api/kit/hello): which
// computer and port, which kit, the nodes repository and how much of it is not saved, the market,
// and the packs and nodes held here with their versions. It is what Settings › Node kit shows
// about a computer GIRAFE cannot reach. Nothing private: no key, no path, no node contents - and
// the GitHub state is read from what is already on disk, never over the network, so a check stays
// instant. Anything that fails is simply left out.
let servingPort = null;
const servedOn = (port) => { servingPort = Number(port) || null; };

async function chainReport() {
  const r = { hostname: os.hostname(), port: servingPort, kitVersion: KIT_VERSION, hostApi: HOST_API, autostart: false, github: null, market: null, packs: [] };
  try {
    const g = await require('./github').status(); // no { remote: true }: nothing over the network here
    if (g.connected) {
      const states = Object.values(g.nodes || {});
      r.github = { repo: `${g.owner}/${g.repo}`, nodes: states.length, changed: states.filter((n) => n.state !== 'clean').length };
    }
  } catch { /* GitHub not set up here */ }
  try {
    const m = require('./market-link').status();
    r.market = { linked: !!m.connected, account: m.account?.name || m.account?.email || null };
  } catch { /* not linked */ }
  try { r.packs = heldHere(); } catch { /* nothing to say */ }
  return r;
}

// Every pack and loose node this computer holds, with its version and the hash a package of it
// would carry - what the Ship panel compares against what GIRAFE and the market hold.
function heldHere() {
  const pkgs = require('./package');
  const packs = require('./packs');
  const out = [];
  const inPack = new Set();
  for (const id of packs.packDirs()) {
    try {
      const p = packs.getPack(id);
      if (!p) continue;
      for (const n of p.nodes || []) inPack.add(n);
      out.push({ id, kind: 'pack', version: p.version || null, hash: safe(() => pkgs.hashPack(id)) });
    } catch { /* a pack being edited */ }
  }
  for (const d of fs.readdirSync(store.NODES, { withFileTypes: true })) {
    if (!d.isDirectory() || !store.ID_RE.test(d.name) || inPack.has(d.name) || packs.isPackDir(d.name)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(store.NODES, d.name, 'manifest.json'), 'utf8'));
      out.push({ id: m.id || d.name, kind: 'node', version: m.version || null, hash: safe(() => pkgs.hashNode(d.name)) });
    } catch { /* not a node yet */ }
  }
  return out;
}
const safe = (fn) => { try { return fn(); } catch { return null; } };

// Is the link still accepted? A 401 means it was cut (Settings › Node kit): signed out. The same
// call tells GIRAFE what this computer is running (hello); a GIRAFE from before that falls back
// to the plain question by itself.
async function check() {
  if (open() || !link.status().connected) return status();
  try {
    const answer = await link.hello(await chainReport());
    await applyProfile(answer && answer.profile);
    last = { checkedAt: Date.now(), ok: true, error: null };
  } catch (e) {
    if (e.status === 401) { await link.forget(); note = 'You were signed out from GIRAFE (the link was cut, or the account changed).'; }
    else last = { checkedAt: Date.now(), ok: null, error: e.message }; // offline: keep going
  }
  return status();
}

// One approval, not three. GIRAFE answers every hello with the kit profile: the name of the
// person's own GitHub repository of nodes, and - exactly once, on this link's first hello - the
// GitHub key they marked "for my kits" in their Key bank. With both, a kit on a new computer
// connects itself to that repository, and the nodes that are only on GitHub are there waiting.
// Nothing is forced: a kit already connected to a repository is left alone, and a profile with no
// key only says what is missing.
//
// The key is treated exactly as a pasted one: it goes into the kit's own key bank, encrypted,
// service `github`, so it can only ever leave again towards api.github.com (kit/netguard.js).
let profileNote = null;
const profileSays = () => profileNote;

async function applyProfile(profile) {
  if (!profile || typeof profile !== 'object') return;
  const github = require('./github');
  const keys = require('./keys');
  const repo = typeof profile.nodesRepo === 'string' ? profile.nodesRepo.trim() : '';
  let keyId = null;
  if (profile.github && typeof profile.github.value === 'string' && profile.github.value.trim()) {
    const value = profile.github.value.trim();
    const print = require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 12);
    const already = keys.list().find((k) => k.service === 'github' && k.fingerprint === print);
    keyId = already ? already.id : keys.add({ label: profile.github.label || 'GitHub (from my GIRAFE)', service: 'github', value }).id;
  }
  if (!repo) return;
  let st;
  try { st = await github.status(); } catch { return; }
  if (st.connected) return;                                   // this computer already has a repository
  if (!keyId) keyId = (keys.list().find((k) => k.service === 'github') || {}).id || null;
  if (!keyId) { profileNote = `Your GIRAFE says your nodes are in ${repo}, but this computer has no GitHub key yet.`; return; }
  try {
    const r = await github.connect({ keyId, repo });
    const remote = Object.values(r.nodes || {}).filter((n) => n.state === 'remote').length;
    profileNote = `Connected to ${repo} from your GIRAFE profile${remote ? ` · ${remote} node${remote === 1 ? '' : 's'} waiting on GitHub` : ''}.`;
  } catch (e) {
    profileNote = `Could not connect to ${repo} from your GIRAFE profile: ${e.message}`;
  }
}

// Your nodes (not the ones that come with the kit) that GitHub doesn't hold as they are here.
async function unsaved() {
  const github = require('./github');
  const mine = (() => { try { return fs.readdirSync(store.NODES, { withFileTypes: true }).filter((d) => d.isDirectory() && store.ID_RE.test(d.name) && !SHIPPED.includes(d.name)).map((d) => d.name); } catch { return []; } })();
  const st = await github.status({ remote: true }).catch(() => ({ connected: false }));
  if (!st.connected) return { github: false, ids: mine, error: null };
  if (st.error) return { github: true, ids: mine, error: st.error };
  return { github: true, ids: mine.filter((id) => !['clean'].includes(st.nodes[id]?.state)), states: st.nodes, error: null };
}

// Save to GitHub what can be saved (new or changed here). Returns what is still not saved.
async function saveAll() {
  const github = require('./github');
  const u = await unsaved();
  if (!u.github || u.error) return u;
  const left = [];
  for (const id of u.ids) {
    const state = u.states[id]?.state;
    if (!['new', 'changed', 'deleted'].includes(state)) { left.push({ id, why: state === 'conflict' ? 'changed both here and on GitHub' : state === 'behind' ? 'GitHub has a newer version' : state || 'not checked' }); continue; }
    try { await github.save({ id, message: `Saved before leaving this computer: ${id}` }); }
    catch (e) { left.push({ id, why: e.message }); }
  }
  return { github: true, ids: left.map((x) => x.id), left, error: null };
}

function eraseAll() {
  const root = store.ROOT;
  for (const name of fs.readdirSync(root)) {
    if (name === 'nodes') {
      for (const id of fs.readdirSync(path.join(root, 'nodes'))) if (!SHIPPED.includes(id)) fs.rmSync(path.join(root, 'nodes', id), { recursive: true, force: true });
      continue;
    }
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

// Leave this computer. erase=false: keep it ready (nothing changes). erase=true: save to GitHub,
// sign out of the market and GIRAFE, erase everything of yours. force: erase even with nodes not
// saved (the page asked you first, by name).
async function leave({ erase = false, force = false } = {}) {
  if (!erase) return { ok: true, kept: true };
  if (busy) return busy;
  busy = (async () => {
    const r = await saveAll();
    if (r.error) return { ok: false, code: 'github', error: `GitHub can't be reached (${r.error}). Nothing was erased.` };
    if (r.ids.length && !force) {
      return { ok: false, code: 'unsaved', github: r.github, unsaved: r.left || r.ids.map((id) => ({ id, why: 'not on GitHub' })),
        error: r.github ? 'Some nodes could not be saved to GitHub. Nothing was erased.' : 'GitHub is not set up, so your nodes are only on this computer. Nothing was erased.' };
    }
    try { await require('./market-link').disconnect(); } catch { /* signed out anyway below */ }
    await link.disconnect();
    eraseAll();
    return { ok: true, erased: true, restart: require('./updater').restartSoon() };
  })();
  try { return await busy; } finally { busy = null; }
}

// A computer that isn't yours, with no page open for a while: leave and erase by itself.
async function idleCheck() {
  if (open()) return;
  const s = read();
  if (s.trust !== 'passing' || !link.status().connected) return;
  if (Date.now() - (s.beatAt || 0) < IDLE_MS) return;
  const r = await leave({ erase: true });
  if (!r.ok) note = `Not erased when you left: ${r.error}${r.unsaved ? ' (' + r.unsaved.map((x) => x.id).join(', ') + ')' : ''}`;
}

function startTimers() {
  if (open()) return;
  check().catch(() => {});
  idleCheck().catch(() => {});
  setInterval(() => { check().catch(() => {}); }, CHECK_MS).unref();
  setInterval(() => { idleCheck().catch(() => {}); }, 60_000).unref();
}

module.exports = { status, signIn, beat, check, leave, unsaved, saveAll, idleCheck, startTimers, eraseAll, chainReport, applyProfile, profileSays, servedOn, IDLE_MS };
