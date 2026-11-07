// Plugin nodes: discovery, manifest checks, and running one firing in a sandbox.
//
// A plugin is a folder in workspace/nodes/<id>/ with:
//   manifest.json  what the node is, what it needs (see HOST_API.md)
//   node.js        module.exports = { async run(ctx) { ... } }
//
// Every firing runs in its own child process with Node's permission model:
// it can read its own folder and nothing else on disk, cannot write files,
// cannot start processes. It talks to GIRAFE only through ctx (host API).
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const store = require('./store');
const { HOST_API, GIRAFE_VERSION } = require('./version');

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox']);
const CHILD = path.join(__dirname, 'sandbox-child.js');
const TIMEOUT_MS = 60_000;
const MEMORY_MB = 128;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// ">=0.67.0" is the only range form for now: the oldest GIRAFE the node needs.
function girafeOk(range) {
  if (!range) return true;
  const m = /^>=\s*(\d+\.\d+(?:\.\d+)?)$/.exec(String(range).trim());
  return m ? cmpVersion(GIRAFE_VERSION, m[1]) >= 0 : false;
}

function checkManifest(m, dirName) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['manifest.json is not a JSON object'];
  if (m.id !== dirName) problems.push(`"id" must be "${dirName}" (the folder name)`);
  if (!store.ID_RE.test(String(m.id || ''))) problems.push('"id": lowercase letters, digits and dashes only');
  if (!m.name) problems.push('"name" is missing');
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) problems.push('"version" must look like 1.0.0');
  if (m.hostApi !== HOST_API) problems.push(`"hostApi" is ${JSON.stringify(m.hostApi)}, this GIRAFE speaks host API ${HOST_API}`);
  if (!girafeOk(m.girafe)) problems.push(`needs GIRAFE ${m.girafe}, this is ${GIRAFE_VERSION}`);
  const outs = m.outputs ?? ['out'];
  if (!Array.isArray(outs) || !outs.length || outs.some((o) => !/^[a-z][a-z0-9_]{0,23}$/.test(o))) problems.push('"outputs": a list of short lowercase names, like ["out"] or ["yes", "no"]');
  for (const f of m.fields || []) {
    if (!f || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(f.key || '')) problems.push(`field ${JSON.stringify(f && f.key)}: bad key`);
    else if (!FIELD_TYPES.has(f.type)) problems.push(`field "${f.key}": type must be one of ${[...FIELD_TYPES].join(', ')}`);
    else if (f.type === 'select' && !Array.isArray(f.options)) problems.push(`field "${f.key}": a select needs "options"`);
  }
  const caps = m.capabilities || {};
  for (const k of Object.keys(caps)) if (!['network', 'ai', 'keys', 'files'].includes(k)) problems.push(`capability "${k}" is unknown`);
  return problems;
}

