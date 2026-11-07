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
  if (!res.ok) throw Object.assign(new Error(data.error || `GIRAFE answered HTTP ${res.status}`), { status: res.status, code: data.code || (res.status === 426 ? 'kit-outdated' : null) });
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

// Pack the node and send it to the linked account: a new node, or a new version of it.
async function send(id) {
  const s = read();
  if (!s?.keyId) throw Object.assign(new Error('Connect to GIRAFE first.'), { needsLink: true });
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
    throw e;
  }
}

module.exports = { status, connect, disconnect, send, base };
