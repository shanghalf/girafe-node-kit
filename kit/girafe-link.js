// Linking the kit to a GIRAFE account (optional, one click) and sending nodes to it.
//
// Device link (the OAuth 2.0 "device authorization" pattern, like GitHub's command line):
//   1. kit -> GIRAFE  POST /api/kit/link/start { kitName, kitVersion }
//                     <- { deviceCode, userCode, verifyUrl, interval, expiresIn }
//   2. the browser opens verifyUrl (girafe.live/link?code=...): the person logs in or signs up
//      there - never in the kit - and clicks Allow.
//   3. kit -> GIRAFE  POST /api/kit/link/poll { deviceCode }  every `interval` s
//                     <- { status: pending | approved | denied | expired, token?, account? }
//   4. the token is saved in the key bank as a "girafe" key: encrypted, guarded (it may only go
//      to GIRAFE, in the Authorization header), listed in Keys > Network.
// The token only lets the kit send and update this account's own nodes (checked by GIRAFE).
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const keys = require('./keys');
const netguard = require('./netguard');
const pkgs = require('./package');
const { KIT_VERSION, HOST_API } = require('./version');
const compat = require('./compat');

const FILE = path.join(store.ROOT, '.kit', 'girafe.json');
const base = () => (process.env.KIT_GIRAFE_URL || 'https://girafe.live').replace(/\/$/, '');
let pending = null; // { deviceCode, userCode, verifyUrl, expiresAt, interval, state, error }
let timer = null;

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const write = (d) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2), { mode: 0o600 }); };

async function post(route, body, { token, purpose } = {}) {
  // GIRAFE learns which kit is calling on every request (it refuses one that is too old).
  const headers = { 'content-type': 'application/json', 'x-girafe-kit-version': KIT_VERSION, 'x-girafe-kit-host-api': String(HOST_API) };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await netguard.send(base() + route, { method: 'POST', headers, body: JSON.stringify(body || {}) }, token ? { service: 'girafe', key: token, keyLabel: 'GIRAFE link', purpose } : { purpose });
  } catch (e) {
    if (e instanceof netguard.Blocked) throw e;
    throw new Error(`Can't reach GIRAFE (${base()}): ${e.message}`);
  }
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  if (res.status === 404 && route.startsWith('/api/kit/')) throw Object.assign(new Error(`${new URL(base()).host} doesn't offer linking the kit yet. Everything else in the kit works without it.`), { status: 404 });
  if (data.compat) compat.remember(data.compat);
  // `installed` rides along for the one refusal the kit can fix by itself (see send()).
  if (!res.ok) throw Object.assign(new Error(data.error || `GIRAFE answered HTTP ${res.status}`), { status: res.status, code: data.code || (res.status === 426 ? 'kit-outdated' : null), installed: data.installed || null });
  return data;
}

function status() {
  const s = read();
  return {
    base: base(),
    connected: !!(s && s.keyId && keys.list().some((k) => k.id === s.keyId)),
    account: s?.account || null,
    linkedAt: s?.linkedAt || null,
    pending: pending && { userCode: pending.userCode, verifyUrl: pending.verifyUrl, expiresAt: pending.expiresAt, state: pending.state, error: pending.error || null },
  };
}

async function connect() {
  stopPolling();
  const r = await post('/api/kit/link/start', { kitName: `GIRAFE node kit on ${os.hostname()}`.slice(0, 80), kitVersion: KIT_VERSION }, { purpose: 'Connect to GIRAFE (start)' });
  if (!r.deviceCode || !r.userCode || !r.verifyUrl) throw new Error('GIRAFE gave an unexpected answer.');
  const verify = new URL(r.verifyUrl);
  // Same site only (the host name; a local GIRAFE serves its page and its API on two ports).
  if (verify.hostname !== new URL(base()).hostname || !/^https?:$/.test(verify.protocol)) throw new Error('GIRAFE pointed to a page on another site; refused.');
  pending = { deviceCode: r.deviceCode, userCode: r.userCode, verifyUrl: verify.toString(), expiresAt: Date.now() + (r.expiresIn || 600) * 1000, interval: Math.max(2, r.interval || 3), state: 'waiting' };
  schedule();
  return status();
}

