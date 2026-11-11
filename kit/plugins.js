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
const pluginState = require('./plugin-state');
const HTTP_TIMEOUT_MS = 120_000;
const HTTP_MAX_BYTES = 40 * 1024 * 1024;
const KEY_SERVICES = ['anthropic', 'openai', 'gemini', 'tripo'];
const KEY_SERVICES_V1 = ['anthropic', 'openai', 'gemini'];
const BEARER = new Set(['openai', 'tripo']);
const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const MAX_SECONDS = 3600;
// Where each service's official API starts; test runs swap it for a fake server (KIT_*_URL).
const OFFICIAL_BASE = { gemini: ['https://generativelanguage.googleapis.com/v1beta/models', 'KIT_GEMINI_URL'], anthropic: ['https://api.anthropic.com/v1', 'KIT_ANTHROPIC_URL'], openai: ['https://api.openai.com/v1', 'KIT_OPENAI_URL'], tripo: ['https://openapi.tripo3d.ai/v3', 'KIT_TRIPO_URL'], tripoCom: ['https://openapi.tripo3d.com/v3', 'KIT_TRIPO_COM_URL'] };
// Test runs: an address under a service's official base goes to its fake server instead.
function testRedirect(target) {
  for (const [official, env] of Object.values(OFFICIAL_BASE)) if (process.env[env] && target.startsWith(official)) return process.env[env] + target.slice(official.length);
  return target;
}
// "network" entries: exact host names, or (host API 2) "*.example.com" for any host under it.
function hostAllowed(caps, host) {
  return (caps.network || []).some((h) => h === host || (h.startsWith('*.') && host.endsWith(h.slice(1))));
}

const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox', 'file', 'tasks']);
const CHILD = path.join(__dirname, 'sandbox-child.js');
const TIMEOUT_MS = 60_000;
const MEMORY_MB = 128;

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// What the kit checks a manifest against. The numbers in version.js are only a FALLBACK, for a
// kit that has never reached GIRAFE: whenever the real GIRAFE has answered /api/kit/compat, its
// own version and host APIs are used instead. The kit must never be stricter than the GIRAFE it
// is linked to - a frozen copy of GIRAFE's rules is what made a kit refuse nodes GIRAFE accepts.
function rules() {
  let live = null;
  try { live = require('./compat').known(); } catch { /* compat not loaded (tests) */ }
  return {
    girafeVersion: (live && live.girafeVersion) || GIRAFE_VERSION,
    hostApis: (live && live.hostApis && live.hostApis.length) ? live.hostApis : SUPPORTED_HOST_APIS,
    live: !!(live && live.girafeVersion),
  };
}

// ">=0.67.0" is the only range form for now: the oldest GIRAFE the node needs.
function girafeOk(range, have) {
  if (!range) return true;
  const m = /^>=\s*(\d+\.\d+(?:\.\d+)?)$/.exec(String(range).trim());
  return m ? cmpVersion(have || rules().girafeVersion, m[1]) >= 0 : false;
}

// problems = what no GIRAFE would accept (shape, names, contradictions): they block packing.
// warnings = what only THIS kit doesn't know (a field type or capability a newer GIRAFE added):
// they are shown, never blocking - the linked GIRAFE decides, and compat.checkNode asks it first.
function checkManifest(m, dirName, opts) {
  return checkManifestFull(m, dirName, opts).problems;
}

