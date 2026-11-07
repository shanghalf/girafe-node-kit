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
const { HOST_API, SUPPORTED_HOST_APIS, GIRAFE_VERSION } = require('./version');
const keys = require('./keys');
const netguard = require('./netguard');
const HTTP_TIMEOUT_MS = 120_000;
const HTTP_MAX_BYTES = 40 * 1024 * 1024;
const KEY_SERVICES = ['anthropic', 'openai', 'gemini'];
// Where each service's official API starts; test runs swap it for a fake server (KIT_*_URL).
const OFFICIAL_BASE = { gemini: ['https://generativelanguage.googleapis.com/v1beta/models', 'KIT_GEMINI_URL'], anthropic: ['https://api.anthropic.com/v1', 'KIT_ANTHROPIC_URL'], openai: ['https://api.openai.com/v1', 'KIT_OPENAI_URL'] };

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
  if (!SUPPORTED_HOST_APIS.includes(m.hostApi)) problems.push(`"hostApi" is ${JSON.stringify(m.hostApi)}; this GIRAFE runs host API ${SUPPORTED_HOST_APIS.join(' and ')}`);
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
  if (caps.network !== undefined && (!Array.isArray(caps.network) || caps.network.some((h) => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)))) problems.push('"network": a list of host names, like ["api.example.com"]');
  if (caps.keys !== undefined) {
    if (!Array.isArray(caps.keys)) problems.push('"keys": a list like [{ "slot": "gemini", "service": "gemini", "label": "Gemini API key" }]');
    else for (const k of caps.keys) {
      if (!k || !/^[a-z][a-z0-9_]{0,23}$/.test(k.slot || '')) problems.push(`key slot ${JSON.stringify(k && k.slot)}: a short lowercase name`);
      else if (!KEY_SERVICES.includes(k.service)) problems.push(`key slot "${k.slot}": "service" must be one of ${KEY_SERVICES.join(', ')}`);
      else if (m.hostApi < 1) problems.push(`key slots need "hostApi": 1`);
      else if (!netguard.hostsFor(k.service).slice(0, 1).every((h) => (caps.network || []).includes(h))) problems.push(`key slot "${k.slot}": add "${netguard.hostsFor(k.service)[0]}" to "network"`);
    }
  }
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
function runPlugin(plugin, { inputs, settings, keySlots, title, signal, onProgress }) {
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
      ai() { throw new Error('ctx.ai is not in the host API yet; call a service with ctx.http and a key slot.'); },
      // ctx.http: the plugin's only way to the internet. The host adds the key of a declared slot
      // (the plugin never sees it) and sends through the network guard.
      async http({ slot, method = 'GET', url, headers = {}, json, body }) {
        if (plugin.hostApi < 1) throw new Error('ctx.http needs "hostApi": 1 in the manifest');
        let u; try { u = new URL(String(url)); } catch { throw new Error('ctx.http: not a valid address'); }
        if (u.protocol !== 'https:') throw new Error('ctx.http: https addresses only');
        if (!(plugin.capabilities.network || []).includes(u.hostname)) throw new Error(`ctx.http: ${u.hostname} is not in the manifest's "network" list`);
        const h = {};
        for (const [k, v] of Object.entries(headers || {})) {
          if (/^(authorization|x-api-key|x-goog-api-key|cookie|host|proxy-authorization)$/i.test(k)) throw new Error(`ctx.http: the "${k}" header is set by the host (use a key slot)`);
          h[k.toLowerCase()] = String(v);
        }
        let guard = { purpose: `plugin ${plugin.id}` };
        let target = u.toString();
        if (slot) {
          const decl = (plugin.capabilities.keys || []).find((k) => k.slot === slot);
          if (!decl) throw new Error(`ctx.http: no key slot "${slot}" in the manifest`);
          const keyId = keySlots && keySlots[slot];
          if (!keyId) throw new Error(`Choose a key for "${decl.label || slot}" in the node's panel.`);
          const k = keys.use(keyId, decl.service);
          h[netguard.AUTH_HEADER[decl.service]] = decl.service === 'openai' ? `Bearer ${k.value}` : k.value;
          guard = { service: decl.service, key: k.value, keyLabel: k.label, purpose: `plugin ${plugin.id} · slot ${slot}` };
          const [official, env] = OFFICIAL_BASE[decl.service];
          if (process.env[env] && target.startsWith(official)) target = process.env[env] + target.slice(official.length);
        }
        const init = { method: String(method).toUpperCase(), headers: h };
        if (json !== undefined) { init.body = JSON.stringify(json); h['content-type'] = h['content-type'] || 'application/json'; }
        else if (body !== undefined) init.body = String(body);
        if (init.body && init.body.length > HTTP_MAX_BYTES) throw new Error('ctx.http: request over 40 MB');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
        const stop = () => ctrl.abort();
        signal && signal.addEventListener('abort', stop, { once: true });
        try {
          const res = await netguard.send(target, { ...init, signal: ctrl.signal }, guard);
          const text = await res.text();
          if (text.length > HTTP_MAX_BYTES) throw new Error('ctx.http: answer over 40 MB');
          let parsed; try { parsed = JSON.parse(text); } catch {}
          return { status: res.status, ok: res.ok, json: parsed, text: parsed === undefined ? text.slice(0, 1_000_000) : undefined };
        } catch (e) {
          if (e instanceof netguard.Blocked) throw e;
          if (ctrl.signal.aborted) throw new Error(signal && signal.aborted ? 'Stopped' : `ctx.http: no answer from ${u.hostname} after ${HTTP_TIMEOUT_MS / 1000} s`);
          throw new Error(`ctx.http: ${e.message}`);
        } finally { clearTimeout(timer); signal && signal.removeEventListener('abort', stop); }
      },
    };

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'call') {
        Promise.resolve().then(() => {
          if (!host[msg.name]) throw new Error('unknown host call ' + msg.name);
          return host[msg.name](msg.args || {});
        }).then((value) => ({ t: 'reply', id: msg.id, ok: true, value }), (e) => ({ t: 'reply', id: msg.id, ok: false, error: e.message }))
          .then((reply) => { if (!done) child.send(reply); });
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
