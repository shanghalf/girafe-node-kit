// Network guard: the only way the kit sends anything to the internet, and a watch on everything
// the kit's process sends anyway.
//
//  - send(): a request that carries a key may only go to that key's own service (its known
//    address), with the key in the login header and nowhere else (not in the address, not in
//    the body). Anything else is refused before it leaves the computer, and logged.
//  - Every outgoing request of this process is observed through Node's diagnostics channels
//    (fetch and http/https). One that did not go through send() is logged as "unexpected".
//  - The log is shown in the kit (🔑 Keys > Network), so you can see where your keys went.
const dc = require('diagnostics_channel');
const crypto = require('crypto');

const OFFICIAL = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com'],
  gemini: ['generativelanguage.googleapis.com'],
  girafe: ['girafe.live'],
  market: ['market.girafe.live'],
  github: ['api.github.com'],
  tripo: ['openapi.tripo3d.ai', 'openapi.tripo3d.com'],
};
// Test runs point the services at a fake local server (KIT_*_URL); that address is allowed too.
function hostsFor(service) {
  const env = { anthropic: process.env.KIT_ANTHROPIC_URL, openai: process.env.KIT_OPENAI_URL, gemini: process.env.KIT_GEMINI_URL, girafe: process.env.KIT_GIRAFE_URL, market: process.env.KIT_MARKET_URL, github: process.env.KIT_GITHUB_URL, tripo: process.env.KIT_TRIPO_URL }[service];
  const extra = [];
  if (env) { try { extra.push(new URL(env).host); } catch {} }
  return [...(OFFICIAL[service] || []), ...extra];
}
const AUTH_HEADER = { anthropic: 'x-api-key', openai: 'authorization', gemini: 'x-goog-api-key', girafe: 'authorization', market: 'authorization', github: 'authorization', tripo: 'authorization' };

const log = [];
const approved = new Map(); // "origin path" -> count of approved requests not yet observed
let seq = 0;
const stats = { requests: 0, withKey: 0, blocked: 0, unexpected: 0 };
const push = (e) => { log.push({ n: ++seq, at: new Date().toISOString(), ...e }); if (log.length > 300) log.shift(); };
const sig = (u) => `${u.origin}${u.pathname}`;

class Blocked extends Error {}

// send(url, init, { service, key, keyLabel, purpose, signal })
async function send(url, init = {}, { service, key, keyLabel, purpose } = {}) {
  const u = new URL(url);
  const entry = { host: u.host, path: u.pathname.replace(/\/models\/[^/:]+/, '/models/…'), purpose: purpose || '', service: service || null, key: keyLabel || null };
  if (key) {
    const hosts = hostsFor(service);
    const why = !hosts.includes(u.host) ? `${u.host} is not ${service}'s address (${hosts.join(', ')})`
      : u.protocol !== 'https:' && !hosts.slice(OFFICIAL[service].length).includes(u.host) ? 'not an encrypted (https) connection'
        : (url.includes(key) ? 'the key was in the address'
          : (typeof init.body === 'string' && init.body.includes(key)) ? 'the key was in the request body'
            : Object.entries(init.headers || {}).some(([h, v]) => String(v).includes(key) && h.toLowerCase() !== AUTH_HEADER[service]) ? 'the key was in an unexpected header' : null);
    if (why) {
      stats.blocked++;
      push({ ...entry, result: 'blocked', detail: why });
      throw new Blocked(`Blocked by the kit's network guard: ${why}. Nothing was sent.`);
    }
  }
  stats.requests++; if (key) stats.withKey++;
  const s = sig(u);
  approved.set(s, (approved.get(s) || 0) + 1);
  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    push({ ...entry, result: res.ok ? 'sent' : 'sent (service said no)', status: res.status, ms: Date.now() - t0 });
    return res;
  } catch (e) {
    push({ ...entry, result: 'failed', detail: e.message, ms: Date.now() - t0 });
    throw e;
  }
}

// The watch: every request this process starts, whoever starts it.
function observed(origin, path) {
  let u; try { u = new URL(path || '/', origin); } catch { return; }
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') {
    if (!process.env.KIT_ANTHROPIC_URL && !process.env.KIT_OPENAI_URL && !process.env.KIT_GEMINI_URL && !process.env.KIT_GIRAFE_URL && !process.env.KIT_GITHUB_URL && !process.env.KIT_TRIPO_URL) return;
  }
  const s = sig(u);
  const left = approved.get(s) || 0;
  if (left > 0) { approved.set(s, left - 1); return; }
  stats.unexpected++;
  push({ host: u.host, path: u.pathname, purpose: 'not made through the guard', result: 'unexpected' });
}
dc.subscribe('undici:request:create', ({ request }) => observed(request.origin, request.path));
dc.subscribe('http.client.request.start', ({ request }) => {
  try { observed(`${request.protocol}//${request.host}`, request.path); } catch {}
});

// For the paste step: how many internet requests happened between mark() and count().
const mark = () => ({ seq, unexpected: stats.unexpected });
const since = (m) => ({ internet: log.filter((e) => e.n > m.seq && e.result !== 'blocked').length, unexpected: stats.unexpected - m.unexpected });

// A request the kit started outside this process (git pull for "Update the kit"): logged, so
// the Network list shows it too. It never carries a key.
function note(e) { push({ host: String(e.host || ''), path: String(e.path || ''), purpose: String(e.purpose || ''), service: null, key: null, result: String(e.result || 'started') }); }

function report() {
  return { stats: { ...stats }, log: log.slice(-100).reverse(), hosts: Object.fromEntries(Object.keys(OFFICIAL).map((s) => [s, hostsFor(s)])) };
}

module.exports = { send, note, mark, since, report, Blocked, AUTH_HEADER, hostsFor, OFFICIAL };