function schedule() { timer = setTimeout(pollOnce, pending.interval * 1000); }
function stopPolling() { clearTimeout(timer); timer = null; }

async function pollOnce() {
  if (!pending || pending.state !== 'waiting') return;
  if (Date.now() > pending.expiresAt) { pending.state = 'expired'; return; }
  try {
    const r = await post('/api/kit/link/poll', { deviceCode: pending.deviceCode }, { purpose: 'Connect to GIRAFE (waiting for approval)' });
    if (r.status === 'approved' && r.token) {
      const old = read();
      if (old?.keyId) keys.remove(old.keyId);
      const k = keys.add({ label: 'GIRAFE link', service: 'girafe', value: r.token });
      write({ keyId: k.id, account: r.account || null, base: base(), linkedAt: new Date().toISOString() });
      pending.state = 'approved';
      return;
    }
    if (r.status === 'denied' || r.status === 'expired') { pending.state = r.status; return; }
  } catch (e) { pending.error = e.message; }
  schedule();
}

async function disconnect() {
  stopPolling(); pending = null;
  const s = read();
  if (s?.keyId) {
    try { const t = keys.use(s.keyId, 'girafe'); await post('/api/kit/link/revoke', {}, { token: t.value, purpose: 'Disconnect from GIRAFE' }); } catch {}
    keys.remove(s.keyId);
  }
  try { fs.unlinkSync(FILE); } catch {}
  return status();
}

// Who the kit is signed in as. 401 = the link was cut (Settings › Connected kits) or the account
// is on hold: the caller signs the kit out.
async function whoami() {
  const s = read();
  if (!s?.keyId) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  const t = keys.use(s.keyId, 'girafe');
  let res;
  try { res = await netguard.send(base() + '/api/kit/me', { method: 'GET', headers: { authorization: `Bearer ${t.value}`, 'x-girafe-kit-version': KIT_VERSION } }, { service: 'girafe', key: t.value, keyLabel: 'GIRAFE link', purpose: 'Check the GIRAFE sign-in' }); }
  catch (e) { if (e instanceof netguard.Blocked) throw e; throw new Error(`Can't reach GIRAFE (${base()}): ${e.message}`); }
  // An older GIRAFE without /api/kit/me: assume the link holds.
  if (res.status === 404) return { account: s.account };
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error(data.error || 'Signed out.'), { status: 401 });
  if (!res.ok) throw new Error(data.error || `GIRAFE answered HTTP ${res.status}`);
  if (data.account) write({ ...s, account: data.account });
  return data;
}

// The same question as whoami, with news: where this kit runs and what state its own chain is in
// (GIRAFE 0.92.0, POST /api/kit/hello). GIRAFE can't reach a computer, so this is how Settings ›
// Node kit can show the chain of every computer you work on. Nothing private goes in it: the
// computer's name, the port, the nodes repository's name and how many nodes are unsaved, whether
// the market is linked - never a key, a path or a node's contents. A GIRAFE from before it
// answers 404, and the kit falls back to /api/kit/me, so an older site keeps working.
async function hello(report) {
  const s = read();
  if (!s?.keyId) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  const t = keys.use(s.keyId, 'girafe');
  let data;
  try {
    data = await post('/api/kit/hello', report || {}, { token: t.value, purpose: 'Tell GIRAFE what this computer is running' });
  } catch (e) {
    if (e.status === 404) return whoami(); // a GIRAFE from before the hello: ask the old way
    throw e;
  }
  if (data.account) write({ ...s, account: data.account });
  return data;
}