function checkManifestFull(m, dirName, opts = {}) {
  const r = { ...rules(), ...opts };
  const GIRAFE_NOW = r.girafeVersion;
  const HOST_APIS = r.hostApis;
  const warnings = [];
  const problems = [];
  if (!m || typeof m !== 'object') return { problems: ['manifest.json is not a JSON object'], warnings };
  if (m.id !== dirName) problems.push(`"id" must be "${dirName}" (the folder name)`);
  if (!store.ID_RE.test(String(m.id || ''))) problems.push('"id": lowercase letters, digits and dashes only');
  if (!m.name) problems.push('"name" is missing');
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) problems.push('"version" must look like 1.0.0');
  // Two different questions, and only the first is the kit's to answer:
  //   can THIS KIT run the node? (its own runtime - a problem, nothing else can be done here)
  //   will GIRAFE accept it? (GIRAFE's call - a warning, so a node can be built before GIRAFE catches up)
  if (!SUPPORTED_HOST_APIS.includes(m.hostApi)) problems.push(`"hostApi" is ${JSON.stringify(m.hostApi)}; this kit runs host API ${SUPPORTED_HOST_APIS.join(' and ')}${Number.isInteger(m.hostApi) && m.hostApi > Math.max(...SUPPORTED_HOST_APIS) ? ' (update the kit to build for a newer one)' : ''}`);
  else if (!HOST_APIS.includes(m.hostApi)) warnings.push(`"hostApi" is ${m.hostApi}; ${r.live ? `GIRAFE ${GIRAFE_NOW} runs host API ${HOST_APIS.join(' and ')} and will refuse it until it is updated` : `this kit knows host API ${HOST_APIS.join(' and ')} - press "Align with GIRAFE" to check against your real GIRAFE`}`);
  if (!girafeOk(m.girafe, GIRAFE_NOW)) warnings.push(`needs GIRAFE ${m.girafe}, ${r.live ? `and yours is ${GIRAFE_NOW}` : `and this kit knows ${GIRAFE_NOW} (press "Align with GIRAFE" to check against your real one)`}`);
  if (m.category !== undefined && (typeof m.category !== 'string' || !m.category.trim() || m.category.length > 40)) problems.push('"category": a short name (40 characters at most)');
  const outs = m.outputs ?? ['out'];
  if (!Array.isArray(outs) || outs.some((o) => !/^[a-z][a-z0-9_]{0,23}$/.test(o))) problems.push('"outputs": a list of short lowercase names, like ["out"] or ["yes", "no"]');
  else if (!outs.length && !(m.hostApi >= 2)) problems.push('"outputs": [] (a node that sends nothing on) needs "hostApi": 2');
  if (m.streams !== undefined && typeof m.streams !== 'boolean') problems.push('"streams": true or false');
  else if (m.streams === true && !(m.hostApi >= 2)) problems.push('"streams" needs "hostApi": 2');
  else if (m.streams === true && Array.isArray(outs) && !outs.length) problems.push('"streams": a node with no outputs sends nothing');
  if (m.display !== undefined && m.display !== 'runs') problems.push('"display": only "runs" exists');
  else if (m.display === 'runs' && !(m.hostApi >= 2)) problems.push('"display": "runs" needs "hostApi": 2');
  for (const f of m.fields || []) {
    if (!f || !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(f.key || '')) problems.push(`field ${JSON.stringify(f && f.key)}: bad key`);
    else if (!FIELD_TYPES.has(f.type)) warnings.push(`field "${f.key}": this kit doesn't know the type "${f.type}" (it knows ${[...FIELD_TYPES].join(', ')}). If your GIRAFE added it, update the kit; GIRAFE itself decides when the node is sent.`);
    else if (f.type === 'file' && !(m.hostApi >= 2)) problems.push(`field "${f.key}": file fields need "hostApi": 2`);
    else if (f.type === 'file' && f.accept !== undefined && (typeof f.accept !== 'string' || f.accept.length > 200)) problems.push(`field "${f.key}": "accept" is a short list like ".glb,.fbx" or "image/*"`);
    else if (f.type === 'select' && !Array.isArray(f.options)) problems.push(`field "${f.key}": a select needs "options"`);
    else if (f.type === 'tasks') {
      // host API 2: pick past tasks of a key service, listed from its history (see HOST_API.md).
      const slot = (Array.isArray(m.capabilities?.keys) ? m.capabilities.keys : []).find((k) => k && k.slot === f.slot);
      if (!(m.hostApi >= 2)) problems.push(`field "${f.key}": tasks fields need "hostApi": 2`);
      else if (!slot) problems.push(`field "${f.key}": "slot" must name one of the node's key slots (its service's history is read with that key)`);
      else if (f.types !== undefined && (!Array.isArray(f.types) || !f.types.length || f.types.length > 40 || f.types.some((x) => { const v = Array.isArray(x) ? x[0] : x; return typeof v !== 'string' || !/^[a-z0-9_]{1,40}$/.test(v); }))) problems.push(`field "${f.key}": "types" is a list of the service's task types, like ["image_to_model"] or [["image_to_model", "Image to 3D"]]`);
      else if (f.multiple !== undefined && typeof f.multiple !== 'boolean') problems.push(`field "${f.key}": "multiple" is true or false`);
    }
  }
  const caps = m.capabilities || {};
  for (const k of Object.keys(caps)) if (!['network', 'ai', 'keys', 'files', 'state'].includes(k)) warnings.push(`this kit doesn't know the capability "${k}". If your GIRAFE added it, update the kit; GIRAFE itself decides when the node is sent.`);
  if (caps.network !== undefined && (!Array.isArray(caps.network) || caps.network.some((h) => !/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(h)))) problems.push('"network": a list of host names, like ["api.example.com"] (host API 2 also takes "*.example.com")');
  else if ((caps.network || []).some((h) => h.startsWith('*.')) && m.hostApi < 2) problems.push('"*.host" entries in "network" need "hostApi": 2');
  if (caps.state !== undefined && caps.state !== true) problems.push('"state": true or leave it out');
  if (caps.state && m.hostApi < 2) problems.push('"state" needs "hostApi": 2');
  if (m.limits !== undefined) {
    const sec = m.limits && m.limits.seconds;
    if (m.hostApi < 2) problems.push('"limits" needs "hostApi": 2');
    else if (!Number.isInteger(sec) || sec < 1 || sec > MAX_SECONDS) problems.push(`"limits": { "seconds": 1 to ${MAX_SECONDS} }`);
  }
  if (caps.keys !== undefined) {
    if (!Array.isArray(caps.keys)) problems.push('"keys": a list like [{ "slot": "gemini", "service": "gemini", "label": "Gemini API key" }]');
    else for (const k of caps.keys) {
      if (!k || !/^[a-z][a-z0-9_]{0,23}$/.test(k.slot || '')) problems.push(`key slot ${JSON.stringify(k && k.slot)}: a short lowercase name`);
      else if (!(m.hostApi >= 2 ? KEY_SERVICES : KEY_SERVICES_V1).includes(k.service)) {
        if (KEY_SERVICES.includes(k.service)) problems.push(`key slot "${k.slot}": the ${k.service} service needs "hostApi": 2`);
        else warnings.push(`key slot "${k.slot}": this kit doesn't know the service "${k.service}" (it knows ${KEY_SERVICES.join(', ')}). If your GIRAFE added it, update the kit.`);
      }
      else if (m.hostApi < 1) problems.push(`key slots need "hostApi": 1`);
      else if (!netguard.hostsFor(k.service).slice(0, 1).every((h) => (caps.network || []).includes(h))) problems.push(`key slot "${k.slot}": add "${netguard.hostsFor(k.service)[0]}" to "network"`);
    }
  }
  if (m.billing !== undefined && !(m.hostApi >= 2)) problems.push('"billing" needs "hostApi": 2');
  else problems.push(...require('./billing').checkBilling(m.billing, (Array.isArray(caps.keys) ? caps.keys : []).map((k) => k && k.service), ''));
  return { problems, warnings };
}

