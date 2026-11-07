// Runs inside the sandboxed child process: loads the plugin and gives it ctx.
// Everything ctx can do goes to the host over IPC; nothing else is reachable.
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
    http: () => call('key', {}),
  };
  try {
    const mod = require(msg.file);
    const run = typeof mod === 'function' ? mod : mod && mod.run;
    if (typeof run !== 'function') throw new Error('node.js must export run(ctx): module.exports = { async run(ctx) { ... } }');
    const returned = await run(ctx);
    process.send({ t: 'done', ok: true, returned: returned === undefined ? undefined : returned });
  } catch (e) {
    process.send({ t: 'done', ok: false, error: (e && e.message) || String(e) });
  }
});
