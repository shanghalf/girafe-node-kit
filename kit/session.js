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
const path = require('path');
const store = require('./store');
const link = require('./girafe-link');

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
    note, error: last.error,
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

// Is the link still accepted? A 401 means it was cut (Settings › Connected kits): signed out.
async function check() {
  if (open() || !link.status().connected) return status();
  try {
    await link.whoami();
    last = { checkedAt: Date.now(), ok: true, error: null };
  } catch (e) {
    if (e.status === 401) { await link.forget(); note = 'You were signed out from GIRAFE (the link was cut, or the account changed).'; }
    else last = { checkedAt: Date.now(), ok: null, error: e.message }; // offline: keep going
  }
  return status();
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

module.exports = { status, signIn, beat, check, leave, unsaved, saveAll, idleCheck, startTimers, eraseAll, IDLE_MS };
