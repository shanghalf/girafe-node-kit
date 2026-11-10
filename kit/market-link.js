// Publishing to the GIRAFE Market (optional): link the kit to a market account, then submit a
// node or a pack for review, with the pictures and videos of its market page.
//
// Same device link as GIRAFE (see girafe-link.js), against the market:
//   kit -> market  POST /api/kit/link/start { kitName, kitVersion }  <- { deviceCode, userCode, verifyUrl, ... }
//   the person approves on the market (market.girafe.live/link?code=...), signed in there
//   kit -> market  POST /api/kit/link/poll { deviceCode }  <- { status, token?, account? }
// The token (mk_...) is kept in the key bank as a "market" key: encrypted, only ever sent to the
// market, in the Authorization header. It can submit packages and read this account's submissions.
//
// Submitting: the signed .gnode / .gpack (the same file GIRAFE gets), then, when the node's folder
// has a market/ folder, its listing.json and its pictures/videos one by one. market/ is never packed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const keys = require('./keys');
const netguard = require('./netguard');
const pkgs = require('./package');
const { KIT_VERSION } = require('./version');

const FILE = path.join(store.ROOT, '.kit', 'market.json');
const base = () => (process.env.KIT_MARKET_URL || 'https://market.girafe.live').replace(/\/$/, '');
const MEDIA_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const MAX_IMAGES = 8; const MAX_VIDEOS = 2;
const IMAGE_BYTES = 6 * 1024 * 1024; const VIDEO_BYTES = 80 * 1024 * 1024;
let pending = null;
let timer = null;

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const write = (d) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2), { mode: 0o600 }); };
const forget = () => { const s = read(); if (s?.keyId) keys.remove(s.keyId); try { fs.unlinkSync(FILE); } catch {} };

async function call(method, route, { json, raw, type, token, purpose } = {}) {
  const headers = { 'x-girafe-kit-version': KIT_VERSION };
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (raw !== undefined) { headers['content-type'] = type || 'application/octet-stream'; body = raw; }
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await netguard.send(base() + route, { method, headers, body }, token ? { service: 'market', key: token, keyLabel: 'GIRAFE Market link', purpose } : { purpose });
  } catch (e) {
    if (e instanceof netguard.Blocked) throw e;
    throw new Error(`Can't reach the market (${base()}): ${e.message}`);
  }
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch {}
  if (res.status === 401 && token) { forget(); throw Object.assign(new Error('The market no longer accepts this computer\'s link (revoked). Connect again.'), { needsLink: true }); }
  if (!res.ok) throw Object.assign(new Error(data.error || `The market answered HTTP ${res.status}`), { status: res.status, code: data.code || null });
  return data;
}
function token() {
  const s = read();
  if (!s?.keyId || !keys.list().some((k) => k.id === s.keyId)) throw Object.assign(new Error('Connect the kit to the market first.'), { needsLink: true });
  return keys.use(s.keyId, 'market').value;
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
  clearTimeout(timer);
  const r = await call('POST', '/api/kit/link/start', { json: { kitName: `GIRAFE node kit on ${os.hostname()}`.slice(0, 80), kitVersion: KIT_VERSION }, purpose: 'Connect to the market (start)' });
  if (!r.deviceCode || !r.userCode || !r.verifyUrl) throw new Error('The market gave an unexpected answer.');
  const verify = new URL(r.verifyUrl);
  if (verify.hostname !== new URL(base()).hostname || !/^https?:$/.test(verify.protocol)) throw new Error('The market pointed to a page on another site; refused.');
  pending = { deviceCode: r.deviceCode, userCode: r.userCode, verifyUrl: verify.toString(), expiresAt: Date.now() + (r.expiresIn || 600) * 1000, interval: Math.max(2, r.interval || 3), state: 'waiting' };
  timer = setTimeout(pollOnce, pending.interval * 1000);
  return status();
}
async function pollOnce() {
  if (!pending || pending.state !== 'waiting') return;
  if (Date.now() > pending.expiresAt) { pending.state = 'expired'; return; }
  try {
    const r = await call('POST', '/api/kit/link/poll', { json: { deviceCode: pending.deviceCode }, purpose: 'Connect to the market (waiting for approval)' });
    if (r.status === 'approved' && r.token) {
      forget();
      const k = keys.add({ label: 'GIRAFE Market link', service: 'market', value: r.token });
      write({ keyId: k.id, account: r.account || null, base: base(), linkedAt: new Date().toISOString() });
      pending.state = 'approved';
      return;
    }
    if (r.status === 'denied' || r.status === 'expired') { pending.state = r.status; return; }
  } catch (e) { pending.error = e.message; }
  timer = setTimeout(pollOnce, pending.interval * 1000);
}
async function disconnect() {
  clearTimeout(timer); pending = null;
  try { await call('POST', '/api/kit/link/revoke', { json: {}, token: token(), purpose: 'Disconnect from the market' }); } catch {}
  forget();
  return status();
}