// Drop the link on this computer without asking GIRAFE (it already refused it).
async function forget() {
  stopPolling(); pending = null;
  const s = read();
  if (s?.keyId) keys.remove(s.keyId);
  try { fs.unlinkSync(FILE); } catch {}
  return status();
}

// Raise a node's "version" just above what GIRAFE already holds, in its manifest.json.
// Vibe-coding a node means sending it again and again; making the author hand-edit a version
// number on every send is friction with no purpose, so the kit does it.
function raiseVersion(id, installed) {
  const file = path.join(store.NODES, id, 'manifest.json');
  const text = fs.readFileSync(file, 'utf8');
  const m = JSON.parse(text);
  const parts = String(installed || m.version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  // Rewritten in place with a plain replace, so the author's own formatting and comments-by-key
  // order survive: this file is theirs, the kit only touches the one number.
  const re = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  fs.writeFileSync(file, re.test(text) ? text.replace(re, `$1${next}$3`) : JSON.stringify({ ...m, version: next }, null, 2));
  return next;
}

// Pack the node and send it to the linked account: a new node, or a new version of it.
async function send(id) {
  const s = read();
  if (!s?.keyId) throw Object.assign(new Error('Connect to GIRAFE first.'), { needsLink: true });
  const packId = require('./packs').membership()[id];
  if (packId) throw Object.assign(new Error(`"${id}" is part of the pack "${packId}": send the pack (it goes to GIRAFE as one).`), { code: 'in-pack', pack: packId });
  const packed = pkgs.pack(id);
  // Said before anything leaves: a kit GIRAFE refuses, or a node it can't run.
  const why = await compat.beforeSend(packed.manifest);
  if (why) throw Object.assign(new Error(why.text), { code: why.code });
  const t = keys.use(s.keyId, 'girafe');
  try {
    const r = await post('/api/kit/packages', packed.pkg, { token: t.value, purpose: `Send "${id}" ${packed.version} to my GIRAFE` });
    return { ...r, version: packed.version, hash: packed.hash, size: packed.size };
  } catch (e) {
    if (e.status === 401) { keys.remove(s.keyId); try { fs.unlinkSync(FILE); } catch {} throw Object.assign(new Error('GIRAFE no longer accepts this computer\'s link (revoked or expired). Connect again.'), { needsLink: true }); }
    // "that version is already in your account": raise it and send once more, rather than
    // handing the author a chore. `installed` comes from GIRAFE; older ones only say it in words.
    const held = e.installed || (e.status === 409 && /already in your account/.test(e.message) ? (/(\d+\.\d+\.\d+)/.exec(e.message) || [])[1] : null);
    if (held && !send._again) {
      const next = raiseVersion(id, held);
      send._again = true;
      try { const r = await send(id); return { ...r, raisedTo: next }; } finally { send._again = false; }
    }
    throw e;
  }
}

// Send a whole pack: its nodes are installed together, under the pack's title, with one set of keys.
async function sendPack(packId) {
  const s = read();
  if (!s?.keyId) throw Object.assign(new Error('Connect to GIRAFE first.'), { needsLink: true });
  const packed = pkgs.packPack(packId);
  const why = await compat.beforeSendPack(packed.manifests, packed.pack);
  if (why) throw Object.assign(new Error(why.text), { code: why.code });
  const t = keys.use(s.keyId, 'girafe');
  try {
    const r = await post('/api/kit/packs', packed.pkg, { token: t.value, purpose: `Send the pack "${packed.pack.name}" ${packed.version} to my GIRAFE` });
    return { ...r, version: packed.version, hash: packed.hash, size: packed.size };
  } catch (e) {
    if (e.status === 401) { keys.remove(s.keyId); try { fs.unlinkSync(FILE); } catch {} throw Object.assign(new Error('GIRAFE no longer accepts this computer\'s link (revoked or expired). Connect again.'), { needsLink: true }); }
    throw e;
  }
}

module.exports = { status, connect, disconnect, send, sendPack, raiseVersion, base, whoami, hello, forget };