function listPlugins() {
  const out = [];
  for (const dir of fs.readdirSync(store.NODES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = path.join(store.NODES, dir.name);
    let m = null, problems = [];
    try { m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')); }
    catch (e) { problems = ['manifest.json: ' + e.message]; }
    if (m) problems = checkManifest(m, dir.name);
    if (!fs.existsSync(path.join(base, 'node.js'))) problems.push('node.js is missing');
    out.push({
      type: 'plugin:' + dir.name,
      id: dir.name,
      name: (m && m.name) || dir.name,
      version: m && m.version,
      description: (m && m.description) || '',
      color: (m && m.color) || '#8a93a6',
      icon: (m && m.icon) || '🧩',
      inputs: (m && m.inputs) || { min: 0, max: 8 },
      outputs: (m && m.outputs) || ['out'],
      fields: (m && m.fields) || [],
      capabilities: (m && m.capabilities) || {},
      hostApi: m && m.hostApi,
      girafe: m && m.girafe,
      problems,
    });
  }
  return out;
}

function getPlugin(id) {
  return listPlugins().find((p) => p.id === id) || null;
}

// Runs one firing. `inputs` = { A: value, B: value }, values as they travel between nodes.
// Resolves to { outputs: [{ port, value }], logs, progress } or rejects with a clear Error.
function runPlugin(plugin, { inputs, settings, title, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (plugin.problems.length) return reject(new Error(`${plugin.name} can't run: ${plugin.problems[0]}`));
    const dir = path.join(store.NODES, plugin.id);
    const child = fork(CHILD, [], {
      execArgv: [
        `--max-old-space-size=${MEMORY_MB}`,
        '--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${CHILD}`,
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {}, // a plugin sees no environment variables: no keys, no paths
    });
    const outputs = [];
    const logs = [];
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer); signal && signal.removeEventListener('abort', onAbort);
      try { child.kill('SIGKILL'); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`${plugin.name} took longer than ${TIMEOUT_MS / 1000} s and was stopped`)), TIMEOUT_MS);
    const onAbort = () => finish(new Error('Stopped'));
    signal && signal.addEventListener('abort', onAbort);
    const keepLog = (s) => { if (logs.length < 200) logs.push(String(s).slice(0, 2000)); };
    child.stdout.on('data', (d) => keepLog(d.toString().trimEnd()));
    child.stderr.on('data', (d) => keepLog(d.toString().trimEnd()));

    // The host side of the host API. Every capability a plugin uses comes through here.
    const host = {
      emit({ port, value }) {
        if (!plugin.outputs.includes(port)) throw new Error(`no output called "${port}" (the manifest lists ${plugin.outputs.join(', ')})`);
        if (outputs.length >= 1000) throw new Error('more than 1000 packets from one firing');
        outputs.push({ port, value: toWire(value) });
      },
      progress({ text }) { onProgress && onProgress(String(text).slice(0, 200)); },
      log({ text }) { keepLog(text); },
      readFile({ ref }) {
        if (!(plugin.capabilities.files === 'read' || plugin.capabilities.files === 'readwrite')) throw new Error('reading files needs "capabilities": { "files": "read" }');
        const p = ref && store.filePath(ref.key);
        if (!p || !fs.existsSync(p)) throw new Error('no such file');
        return { base64: fs.readFileSync(p).toString('base64'), mime: store.mimeOf(ref.key) };
      },
      writeFile({ base64, mime, name }) {
        if (plugin.capabilities.files !== 'readwrite') throw new Error('making files needs "capabilities": { "files": "readwrite" }');
        const buf = Buffer.from(String(base64 || ''), 'base64');
        if (buf.length > 25 * 1024 * 1024) throw new Error('file over 25 MB');
        const f = store.saveFile(buf, mime);
        return { imageUrl: '/files/' + f.key, key: f.key, mime: f.mime, name: name ? String(name).slice(0, 120) : undefined, size: f.size };
      },
      ai() { throw new Error('AI calls are not in host API 0 yet. Coming: ctx.ai.ask(), run with the sandbox key or the user\'s key on GIRAFE.'); },
      key() { throw new Error('API keys are not in host API 0 yet. Coming: ctx.http() with a key slot; the plugin never sees the key.'); },
    };

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'call') {
        let reply;
        try { reply = { t: 'reply', id: msg.id, ok: true, value: host[msg.name] ? host[msg.name](msg.args || {}) : (() => { throw new Error('unknown host call ' + msg.name); })() }; }
        catch (e) { reply = { t: 'reply', id: msg.id, ok: false, error: e.message }; }
        child.send(reply);
      } else if (msg.t === 'done') {
        if (msg.ok) {
          if (msg.returned !== undefined) {
            const r = msg.returned;
            if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).every((k) => plugin.outputs.includes(k))) {
              for (const [port, value] of Object.entries(r)) if (value !== undefined && value !== null) outputs.push({ port, value: toWire(value) });
            } else outputs.push({ port: plugin.outputs[0], value: toWire(r) });
          }
          finish(null, { outputs, logs });
        } else finish(new Error(msg.error || 'the node failed'));
      }
    });
    child.on('exit', (code, sig) => {
      if (!done) finish(new Error(code === 134 || /heap/i.test(logs.join(' ')) ? `${plugin.name} ran out of memory (${MEMORY_MB} MB)` : `${plugin.name} stopped unexpectedly (${sig || 'exit ' + code})`));
    });
    child.on('error', (e) => finish(e));
    child.send({ t: 'start', file: path.join(dir, 'node.js'), inputs, settings: settings || {}, title, girafe: { version: GIRAFE_VERSION, hostApi: HOST_API } });
  });
}

// Values travel between nodes as text, or as file references ({ imageUrl, key, mime }).
function toWire(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && !Array.isArray(v) && v.key && v.mime) return v;
  return JSON.stringify(v);
}

module.exports = { listPlugins, getPlugin, runPlugin, checkManifest, girafeOk, cmpVersion, toWire };
