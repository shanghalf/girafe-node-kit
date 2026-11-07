// Runs inside the sandboxed child process: loads the plugin and gives it ctx.
// Everything ctx can do goes to the host over IPC; nothing else is reachable.
// No way to the network but ctx.http: the network modules, the builtin-module getter and the
// global fetch are taken away before the plugin's code loads. (Node's permission flags already
// refuse native bindings, add-ons, processes, threads and disk writes.)
const Module = require('module');
const BLOCKED = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process', 'cluster', 'worker_threads', 'inspector', 'undici', 'module', 'vm', 'v8', 'repl']);
const realLoad = Module._load;
const guardedLoad = function (request, ...rest) {
  if (BLOCKED.has(String(request).replace(/^node:/, ''))) throw new Error(`"${request}" is not available to nodes. Use ctx.http, declared in the manifest's "network".`);
  return realLoad.call(this, request, ...rest);
};
const lockModules = () => {
  Object.defineProperty(Module, '_load', { value: guardedLoad, writable: false, configurable: false });
  if (process.getBuiltinModule) Object.defineProperty(process, 'getBuiltinModule', { value: (id) => guardedLoad(id), writable: false, configurable: false });
  for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    try { Object.defineProperty(globalThis, g, { value: undefined, writable: false, configurable: false }); } catch {}
  }
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
    },
    ai: { ask: () => call('ai', {}) },
    // ctx.http({ slot?, method, url, headers?, json?, body? }) -> { status, ok, json?, text? }
    http: (opts) => call('http', opts || {}),
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