// When this node was last touched, so the page can offer "the one you were just working on"
// without the author having to remember its name. Its own files only, one level down.
function newestMtime(base) {
  let newest = 0;
  const walk = (dir, depth) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.') || it.name === 'node_modules') continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth > 0) walk(full, depth - 1); continue; }
      try { const t = fs.statSync(full).mtimeMs; if (t > newest) newest = t; } catch { /* vanished mid-read */ }
    }
  };
  walk(base, 2);
  return newest ? new Date(newest).toISOString() : null;
}

function listPlugins() {
  const out = [];
  const packs = require('./packs');
  const member = packs.membership();
  for (const dir of fs.readdirSync(store.NODES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    if (packs.isPackDir(dir.name)) continue; // a pack folder holds only pack.json
    const base = path.join(store.NODES, dir.name);
    let m = null, problems = [], warnings = [];
    try { m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')); }
    catch (e) { problems = ['manifest.json: ' + e.message]; }
    if (m) ({ problems, warnings } = checkManifestFull(m, dir.name));
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
      limits: (m && m.limits) || null,
      display: (m && m.display) || null,
      streams: !!(m && m.streams),
      hostApi: m && m.hostApi,
      girafe: m && m.girafe,
      category: (m && m.category) || null,
      billing: (m && Array.isArray(m.billing) && m.billing) || [],
      pack: member[dir.name] || null,
      changedAt: newestMtime(base),
      problems,
      warnings,
    });
  }
  return out;
}