// What a node's (or pack's) market/ folder holds: listing.json and the pictures/videos, sorted by
// name (name them 01-..., 02-... to choose the order; the first picture is the card's cover).
function listing(folderId) {
  const dir = path.join(store.NODES, folderId, 'market');
  const out = { dir: `workspace/nodes/${folderId}/market`, listing: null, media: [], cover: null, problems: [] };
  if (!fs.existsSync(dir)) return out;
  try {
    const f = path.join(dir, 'listing.json');
    if (fs.existsSync(f)) out.listing = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { out.problems.push(`listing.json is not valid JSON: ${e.message}`); }
  const captions = (out.listing && typeof out.listing.captions === 'object' && out.listing.captions) || {};
  for (const name of fs.readdirSync(dir).sort()) {
    const type = MEDIA_EXT[path.extname(name).toLowerCase()];
    if (!type) continue;
    const st = fs.statSync(path.join(dir, name));
    if (!st.isFile()) continue;
    const kind = type.startsWith('video/') ? 'video' : 'image';
    // cover.png / cover.jpg / cover.webp: the background of the item's tile, not part of the gallery.
    if (/^cover\.(png|jpe?g|webp)$/i.test(name)) {
      if (st.size > IMAGE_BYTES) out.problems.push(`${name} is over 6 MB: it will not be sent.`);
      else out.cover = { name, kind, type, size: st.size };
      continue;
    }
    const max = kind === 'video' ? VIDEO_BYTES : IMAGE_BYTES;
    if (st.size > max) { out.problems.push(`${name} is over ${kind === 'video' ? '80' : '6'} MB: it will not be sent.`); continue; }
    out.media.push({ name, kind, type, size: st.size, caption: String(captions[name] || '') });
  }
  const imgs = out.media.filter((m) => m.kind === 'image'); const vids = out.media.filter((m) => m.kind === 'video');
  if (imgs.length > MAX_IMAGES) out.problems.push(`${imgs.length} pictures: only the first ${MAX_IMAGES} are sent.`);
  if (vids.length > MAX_VIDEOS) out.problems.push(`${vids.length} videos: only the first ${MAX_VIDEOS} are sent.`);
  out.media = [...imgs.slice(0, MAX_IMAGES), ...vids.slice(0, MAX_VIDEOS)].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Submit a node (kind 'node') or a pack (kind 'pack') for review.
async function submit(id, { kind = 'node', notes = '' } = {}) {
  const t = token();
  if (kind === 'node') {
    const packId = require('./packs').membership()[id];
    if (packId) throw Object.assign(new Error(`"${id}" is part of the pack "${packId}": submit the pack.`), { code: 'in-pack', pack: packId });
  }
  const packed = kind === 'pack' ? pkgs.packPack(id) : pkgs.pack(id);
  const what = kind === 'pack' ? `the pack "${packed.pack.name}"` : `"${id}"`;
  const r = await call('POST', `/api/kit/submit?notes=${encodeURIComponent(String(notes).slice(0, 400))}`, { raw: JSON.stringify(packed.pkg), type: 'application/json', token: t, purpose: `Submit ${what} ${packed.version} to the market` });
  const sub = r.submission;
  const L = listing(id);
  const sent = { listing: false, cover: false, media: 0, problems: [...L.problems] };
  if (L.listing) {
    try { await call('POST', `/api/kit/submissions/${sub.id}/listing`, { json: L.listing, token: t, purpose: `Market page text of ${what}` }); sent.listing = true; }
    catch (e) { sent.problems.push(`listing.json: ${e.message}`); }
  }
  const uploads = [...(L.cover ? [{ ...L.cover, role: 'cover', caption: '' }] : []), ...L.media];
  for (const m of uploads) {
    try {
      const buf = fs.readFileSync(path.join(store.NODES, id, 'market', m.name));
      await call('POST', `/api/kit/submissions/${sub.id}/media?caption=${encodeURIComponent(m.caption)}${m.role ? `&role=${m.role}` : ''}`, { raw: buf, type: m.type, token: t, purpose: `Market ${m.role === 'cover' ? 'tile background' : m.kind} ${m.name} of ${what}` });
      if (m.role === 'cover') sent.cover = true; else sent.media++;
    } catch (e) { sent.problems.push(`${m.name}: ${e.message}`); if (e.needsLink) break; }
  }
  return { submission: sub, version: packed.version, size: packed.size, sent, message: r.message };
}

async function submissions() {
  return call('GET', '/api/kit/submissions', { token: token(), purpose: 'My market submissions' });
}

module.exports = { status, connect, disconnect, listing, submit, submissions, base };
