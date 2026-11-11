// Runs inside the sandboxed child process: loads the plugin and gives it ctx.
// Everything ctx can do goes to the host over IPC; nothing else is reachable.
// No way to the network but ctx.http: the network modules (require and import()), the
// builtin-module getter and the global fetch are taken away before the plugin's code loads, and
// the network functions themselves are made unusable. eval / new Function are off for the whole
// process (--disallow-code-generation-from-strings). (Node's permission flags already refuse
// native bindings, add-ons, processes, threads and disk writes.)
const Module = require('module');
const BLOCKED = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises', 'child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'undici', 'module', 'vm', 'v8', 'repl', 'wasi', 'trace_events']);
const NO_NET = `is not available to nodes. Use ctx.http, declared in the manifest's "network".`;
const realLoad = Module._load;
const blocked = (request) => BLOCKED.has(String(request).replace(/^node:/, ''));
const guardedLoad = function (request, ...rest) {
  if (blocked(request)) throw new Error(`"${request}" ${NO_NET}`);
  return realLoad.call(this, request, ...rest);
};
// The network itself is made unusable, whichever way a module is reached (require, import(), a
// module that loaded it earlier): the methods every connection goes through throw. Same steps as
// GIRAFE's server/sandbox-lock.js.
const neuterNetwork = () => {
  const refuse = (what) => function refused() { throw new Error(`${what} ${NO_NET}`); };
  const lock = (obj, key, what) => { try { Object.defineProperty(obj, key, { value: refuse(what), writable: false, configurable: false }); } catch {} };
  const lockAll = (obj, what) => { for (const k of Object.getOwnPropertyNames(obj)) { try { if (typeof obj[k] === 'function' && k !== 'constructor') lock(obj, k, what); } catch {} } };
  const net = realLoad('net');
  lock(net.Socket.prototype, 'connect', 'The network'); lock(net.Server.prototype, 'listen', 'The network');
  for (const k of ['connect', 'createConnection', 'createServer']) lock(net, k, 'The network');
  const dgram = realLoad('dgram');
  for (const k of ['bind', 'connect', 'send']) lock(dgram.Socket.prototype, k, 'The network');
  lock(dgram, 'createSocket', 'The network');
  const dns = realLoad('dns');
  lockAll(dns, 'DNS'); lockAll(dns.promises, 'DNS');
  for (const R of [dns.Resolver, dns.promises.Resolver]) if (R && R.prototype) lockAll(R.prototype, 'DNS');
  Module.syncBuiltinESMExports(); // import() sees the locked functions too
};
const lockModules = () => {
  neuterNetwork();
  Object.defineProperty(Module, '_load', { value: guardedLoad, writable: false, configurable: false });
  if (process.getBuiltinModule) Object.defineProperty(process, 'getBuiltinModule', { value: (id) => guardedLoad(id), writable: false, configurable: false });
  // import('node:net') does not go through Module._load: refuse it where Node lets us hook it
  // (22.15+); on older Node the locked functions above are what stops it.
  if (typeof Module.registerHooks === 'function') {
    try { Module.registerHooks({ resolve(specifier, context, next) { if (blocked(specifier)) throw new Error(`"${specifier}" ${NO_NET}`); return next(specifier, context); } }); } catch {}
  }
  for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    try { Object.defineProperty(globalThis, g, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  try { delete process.mainModule; } catch {}
};

let seq = 0;
const waiting = new Map();

function call(name, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    process.send({ t: 'call', id, name, args });
  });
}

// Values arrive as text; give the plugin real types back (same rule as GIRAFE's Code node).
function typed(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s[0] === '[' || s[0] === '{') { try { return JSON.parse(s); } catch {} }
  return v;
}

process.on('message', async (msg) => {
  if (msg.t === 'reply') {
    const w = waiting.get(msg.id); waiting.delete(msg.id);
    if (w) msg.ok ? w.resolve(msg.value) : w.reject(new Error(msg.error));
    return;
  }
  if (msg.t !== 'start') return;
  const raw = msg.inputs || {};
  const inputs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typed(v)]));
  const ctx = {
    inputs,
    raw,
    settings: msg.settings,
    title: msg.title,
    girafe: Object.freeze({ ...msg.girafe }),
    emit: (port, value) => call('emit', { port, value }),
    progress: (text) => call('progress', { text }),
    log: (...a) => call('log', { text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }),
    isFile: (v) => !!(v && typeof v === 'object' && v.key && v.mime),
    files: {
      read: async (ref) => { const r = await call('readFile', { ref }); return { bytes: Buffer.from(r.base64, 'base64'), mime: r.mime }; },
      write: (bytes, mime, name) => call('writeFile', { base64: Buffer.from(bytes).toString('base64'), mime, name }),
      // host API 2: the host downloads it (big results never pass through the node's memory)
      fromUrl: (url, opts = {}) => call('fromUrl', { url, name: opts.name, mime: opts.mime }),
    },
    // host API 2: a small object kept per node across runs (needs "state": true)
    state: { get: () => call('stateGet', {}), set: (value) => call('stateSet', { value }) },
    ai: { ask: () => call('ai', {}) },
    // ctx.http({ slot?, method, url, headers?, json?, body?, form? }) -> { status, ok, json?, text? }
    http: (opts) => call('http', opts || {}),
    // billing: what this run spent at a service the package's "billing" describes
    usage: (report) => call('usage', report || {}),
  };
  try {
    lockModules();
    const mod = require(msg.file);
    const run = typeof mod === 'function' ? mod : mod && mod.run;
    if (typeof run !== 'function') throw new Error('node.js must export run(ctx): module.exports = { async run(ctx) { ... } }');
    const returned = await run(ctx);
    process.send({ t: 'done', ok: true, returned: returned === undefined ? undefined : returned });
  } catch (e) {
    process.send({ t: 'done', ok: false, error: (e && e.message) || String(e) });
  }
});