// Same limits as GIRAFE (server/plugins/runtime.js).
const RSS_MAX_MB = Math.max(256, Number(process.env.PLUGIN_RSS_MB) || 768);
const PACKET_MAX_CHARS = 5 * 1024 * 1024;
const OUTPUT_MAX_CHARS = 40 * 1024 * 1024;
function rssMb(pid) {
  try { const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : 0; } catch { return 0; }
}

function getPlugin(id) {
  return listPlugins().find((p) => p.id === id) || null;
}

// Runs one firing. `inputs` = { A: value, B: value }, values as they travel between nodes.
// Resolves to { outputs: [{ port, value }], shown: [values], logs } or rejects with a clear Error.
// `shown`: what a node with no outputs returned (it goes nowhere; the host shows it).
function runPlugin(plugin, { inputs, settings, keySlots, title, signal, onProgress, nodeId }) {
  return new Promise((resolve, reject) => {
    if (plugin.problems.length) return reject(new Error(`${plugin.name} can't run: ${plugin.problems[0]}`));
    const dir = path.join(store.NODES, plugin.id);
    const child = fork(CHILD, [], {
      execArgv: [
        `--max-old-space-size=${MEMORY_MB}`,
        '--disallow-code-generation-from-strings', // no eval / new Function in a node
        '--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${CHILD}`,
      ],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {}, // a plugin sees no environment variables: no keys, no paths
    });
    const outputs = [];
    const shown = []; // a node with no outputs: what it returned, shown by the host (display "runs")
    const logs = [];
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      clearTimeout(timer); clearInterval(memWatch); signal && signal.removeEventListener('abort', onAbort);
      try { child.kill('SIGKILL'); } catch {}
      err ? reject(err) : resolve(val);
    };
    const limitMs = plugin.hostApi >= 2 && plugin.limits && plugin.limits.seconds ? plugin.limits.seconds * 1000 : TIMEOUT_MS;
    const timer = setTimeout(() => finish(new Error(`${plugin.name} took longer than ${limitMs / 1000} s and was stopped`)), limitMs);
    // --max-old-space-size does not count Buffers: on Linux the process's real memory is watched too.
    const memWatch = setInterval(() => {
      if (child.pid && rssMb(child.pid) > RSS_MAX_MB) finish(new Error(`${plugin.name} used more than ${RSS_MAX_MB} MB of memory and was stopped`));
    }, 500);
    const onAbort = () => finish(new Error('Stopped'));
    signal && signal.addEventListener('abort', onAbort);
    const keepLog = (s) => { if (logs.length < 200) logs.push(String(s).slice(0, 2000)); };
    child.stdout.on('data', (d) => keepLog(d.toString().trimEnd()));
    child.stderr.on('data', (d) => keepLog(d.toString().trimEnd()));

    // The host side of the host API. Every capability a plugin uses comes through here.
    let usageCount = 0;
    let sentChars = 0;
    const host = {
      emit({ port, value }) {
        if (!plugin.outputs.length) throw new Error('this node has no outputs ("outputs": []): return what it should show instead');
        if (!plugin.outputs.includes(port)) throw new Error(`no output called "${port}" (the manifest lists ${plugin.outputs.join(', ')})`);
        if (outputs.length >= 1000) throw new Error('more than 1000 packets from one firing');
        const wire = toWire(value);
        if (wire.length > PACKET_MAX_CHARS) throw new Error('one value over 5 MB: send big results as files (ctx.files.write)');
        if ((sentChars += wire.length) > OUTPUT_MAX_CHARS) throw new Error('more than 40 MB sent on from one firing');
        outputs.push({ port, value: wire });
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
      // ctx.state (host API 2): kept per canvas node, saved at once.
      stateGet() {
        if (!plugin.capabilities.state) throw new Error('ctx.state needs "capabilities": { "state": true }');
        return pluginState.get(plugin.id, nodeId || 'test');
      },
      stateSet({ value }) {
        if (!plugin.capabilities.state) throw new Error('ctx.state needs "capabilities": { "state": true }');
        return pluginState.set(plugin.id, nodeId || 'test', value);
      },
      // ctx.files.fromUrl (host API 2): the host downloads a file (a result too big to pass through
      // the plugin's memory) from a host in "network", through the guard, without any key.
      async fromUrl({ url, name, mime }) {
        if (plugin.hostApi < 2) throw new Error('ctx.files.fromUrl needs "hostApi": 2');
        if (plugin.capabilities.files !== 'readwrite') throw new Error('making files needs "capabilities": { "files": "readwrite" }');
        let u; try { u = new URL(String(url)); } catch { throw new Error('ctx.files.fromUrl: not a valid address'); }
        if (u.protocol !== 'https:') throw new Error('ctx.files.fromUrl: https addresses only');
        if (!hostAllowed(plugin.capabilities, u.hostname)) throw new Error(`ctx.files.fromUrl: ${u.hostname} is not in the manifest's "network" list`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
        const stop = () => ctrl.abort();
        signal && signal.addEventListener('abort', stop, { once: true });
        try {
          const res = await netguard.send(testRedirect(u.toString()), { method: 'GET', signal: ctrl.signal }, { purpose: `plugin ${plugin.id} · download` });
          if (!res.ok) throw new Error(`ctx.files.fromUrl: HTTP ${res.status} from ${u.hostname}`);
          const chunks = []; let size = 0;
          for await (const c of res.body) { size += c.length; if (size > DOWNLOAD_MAX_BYTES) throw new Error('ctx.files.fromUrl: file over 200 MB'); chunks.push(c); }
          const buf = Buffer.concat(chunks);
          const type = String(mime || res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const f = store.saveFile(buf, type);
          return { imageUrl: '/files/' + f.key, key: f.key, mime: f.mime, name: name ? String(name).slice(0, 120) : undefined, size: f.size };
        } catch (e) {
          if (e instanceof netguard.Blocked) throw e;
          if (ctrl.signal.aborted) throw new Error(signal && signal.aborted ? 'Stopped' : 'ctx.files.fromUrl: the download took too long');
          throw e.message.startsWith('ctx.') ? e : new Error(`ctx.files.fromUrl: ${e.message}`);
        } finally { clearTimeout(timer); signal && signal.removeEventListener('abort', stop); }
      },
      ai() { throw new Error('ctx.ai is not in the host API yet; call a service with ctx.http and a key slot.'); },
      // ctx.usage (billing): what this firing spent at a service the package's "billing" describes.
      // The kit checks it like GIRAFE and shows it in the node's log; GIRAFE files it in AI reports.
      usage({ service, units, taskId, type, label, model, failed }) {
        const packId = plugin.pack;
        const packBilling = packId ? (require('./packs').readPack(packId).billing || []) : [];
        const b = require('./billing').billingFor(plugin.billing, packBilling).find((x) => x && x.service === service);
        if (!b) throw new Error(`ctx.usage: "${service}" is not in the package's "billing"`);
        const n = Number(units);
        if (!Number.isFinite(n) || n < 0 || n >= 1e6) throw new Error('ctx.usage: "units" is a number from 0');
        if (++usageCount > 500) throw new Error('ctx.usage: more than 500 reports from one firing');
        const usd = Math.round(n * (Number(b.usdPerUnit) || 0) * 10000) / 10000;
        const word = n === 1 ? b.unit : (b.units || b.unit + 's');
        keepLog(`💲 ${service}: ${n} ${word} (≈ $${usd})${taskId ? ' · task ' + String(taskId).slice(0, 100) : ''}${type ? ' · ' + String(type).slice(0, 40) : ''}${label ? ' · ' + String(label).slice(0, 120) : ''}${model ? ' · ' + String(model).slice(0, 60) : ''}${failed === true ? ' · failed' : ''}`);
        return { recorded: true, usd };
      },
      // ctx.http: the plugin's only way to the internet. The host adds the key of a declared slot
      // (the plugin never sees it) and sends through the network guard.
      async http({ slot, method = 'GET', url, headers = {}, json, body, form }) {
        if (plugin.hostApi < 1) throw new Error('ctx.http needs "hostApi": 1 in the manifest');
        let u; try { u = new URL(String(url)); } catch { throw new Error('ctx.http: not a valid address'); }
        if (u.protocol !== 'https:') throw new Error('ctx.http: https addresses only');
        if (!hostAllowed(plugin.capabilities, u.hostname)) throw new Error(`ctx.http: ${u.hostname} is not in the manifest's "network" list`);
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
          if (!keyId) throw new Error(`Choose a key for "${decl.label || slot}" in the node's panel (for a node in a pack: the pack's key, one for all its nodes).`);
          const k = keys.use(keyId, decl.service);
          h[netguard.AUTH_HEADER[decl.service]] = BEARER.has(decl.service) ? `Bearer ${k.value}` : k.value;
          guard = { service: decl.service, key: k.value, keyLabel: k.label, purpose: `plugin ${plugin.id} · slot ${slot}` };
        }
        target = testRedirect(target);
        const init = { method: String(method).toUpperCase(), headers: h };
        if (json !== undefined) { init.body = JSON.stringify(json); h['content-type'] = h['content-type'] || 'application/json'; }
        else if (form !== undefined) {
          // host API 2: a multipart form; a field is text, or { file: ref, name? } for a file that
          // arrived on an input (read by the host, never through the plugin's memory).
          if (plugin.hostApi < 2) throw new Error('ctx.http forms need "hostApi": 2');
          if (!form || typeof form !== 'object') throw new Error('ctx.http: form must be an object');
          const fd = new FormData(); let total = 0;
          for (const [k, v] of Object.entries(form)) {
            if (v && typeof v === 'object' && v.file) {
              if (!(plugin.capabilities.files === 'read' || plugin.capabilities.files === 'readwrite')) throw new Error('sending a file needs "capabilities": { "files": "read" }');
              const p = store.filePath(v.file.key);
              if (!p || !fs.existsSync(p)) throw new Error('ctx.http form: no such file');
              const buf = fs.readFileSync(p); total += buf.length;
              fd.append(k, new Blob([buf], { type: store.mimeOf(v.file.key) }), String(v.name || v.file.name || v.file.key).slice(0, 120));
            } else fd.append(k, String(v ?? ''));
          }
          if (total > HTTP_MAX_BYTES) throw new Error('ctx.http: request over 40 MB');
          init.body = fd;
        }
        else if (body !== undefined) init.body = String(body);
        if (typeof init.body === 'string' && init.body.length > HTTP_MAX_BYTES) throw new Error('ctx.http: request over 40 MB');
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
          if (typeof msg.name !== 'string' || !Object.prototype.hasOwnProperty.call(host, msg.name)) throw new Error('unknown host call ' + msg.name);
          return host[msg.name](msg.args || {});
        }).then((value) => ({ t: 'reply', id: msg.id, ok: true, value }), (e) => ({ t: 'reply', id: msg.id, ok: false, error: e.message }))
          .then((reply) => { if (!done) child.send(reply); });
      } else if (msg.t === 'done') {
        if (msg.ok) {
          if (msg.returned !== undefined) {
            const r = msg.returned;
            if (!plugin.outputs.length) { for (const v of Array.isArray(r) ? r : [r]) if (v !== undefined && v !== null && shown.length < 200) shown.push(toWire(v)); }
            else if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).every((k) => plugin.outputs.includes(k))) {
              for (const [port, value] of Object.entries(r)) if (value !== undefined && value !== null) outputs.push({ port, value: toWire(value) });
            } else outputs.push({ port: plugin.outputs[0], value: toWire(r) });
          }
          finish(null, { outputs, shown, logs });
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

module.exports = { listPlugins, getPlugin, runPlugin, checkManifest, checkManifestFull, rules, girafeOk, cmpVersion, toWire, hostAllowed, MAX_SECONDS };
