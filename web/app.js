// GIRAFE node kit - the canvas, palette and panel. Plain JavaScript, no build step.
import { createGirafePanel } from './girafe-panel.js';
import { tasksField } from './tasks-field.js';
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.code === 'signin' && !S.signingIn) { S.signingIn = true; location.reload(); }
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { code: data.code || null, status: r.status });
  return data;
};
const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const letter = (i) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
const isRef = (v) => !!(v && typeof v === 'object' && v.key && v.mime);
// A 3D model reference (host API 2) is shown by its preview picture, when it has one.
const isModel = (r) => isRef(r) && /^model\//.test(r.mime);
const thumbOf = (r) => (isModel(r) ? (isRef(r.preview) ? r.preview.imageUrl : null) : r.imageUrl);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const GLYPH = { idle: '', running: '⏳', waiting: '✋', done: '✓', error: '⚠️', skipped: '–', stopped: '⏹' };

const S = {
  info: null, kinds: new Map(), coreList: [], pluginList: [],
  graphId: null, graph: { title: '', nodes: [], wires: [] },
  view: { x: 40, y: 40, k: 1 },
  sel: null, // { type: 'node'|'wire', id }
  run: null, runId: null, undo: [],
};

// ---------- kinds ----------
async function loadKinds() {
  const { core, plugins } = await api('/api/kinds');
  S.coreList = core; S.pluginList = plugins;
  S.kinds = new Map([...core, ...plugins].map((k) => [k.type, k]));
  try { S.packs = (await api('/api/packs')).packs; } catch { S.packs = []; }
  renderPalette();
}
const kindOf = (n) => S.kinds.get(n.type) || { name: n.type, color: '#666', icon: '?', outputs: ['out'], inputs: { min: 0, max: 8 }, fields: [], missing: true, description: 'This node type is not available (a plugin removed or renamed?).' };
const takesInput = (k) => (k.inputs?.max ?? 0) > 0;

function renderPalette() {
  const mk = (k) => el('button', { class: 'pm-palette-btn' + (k.problems?.length ? ' bad' : ''), style: { '--pm-kind-color': k.color }, title: k.problems?.length ? k.problems.join('\n') : k.description, onclick: () => addNodeAtCenter(k.type) },
    kindLabel(k), k.problems?.length ? el('span', { class: 'badge', text: '⚠' }) : null);
  $('#palCore').replaceChildren(...S.coreList.map(mk));
  const mkPlugin = (k) => {
    const b = mk(k);
    const g = ghNode(k.id);
    if (g) { b.classList.add('gh-' + g.state); b.append(el('span', { class: 'gh-mark', title: GH_STATE[g.state]?.tip || '', text: GH_STATE[g.state]?.mark || '' })); }
    b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); showMenu(ev.clientX, ev.clientY, ghMenuItems(k.id, k.name), k.name); });
    return b;
  };
  // A pack's nodes sit together under the pack's title (they go to GIRAFE as one).
  const loose = S.pluginList.filter((k) => !k.pack || !packOf(k.pack));
  const groups = (S.packs || []).map((pk) => el('div', { class: 'pal-pack' + (pk.problems.length ? ' bad' : ''), title: pk.problems.length ? pk.problems.join('\n') : pk.description },
    el('div', { class: 'pal-pack-hd', oncontextmenu: (ev) => { ev.preventDefault(); showMenu(ev.clientX, ev.clientY, ghMenuItems(pk.id, pk.name), pk.name); } },
      el('span', { text: '📦 ' + pk.name }), el('span', { class: 'muted', text: ' ' + (pk.version || '') }), pk.problems.length ? el('span', { class: 'badge', text: '⚠' }) : null,
      ghNode(pk.id) ? el('span', { class: 'gh-mark', title: GH_STATE[ghNode(pk.id).state]?.tip || '', text: GH_STATE[ghNode(pk.id).state]?.mark || '' }) : null),
    ...S.pluginList.filter((k) => k.pack === pk.id).map(mkPlugin)));
  $('#palPlugins').replaceChildren(...groups, ...(loose.length ? loose.map(mkPlugin) : groups.length ? [] : [el('div', { class: 'muted', text: 'None yet.' })]), ...ghRemoteOnly(), ...[ghInvite()].filter(Boolean));
}

// ---------- graphs ----------
async function loadGraphList(selectId) {
  const { graphs } = await api('/api/graphs');
  const sel = $('#graphSel');
  sel.replaceChildren(...graphs.map((g) => el('option', { value: g.id, text: g.title })));
  const id = selectId || localStorage.getItem('kit.graph') || graphs[0]?.id;
  if (id && graphs.some((g) => g.id === id)) { sel.value = id; await openGraph(id); }
  else if (graphs[0]) { sel.value = graphs[0].id; await openGraph(graphs[0].id); }
}
async function openGraph(id) {
  const { graph } = await api('/api/graphs/' + id);
  S.graphId = id; S.graph = graph; S.sel = null; S.run = null; S.undo = []; S.lastGraph = structuredClone(graph);
  localStorage.setItem('kit.graph', id);
  $('#graphTitle').value = graph.title || '';
  render(); fit();
}
let saveTimer = null;
function changed({ undoable = true, panel = true } = {}) {
  if (undoable) { S.undo.push(JSON.stringify(S.lastGraph || S.graph)); if (S.undo.length > 50) S.undo.shift(); }
  S.lastGraph = structuredClone(S.graph);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
  render({ panel });
}
async function save() {
  clearTimeout(saveTimer);
  if (!S.graphId) return;
  await api('/api/graphs/' + S.graphId, { method: 'POST', body: JSON.stringify(S.graph) });
  const opt = [...$('#graphSel').options].find((o) => o.value === S.graphId);
  if (opt) opt.textContent = S.graph.title || 'Untitled';
}
function undo() {
  const prev = S.undo.pop();
  if (!prev) return;
  S.graph = JSON.parse(prev); S.lastGraph = structuredClone(S.graph); S.sel = null;
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 300);
  render();
}

// ---------- nodes and wires ----------
function makeNode(type, x, y) {
  const k = kindOf({ type });
  const n = { id: uid('n'), type, x: Math.round(x), y: Math.round(y), title: k.name };
  if (type.startsWith('plugin:')) n.settings = Object.fromEntries((k.fields || []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
  return n;
}
function addNodeAtCenter(type) {
  const c = $('#canvas').getBoundingClientRect();
  const p = toWorld(c.left + c.width / 2, c.top + c.height / 2);
  const n = makeNode(type, p.x - 110 + (Math.random() * 40 - 20), p.y - 60 + (Math.random() * 40 - 20));
  S.graph.nodes.push(n); S.sel = { type: 'node', id: n.id }; changed();
}
const node = (id) => S.graph.nodes.find((n) => n.id === id);
const wiresInto = (id) => S.graph.wires.filter((w) => w.to === id);
function deleteSelected() {
  if (!S.sel) return;
  if (S.sel.type === 'node') { S.graph.nodes = S.graph.nodes.filter((n) => n.id !== S.sel.id); S.graph.wires = S.graph.wires.filter((w) => w.from !== S.sel.id && w.to !== S.sel.id); }
  else S.graph.wires = S.graph.wires.filter((w) => w.id !== S.sel.id);
  S.sel = null; changed();
}
let flashTimer;
function flash(msg) { $('#runStatus').textContent = msg; clearTimeout(flashTimer); flashTimer = setTimeout(() => updateRunStatus(), 2500); }

// ---------- view ----------
function applyView() { $('#world').style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.k})`; }
function toWorld(cx, cy) { const r = $('#canvas').getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.k, y: (cy - r.top - S.view.y) / S.view.k }; }
function fit() {
  const ns = S.graph.nodes;
  const r = $('#canvas').getBoundingClientRect();
  if (!ns.length) { S.view = { x: 40, y: 40, k: 1 }; applyView(); return; }
  const els = ns.map((n) => document.querySelector(`.pm-node[data-id="${n.id}"]`));
  const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
  const x1 = Math.max(...ns.map((n, i) => n.x + (els[i]?.offsetWidth || 220))), y1 = Math.max(...ns.map((n, i) => n.y + (els[i]?.offsetHeight || 120)));
  const k = Math.min(1, (r.width - 80) / (x1 - x0), (r.height - 80) / (y1 - y0));
  S.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
  applyView(); drawWires();
}

// ---------- render ----------
function render({ panel = true } = {}) {
  const world = $('#world');
  const svg = $('#wires');
  world.replaceChildren(svg, ...S.graph.nodes.map(renderNode));
  $('#canvasHint').hidden = S.graph.nodes.length > 0;
  applyView();
  drawWires();
  playVideos();
  if (panel && !(document.activeElement?.matches('input, textarea, select') && $('#panel').contains(document.activeElement))) renderPanel();
  renderAsks();
}
function nodeRun(id) { return S.run?.nodes?.[id] || null; }

// ---------- render: nodes look and behave like GIRAFE's Promptmixer nodes ----------
const NODE_W = 220;
const READY_AFTER_MS = 20_000; // like GIRAFE: 20 s after a run, every node's video goes back to "ready"
const truncate = (s, n = 80) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const dataWiresInto = (id) => S.graph.wires.filter((w) => w.to === id && !w.flow);
const flowWiresInto = (id) => S.graph.wires.filter((w) => w.to === id && w.flow);
const wiresOutOf = (id) => S.graph.wires.filter((w) => w.from === id);
const namedOuts = (k) => (k.outputs || ['out']).length > 1;
const kindLabel = (k) => (k.core ? k.name : `${k.icon || '🧩'} ${k.name}`);

// The state video: two looping 2x2 sheets, one quarter shown per state (same mapping as GIRAFE).
const videoCache = new Map(); // nodeId -> { box, video, sheet }
function videoFor(n, st) {
  const s = st?.status || 'idle';
  let sheet, q;
  if (n.disabled) [sheet, q] = [2, 'bl'];                       // bypassed
  else if (S.backToReady) [sheet, q] = [2, 'br'];                // ready
  else if (s === 'running') [sheet, q] = [1, 'tr'];              // working
  else if (s === 'error' || s === 'stopped') [sheet, q] = [1, 'bl'];
  else if (s === 'skipped') [sheet, q] = [1, 'br'];
  else if (s === 'done') [sheet, q] = [2, 'tr'];
  else if (S.run?.status === 'running') [sheet, q] = [2, 'tl'];  // waiting for its turn
  else [sheet, q] = [2, 'br'];                                   // ready
  let c = videoCache.get(n.id);
  if (!c) {
    const video = el('video', { class: 'pm-node-video', loop: true, muted: true, playsinline: true, autoplay: true });
    c = { box: el('div', { class: 'pm-node-video-bg', 'aria-hidden': 'true' }, video), video, sheet: 0 };
    videoCache.set(n.id, c);
  }
  if (c.sheet !== sheet) { c.sheet = sheet; c.video.src = sheet === 2 ? 'node-states-loop-2.mp4' : 'node-states-loop.mp4'; }
  c.video.className = `pm-node-video pm-node-video-${q}`;
  return c;
}
function playVideos() {
  for (const [id, c] of videoCache) {
    if (!c.box.isConnected) { if (!node(id)) videoCache.delete(id); continue; }
    c.video.muted = true;
    if (c.video.paused) { const p = c.video.play(); if (p && p.catch) p.catch(() => {}); }
  }
}

function renderNode(n) {
  const k = kindOf(n);
  const st = nodeRun(n.id);
  const status = st?.status || 'idle';
  const e = el('div', {
    class: `pm-node pm-status-${status}${S.sel?.type === 'node' && S.sel.id === n.id ? ' pm-selected' : ''}${n.disabled ? ' pm-node-disabled' : ''}`,
    'data-id': n.id, style: { left: n.x + 'px', top: n.y + 'px', width: NODE_W + 'px', minHeight: NODE_W + 'px', '--pm-kind-color': k.color },
  });
  const hd = el('div', { class: 'pm-node-hd', onpointerdown: (ev) => beginNodeDrag(ev, n) },
    el('button', { class: 'pm-node-toggle-btn', title: n.disabled ? 'Turned off: click to turn it back on' : 'Turn off: skipped on the next run, what comes after it is skipped too',
      onpointerdown: (ev) => ev.stopPropagation(), onclick: (ev) => { ev.stopPropagation(); n.disabled = !n.disabled; changed(); } }, n.disabled ? '⏻' : '⏽'),
    el('span', { class: 'pm-node-kind', text: kindLabel(k) }),
    el('span', { class: 'pm-node-title', text: n.title || k.name }),
    status !== 'idle' ? el('span', { class: `pm-node-status pm-node-status-${status}`, text: GLYPH[status] || '' }) : null);
  e.append(videoFor(n, st).box, hd, el('div', { class: 'pm-node-bd' }, ...nodeBody(n, k, st)), renderPorts(n, k));
  e.addEventListener('pointerdown', (ev) => { if (ev.button === 0 && !ev.target.closest('.pm-sock, button, label, input')) { S.sel = { type: 'node', id: n.id }; markSel(); renderPanel(); } });
  e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); S.sel = { type: 'node', id: n.id }; markSel(); renderPanel(); showMenu(ev.clientX, ev.clientY, [[ '🗑 Delete', deleteSelected ], [ n.disabled ? '⏻ Turn on' : '⏽ Turn off', () => { n.disabled = !n.disabled; changed(); } ], [ '⧉ Duplicate', () => duplicate(n) ], ...(k.id && String(n.type).startsWith('plugin:') ? [null, ...ghMenuItems(k.id, k.name)] : [])], k.name); });
  return e;
}
function outLabel(n, p) { if (n.type === 'ask') return p === 'yes' ? (n.yesLabel || 'Yes') : (n.noLabel || 'No'); return p; }
function duplicate(n) { const c = structuredClone(n); c.id = uid('n'); c.x += 30; c.y += 30; S.graph.nodes.push(c); S.sel = { type: 'node', id: c.id }; changed(); }

function summaryOf(n, k) {
  switch (n.type) {
    case 'input': return n.value ? truncate(n.value) : '(empty value)';
    case 'image': return isRef(n.image) ? '✓ image set' : '(upload a picture)';
    case 'forEach': return 'Streams its wired-in list one item at a time.';
    case 'collect': return 'Waits for its input to finish, then emits everything as one list.';
    case 'ask': return n.prompt ? `✋ ${truncate(n.prompt)}` : '(write the question to ask)';
    case 'prompt': return !n.keyId ? '(no API key selected)' : n.prompt ? truncate(n.prompt) : '(no prompt yet)';
    case 'img': return !n.keyId ? '(no Gemini key selected)' : n.prompt ? `🎨 ${truncate(n.prompt)}` : 'ready to generate (describe it, or wire in text / pictures)';
    default:
      if (k.missing) return '⚠️ unknown node type (plugin removed?)';
      if (k.problems?.length) return `⚠️ ${k.problems[0]}`;
      return k.description || '';
  }
}
function nodeBody(n, k, st) {
  const out = [el('div', { class: 'pm-node-summary', text: summaryOf(n, k) })];
  if (n.type === 'image') {
    if (isRef(n.image)) out.push(el('img', { class: 'pm-node-thumb', src: n.image.imageUrl, alt: '' }));
    const pick = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'hidden-file-input' });
    pick.addEventListener('change', () => { const f = pick.files[0]; pick.value = ''; if (f) uploadImage(n, f); });
    out.push(el('label', { class: 'pm-node-upload-btn', onpointerdown: (ev) => ev.stopPropagation() }, isRef(n.image) ? '📤 Replace image' : '📤 Upload image', pick));
  }
  const pics = st?.outputs ? picsOf(st.outputs) : [];
  if (n.type === 'collect' && pics.length) {
    out.push(el('div', { class: 'pm-node-gallery', onpointerdown: (ev) => { if (ev.offsetX >= ev.currentTarget.clientWidth) ev.stopPropagation(); } },
      ...pics.map((r) => (thumbOf(r) ? el('img', { class: 'pm-node-gallery-thumb', src: thumbOf(r), alt: '', title: r.name || '' }) : el('div', { class: 'pm-node-gallery-thumb pm-model-tile', title: r.name || '', text: '🧊' })))));
  }
  if (st?.note) out.push(el('div', { class: 'pm-node-note', text: st.note }));
  if (st?.outputs?.length && !(n.type === 'image' && isRef(n.image)) && !(n.type === 'collect' && pics.length)) {
    const models = pics.filter(isModel);
    if (models.length === 1 && thumbOf(models[0])) out.push(el('img', { class: 'pm-node-thumb', src: thumbOf(models[0]), alt: '' }));
    out.push(el('div', { class: 'pm-node-preview', text: models.length ? `🧊 ${models.length === 1 ? models[0].name || '3D model' : models.length + ' 3D models'}${models.length === 1 && models[0].size ? ' · ' + mb(models[0].size) : ''}` : pics.length ? `📷 ${pics.length} image${pics.length === 1 ? '' : 's'}` : truncate(shortText(st.outputs), 140) }));
  }
  return out;
}
async function uploadImage(n, file) {
  try {
    const r = await fetch('/api/files?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    n.image = d.ref; changed();
  } catch (e) { flash('Upload failed: ' + e.message); }
}

function renderPorts(n, k) {
  const ins = el('div', { class: 'pm-port-in' });
  // The square flow socket, on every node: wired, the node runs only if something reaches it.
  const flow = flowWiresInto(n.id);
  const lastFlow = flow[flow.length - 1];
  ins.append(el('div', { class: `pm-port-slot pm-port-slot-flow${flow.length ? '' : ' pm-port-slot-empty'}` },
    el('span', { class: `pm-sock pm-sock-flow${flow.length ? ' on' : ''}`, 'data-flow-in': n.id,
      title: flow.length ? `Flow: this node runs only when something arrives here (${flow.length} wire${flow.length === 1 ? '' : 's'}). Drag to move the last one.` : 'Flow: wire an output here (for example a Yes / No exit) to run this node only when it fires. Left empty, it is ignored.',
      onpointerdown: (ev) => beginWireDrag(ev, { side: 'in', nodeId: n.id, flow: true, movingId: lastFlow?.id }) }),
    el('span', { class: 'pm-port-label', text: flow.length ? 'run if' : '' })));
  if (takesInput(k)) {
    const incoming = dataWiresInto(n.id);
    incoming.forEach((w, i) => ins.append(el('div', { class: 'pm-port-slot' },
      el('span', { class: 'pm-sock pm-sock-in', 'data-in': n.id, 'data-idx': i, title: 'Drag to connect this input elsewhere',
        onpointerdown: (ev) => beginWireDrag(ev, { side: 'in', nodeId: n.id, movingId: w.id }) }),
      el('span', { class: 'pm-port-label', text: letter(i) }))));
    if (incoming.length < (k.inputs.max ?? 8)) ins.append(el('div', { class: 'pm-port-slot pm-port-slot-empty' },
      el('span', { class: 'pm-sock pm-sock-in pm-sock-empty', 'data-in': n.id, 'data-idx': incoming.length, title: 'Drag to an output to connect',
        onpointerdown: (ev) => beginWireDrag(ev, { side: 'in', nodeId: n.id }) }),
      el('span', { class: 'pm-port-label pm-port-label-empty', text: letter(incoming.length) })));
  }
  const outs = el('div', { class: 'pm-ports-out' });
  if (k.outputs && !k.outputs.length) {
    // "outputs": [] (host API 2): the node keeps or shows what reaches it, nothing goes on.
  } else if (namedOuts(k)) {
    for (const p of k.outputs) {
      const onExit = wiresOutOf(n.id).filter((w) => w.port === p);
      outs.append(el('div', { class: 'pm-port-out' }, el('span', { class: 'pm-port-label', text: outLabel(n, p) }),
        el('span', { class: 'pm-sock pm-sock-out', 'data-out': n.id, 'data-port': p,
          title: onExit.length ? 'Drag to move this exit\'s wire (Shift: add another)' : 'Drag to a node to connect',
          onpointerdown: (ev) => beginWireDrag(ev, { side: 'out', nodeId: n.id, port: p, movingId: !ev.shiftKey && onExit.length ? onExit[onExit.length - 1].id : null }) })));
    }
  } else {
    // One socket per wire, lettered, plus an empty one for the next: they all carry the same output.
    const outgoing = wiresOutOf(n.id);
    const port = (k.outputs || ['out'])[0];
    outgoing.forEach((w, i) => outs.append(el('div', { class: 'pm-port-out' }, el('span', { class: 'pm-port-label', text: letter(i) }),
      el('span', { class: 'pm-sock pm-sock-out', 'data-out': n.id, 'data-oidx': i, title: 'Drag to connect this output elsewhere (Shift: add another wire)',
        onpointerdown: (ev) => beginWireDrag(ev, { side: 'out', nodeId: n.id, port, movingId: ev.shiftKey ? null : w.id }) }))));
    outs.append(el('div', { class: 'pm-port-out pm-port-out-empty' }, el('span', { class: 'pm-port-label pm-port-label-empty', text: letter(outgoing.length) }),
      el('span', { class: 'pm-sock pm-sock-out pm-sock-empty', 'data-out': n.id, 'data-oidx': outgoing.length, title: 'Drag to a node to connect',
        onpointerdown: (ev) => beginWireDrag(ev, { side: 'out', nodeId: n.id, port }) })));
  }
  return el('div', { class: 'pm-node-ports' }, ins, outs);
}
function picsOf(outputs) {
  const pics = [];
  for (const v of outputs) {
    if (isRef(v)) pics.push(v);
    else if (typeof v === 'string' && v.trim().startsWith('[')) { try { const a = JSON.parse(v); if (Array.isArray(a)) pics.push(...a.filter(isRef)); } catch {} }
  }
  return pics;
}
const shortText = (outputs) => outputs.slice(0, 4).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n').slice(0, 200);
function markSel() {
  for (const e of document.querySelectorAll('.pm-node')) e.classList.toggle('pm-selected', S.sel?.type === 'node' && S.sel.id === e.dataset.id);
  drawWires();
}

// ---------- wires ----------
function sockCenter(sel) {
  const s = document.querySelector(sel);
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}
function outSockSel(w) {
  const src = node(w.from);
  if (src && namedOuts(kindOf(src))) return `[data-out="${w.from}"][data-port="${w.port}"]`;
  return `[data-out="${w.from}"][data-oidx="${wiresOutOf(w.from).indexOf(w)}"]`;
}
const inSockSel = (w) => (w.flow ? `[data-flow-in="${w.to}"]` : `[data-in="${w.to}"][data-idx="${dataWiresInto(w.to).indexOf(w)}"]`);
const curve = (a, b) => { const dx = Math.max(60, Math.abs(b.x - a.x) / 2); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; };
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, v); return e; };
let draft = null;
function drawWires() {
  const svg = $('#wires');
  svg.replaceChildren();
  for (const w of S.graph.wires) {
    if (draft?.movingId === w.id) continue;
    const a = sockCenter(outSockSel(w));
    const b = sockCenter(inSockSel(w));
    if (!a || !b) continue;
    const d = curve(a, b);
    const run = S.run?.wires?.[w.id];
    const color = run?.state === 'delivered' ? '#5fd97a' : run?.state === 'dead' ? '#5a6472' : (kindOf(node(w.from) || {}).color || '#888');
    const sel = S.sel?.type === 'wire' && S.sel.id === w.id;
    const hit = svgEl('path', { d, class: 'pm-wire-hit', stroke: 'transparent', 'stroke-width': 16, fill: 'none' });
    hit.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); S.sel = { type: 'wire', id: w.id }; markSel(); renderPanel(); });
    hit.addEventListener('contextmenu', (ev) => { ev.preventDefault(); S.sel = { type: 'wire', id: w.id }; markSel(); showMenu(ev.clientX, ev.clientY, [['🗑 Delete wire', deleteSelected]]); });
    svg.append(hit, svgEl('path', { d, stroke: color, 'stroke-width': sel ? 4 : w.flow ? 3 : 2, 'stroke-dasharray': run?.state === 'dead' ? '6 5' : w.flow ? '10 3 2 3' : undefined, fill: 'none', class: 'pm-wire-path' }));
  }
  if (draft) svg.append(svgEl('path', { d: draft.side === 'in' ? curve(draft.b, draft.a) : curve(draft.a, draft.b), stroke: '#e8e8e8', 'stroke-width': 2, 'stroke-dasharray': '4 4', fill: 'none' }));
}

// ---------- wiring rules (same as GIRAFE: no loops, no feeding itself, no duplicates) ----------
function makesLoop(from, to, ignoreId) {
  const seen = new Set(); const stack = [to];
  while (stack.length) { const c = stack.pop(); if (c === from) return true; if (seen.has(c)) continue; seen.add(c); for (const w of S.graph.wires) if (w.from === c && w.id !== ignoreId) stack.push(w.to); }
  return false;
}
// Adds a wire, or moves an existing one (replaceId) so it keeps its place and letter.
function tryWire({ from, port, to, flow = false, replaceId = null }) {
  const t = node(to), f = node(from);
  if (!t || !f) return false;
  if (from === to) return flash('A node can\'t feed itself.'), false;
  const k = kindOf(t);
  if (!flow && !takesInput(k)) return flash(`${k.name} takes no input; drop it on its square flow socket instead.`), false;
  if (!flow && dataWiresInto(to).filter((w) => w.id !== replaceId).length >= (k.inputs.max ?? 8)) return flash(`${k.name} takes at most ${k.inputs.max} input${k.inputs.max === 1 ? '' : 's'}.`), false;
  if (S.graph.wires.some((w) => w.id !== replaceId && w.from === from && w.to === to && !!w.flow === flow && (w.port || 'out') === (port || 'out'))) return flash('Already wired.'), false;
  if (makesLoop(from, to, replaceId)) return flash('That wire would make a loop.'), false;
  const old = replaceId && S.graph.wires.find((w) => w.id === replaceId);
  if (old) { Object.assign(old, { from, port, to }); if (flow) old.flow = true; else delete old.flow; S.sel = { type: 'wire', id: old.id }; }
  else { const w = { id: uid('w'), from, port, to, ...(flow ? { flow: true } : {}) }; S.graph.wires.push(w); S.sel = { type: 'wire', id: w.id }; }
  changed();
  return true;
}
const firstOut = (n) => (kindOf(n).outputs || ['out'])[0];

// ---------- pointer interactions ----------
function track(ev, onMove, onEnd) {
  const id = ev.pointerId;
  const mv = (e) => { if (e.pointerId === id) onMove(e); };
  const up = (e) => { if (e.pointerId !== id) return; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); onEnd(e); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}
function beginNodeDrag(ev, n) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  S.sel = { type: 'node', id: n.id }; markSel(); renderPanel();
  const start = { x: ev.clientX, y: ev.clientY, nx: n.x, ny: n.y };
  const e = document.querySelector(`.pm-node[data-id="${n.id}"]`);
  let moved = false;
  track(ev, (m) => {
    const dx = (m.clientX - start.x) / S.view.k, dy = (m.clientY - start.y) / S.view.k;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true; n.x = Math.round(start.nx + dx); n.y = Math.round(start.ny + dy);
    e.style.left = n.x + 'px'; e.style.top = n.y + 'px'; drawWires();
  }, () => { if (moved) changed(); });
}
// Drag from any socket. Grabbing a socket that already has a wire moves that wire's far end;
// dropping on empty canvas removes it (and from an output, offers a node to add there).
function beginWireDrag(ev, { side, nodeId, port, flow = false, movingId = null }) {
  if (ev.button !== 0) return;
  ev.stopPropagation(); ev.preventDefault();
  const moving = movingId && S.graph.wires.find((w) => w.id === movingId);
  // The grabbed socket is the fixed end; the far end follows the pointer.
  const r = ev.target.getBoundingClientRect();
  const a = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  draft = { side, a, b: a, movingId };
  drawWires();
  track(ev, (m) => { draft.b = toWorld(m.clientX, m.clientY); drawWires(); }, (u) => {
    draft = null;
    const hitEl = document.elementFromPoint(u.clientX, u.clientY);
    const inCanvas = hitEl?.closest('#canvas');
    const nodeEl = hitEl?.closest('.pm-node');
    if (side === 'out') {
      const from = moving ? moving.from : nodeId;
      const fport = moving ? moving.port : port;
      const flowEl = hitEl?.closest('[data-flow-in]');
      const target = flowEl?.dataset.flowIn || hitEl?.closest('[data-in]')?.dataset.in || nodeEl?.dataset.id;
      if (target) {
        const toFlow = !!flowEl || (!takesInput(kindOf(node(target))) && !hitEl?.closest('[data-in]'));
        if (moving && moving.to === target && !!moving.flow === toFlow) return drawWires();
        if (!tryWire({ from, port: fport, to: target, flow: toFlow, replaceId: moving?.id })) drawWires();
        return;
      }
      if (moving) { S.graph.wires = S.graph.wires.filter((w) => w.id !== moving.id); changed(); flash('Wire removed (Ctrl+Z to undo).'); }
      else drawWires();
      if (inCanvas) {
        const p = toWorld(u.clientX, u.clientY);
        const kinds = [...S.kinds.values()].filter((k) => takesInput(k) && !k.problems?.length);
        showMenu(u.clientX, u.clientY, kinds.map((k) => [kindLabel(k), () => { const n = makeNode(k.type, p.x, p.y - 30); S.graph.nodes.push(n); S.graph.wires.push({ id: uid('w'), from, port: fport, to: n.id }); S.sel = { type: 'node', id: n.id }; changed(); }]), 'Add a node fed by this');
      }
    } else {
      const to = moving ? moving.to : nodeId;
      const toFlow = moving ? !!moving.flow : flow;
      const outEl = hitEl?.closest('[data-out]');
      const srcId = outEl?.dataset.out || nodeEl?.dataset.id;
      if (srcId) {
        const src = node(srcId);
        const sport = outEl?.dataset.port || firstOut(src);
        if (moving && moving.from === srcId && moving.port === sport) return drawWires();
        if (!tryWire({ from: srcId, port: sport, to, flow: toFlow, replaceId: moving?.id })) drawWires();
        return;
      }
      if (moving) { S.graph.wires = S.graph.wires.filter((w) => w.id !== moving.id); changed(); flash('Wire removed (Ctrl+Z to undo).'); }
      else drawWires();
    }
  });
}
function initCanvas() {
  const c = $('#canvas');
  c.addEventListener('pointerdown', (ev) => {
    if (ev.target !== c && ev.target !== $('#world') && ev.target !== $('#wires')) return;
    hideMenu();
    if (S.sel) { S.sel = null; markSel(); renderPanel(); }
    const start = { x: ev.clientX, y: ev.clientY, vx: S.view.x, vy: S.view.y };
    c.classList.add('panning');
    track(ev, (m) => { S.view.x = start.vx + m.clientX - start.x; S.view.y = start.vy + m.clientY - start.y; applyView(); }, () => c.classList.remove('panning'));
  });
  c.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = c.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const k = Math.min(2.5, Math.max(0.2, S.view.k * Math.exp(-ev.deltaY * 0.0015)));
    S.view.x = px - ((px - S.view.x) * k) / S.view.k; S.view.y = py - ((py - S.view.y) * k) / S.view.k; S.view.k = k;
    applyView();
  }, { passive: false });
  c.addEventListener('contextmenu', (ev) => {
    if (ev.target.closest('.pm-node') || ev.target.closest('.pm-wire-hit')) return;
    ev.preventDefault();
    const p = toWorld(ev.clientX, ev.clientY);
    showMenu(ev.clientX, ev.clientY, [...S.kinds.values()].filter((k) => !k.problems?.length).map((k) => [kindLabel(k), () => { const n = makeNode(k.type, p.x, p.y); S.graph.nodes.push(n); S.sel = { type: 'node', id: n.id }; changed(); }]), 'Add a node');
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.target.closest('input, textarea, select')) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelected(); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); }
    else if (ev.key === 'Escape') { hideMenu(); S.sel = null; markSel(); renderPanel(); }
  });
  window.addEventListener('resize', drawWires);
}
function showMenu(x, y, items, title) {
  const m = $('#menu');
  m.replaceChildren(...(title ? [el('div', { class: 'mt', text: title })] : []), ...items.filter((x) => x !== false && x !== undefined).map((it) => it === null ? el('div', { class: 'msep' }) : el('button', { text: it[0], onclick: () => { hideMenu(); it[1](); } })));
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => window.addEventListener('pointerdown', outside), 0);
}
function outside(ev) { if (!ev.target.closest('#menu')) hideMenu(); }
function hideMenu() { $('#menu').hidden = true; window.removeEventListener('pointerdown', outside); }

// ---------- panel ----------
function renderPanel() {
  const p = $('#panel');
  if (S.sel?.type === 'wire') return p.replaceChildren(...wirePanel(S.graph.wires.find((w) => w.id === S.sel.id)));
  const n = S.sel?.type === 'node' && node(S.sel.id);
  if (!n) return p.replaceChildren(...graphPanel());
  const k = kindOf(n);
  const st = nodeRun(n.id);
  const kids = [
    el('h3', {}, el('span', { class: 'kind-dot', style: { background: k.color } }), kindLabel(k), k.core ? el('span', { class: 'badge', text: 'core' }) : el('span', { class: 'badge', text: 'plugin ' + (k.version || '') })),
    el('p', { class: 'desc', text: k.description || '' }),
    field({ key: 'title', type: 'text', label: 'Title' }, n.title, (v) => { n.title = v; changed({ undoable: false, panel: false }); }),
  ];
  if (k.problems?.length) kids.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Can\'t run' }), el('ul', { class: 'problems' }, ...k.problems.map((x) => el('li', { text: x })))));
  // A plugin's key slots: you pick which of your keys fills each one; the plugin never sees it.
  // A node in a pack uses the pack's keys: one key for the whole pack.
  const pk = !k.core && k.pack && packOf(k.pack);
  if (pk) {
    for (const slot of pk.keys) {
      kids.push(keyField({ label: `${slot.label || slot.slot} - for the whole pack "${pk.name}"`, services: [slot.service] }, pk.keySlots?.[slot.slot],
        async (v) => { try { pk.keySlots = (await api(`/api/packs/${pk.id}/keys`, { method: 'POST', body: JSON.stringify({ slot: slot.slot, keyId: v || null }) })).keySlots; } catch (e) { alert(e.message); } }));
    }
  }
  for (const slot of (!pk && !k.core && k.capabilities?.keys) || []) {
    kids.push(keyField({ label: `${slot.label || slot.slot} (key slot "${slot.slot}")`, services: [slot.service] }, n.keySlots?.[slot.slot],
      (v) => { n.keySlots = { ...(n.keySlots || {}), [slot.slot]: v }; changed({ undoable: false, panel: false }); }));
  }
  for (const f of k.fields || []) {
    const isPlugin = n.type.startsWith('plugin:');
    const get = () => (isPlugin ? n.settings?.[f.key] : n[f.key]);
    const set = (v) => { if (isPlugin) { n.settings = { ...(n.settings || {}), [f.key]: v }; } else n[f.key] = v; changed({ undoable: false, panel: false }); };
    if (f.type === 'tasks') {
      const slotOf = ((pk ? pk.keys : k.capabilities?.keys) || []).find((x) => x.slot === f.slot) || {};
      kids.push(el('div', { class: 'gf gf-inline' }, tasksField({ el, api, f, pluginId: k.id, service: slotOf.service || f.slot, keyId: pk ? pk.keySlots?.[f.slot] : n.keySlots?.[f.slot], value: get(), set, rerender: () => renderPanel() })));
      continue;
    }
    kids.push(f.type === 'image' ? imageField(n) : f.type === 'key' ? keyField(f, get(), set) : f.type === 'model' ? modelField(f, n, get(), set) : f.type === 'file' ? fileField(f, get(), set) : field(f, get() ?? (f.default ?? ''), set));
  }
  {
    const ins = dataWiresInto(n.id), flows = flowWiresInto(n.id);
    const src = (w) => `${node(w.from)?.title || '?'}${w.port && w.port !== 'out' ? ' (' + outLabel(node(w.from) || {}, w.port) + ')' : ''}`;
    const rows = [...flows.map((w) => `▣ run if ← ${src(w)}`), ...ins.map((w, i) => `${letter(i)} ← ${src(w)}`)];
    if (takesInput(k) || rows.length) kids.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Inputs' }),
      rows.length ? rows.map((t) => el('div', { class: 'muted', text: t })) : el('div', { class: 'muted', text: 'Nothing wired in yet.' })));
  }
  if (!k.core && !k.missing) kids.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Manifest' }),
    el('div', { class: 'caps', text: `host API ${k.hostApi} · needs GIRAFE ${k.girafe || 'any'} · outputs: ${(k.outputs || []).length ? k.outputs.join(', ') : 'none (it keeps what reaches it)'}${k.display === 'runs' ? ' · keeps its last runs' : ''}` }),
    el('div', { class: 'caps', text: 'It may: ' + capsText(k.capabilities) }),
    el('div', { class: 'caps', text: `folder: workspace/nodes/${k.id}/` })));
  if (!k.core && !k.missing) kids.push(packBox(k));
  if (st && !(k.display === 'runs')) kids.push(runBox(st));
  if (k.display === 'runs') kids.push(runsBox(n, st));
  kids.push(el('div', { class: 'row' }, el('button', { text: n.disabled ? '● Turn on' : '○ Turn off', onclick: () => { n.disabled = !n.disabled; changed(); } }), el('button', { class: 'danger', text: '🗑 Delete', onclick: deleteSelected })));
  // A plugin node has two panels: what GIRAFE will show for it (the one to test with), and the
  // kit's own tools (manifest, problems, packaging, sending). The choice is remembered.
  if (k.core) return p.replaceChildren(...kids);
  const tab = panelTab();
  const tabs = el('div', { class: 'panel-tabs' },
    el('button', { class: tab === 'girafe' ? 'on' : '', text: '🦒 As in GIRAFE', title: 'The panel this node will have in GIRAFE: same fields, same order, same result views', onclick: () => setPanelTab('girafe') }),
    el('button', { class: tab === 'kit' ? 'on' : '', text: `🛠 Kit tools${k.problems?.length ? ' ⚠️' : ''}`, title: 'Manifest, problems, packaging, sending to GIRAFE and the market', onclick: () => setPanelTab('kit') }));
  if (tab === 'kit') return p.replaceChildren(tabs, ...kids);
  const keepScroll = p.scrollTop;
  p.replaceChildren(...[tabs,
    k.problems?.length ? el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Can\'t run' }), el('ul', { class: 'problems' }, ...k.problems.map((x) => el('li', { text: x })))) : null,
    girafePanel(n)].filter(Boolean));
  p.scrollTop = keepScroll;
}
const panelTab = () => { try { return localStorage.getItem('kit.panelTab') === 'kit' ? 'kit' : 'girafe'; } catch { return 'girafe'; } };
function setPanelTab(v) { try { localStorage.setItem('kit.panelTab', v); } catch { /* not kept */ } renderPanel(); }
const girafePanel = createGirafePanel({ el, S, api, kindOf, nodeRun, packOf: (id) => packOf(id), changed: (o) => changed(o), rerender: () => renderPanel(), runGraph: () => runGraph(), deleteSelected: () => deleteSelected(), openKeys: () => openKeys(), flash: (m) => flash(m) });
// What a plugin is allowed to do, in plain words (what a user checks before installing it).
function capsText(c = {}) {
  const out = [];
  for (const k of c.keys || []) out.push(`use your ${S.services[k.service]?.label || k.service} key (slot "${k.slot}"; it never sees the key)`);
  if (c.network?.length) out.push(`connect to ${c.network.join(', ')}`);
  if (c.files === 'read') out.push('read the files it receives');
  if (c.files === 'readwrite') out.push('read the files it receives and make new ones');
  return out.length ? out.join(' · ') : 'nothing beyond computing (no keys, no internet, no files)';
}
function field(f, value, onInput) {
  let input;
  if (f.type === 'textarea') input = el('textarea', { placeholder: f.placeholder || '' });
  else if (f.type === 'select') input = el('select', {}, ...(f.options || []).map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return el('option', { value: v, text: l }); }));
  else if (f.type === 'checkbox') input = el('input', { type: 'checkbox' });
  else input = el('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || '' });
  if (f.type === 'checkbox') { input.checked = !!value; input.addEventListener('change', () => onInput(input.checked)); return el('div', { class: 'field check' }, el('label', {}, input, f.label || f.key)); }
  input.value = value ?? '';
  input.addEventListener('input', () => onInput(f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value));
  return el('div', { class: 'field' }, el('label', { text: f.label || f.key }), input);
}
// ---------- packages and the GIRAFE link ----------
S.link = null;
async function loadLink() {
  try { S.link = await api('/api/girafe'); } catch { S.link = null; }
  const btn = $('#linkBtn');
  if (btn) btn.textContent = S.link?.connected ? `☁️ ${S.link.account?.name || 'GIRAFE'}` : '☁️ Connect to GIRAFE';
  if (!(document.activeElement?.matches('input, textarea, select') && $('#panel').contains(document.activeElement))) renderPanel();
}
S.packMsg = {};
const packOf = (id) => (S.packs || []).find((p) => p.id === id) || null;
function packBox(k) {
  const pk = k.pack && packOf(k.pack);
  if (pk) return packSendBox(pk);
  const out = el('div', { class: 'muted', 'data-pack': k.id });
  // The panel may be redrawn while a send is under way: write into whichever copy is on screen.
  const paint = (node, m) => node.replaceChildren(m.t, ...(m.link ? [el('a', { href: m.link.url, download: m.link.name, text: 'download' })] : []));
  const say = (t, link) => { S.packMsg[k.id] = { t, link }; paint(out, S.packMsg[k.id]); for (const n of document.querySelectorAll(`[data-pack="${k.id}"]`)) paint(n, S.packMsg[k.id]); };
  if (S.packMsg[k.id]) say(S.packMsg[k.id].t, S.packMsg[k.id].link);
  const pack = async () => {
    say('Packing…');
    try { const r = await api('/api/pack', { method: 'POST', body: JSON.stringify({ id: k.id }) }); say(`✓ ${r.name} · ${(r.size / 1024).toFixed(1)} KB · signed · `, r); }
    catch (e) { say('⚠️ ' + e.message); }
  };
  const sendIt = async () => {
    if (!S.link?.connected) return openLink(() => sendIt());
    say(`Sending ${k.name} ${k.version} to your GIRAFE…`);
    try { const r = await api('/api/girafe/send', { method: 'POST', body: JSON.stringify({ id: k.id }) }); say(`✓ ${r.message || `${k.name} ${r.version} is in your GIRAFE account.`}`); }
    catch (e) {
      say('⚠️ ' + e.message); if (/Connect/.test(e.message)) loadLink();
      if (e.code) loadCompat(); // GIRAFE said something about versions: show it in the top bar too
      if (e.code === 'kit-outdated') for (const n of document.querySelectorAll(`[data-pack="${k.id}"]`)) n.append(' ', el('button', { class: 'primary', text: '⬆ Update the kit', onclick: () => openVersions() }));
    }
  };
  return el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Share this node' }),
    el('div', { class: 'row' }, el('button', { text: '📦 Pack', title: 'Make a signed .gnode file of this node', onclick: pack }),
      el('button', { class: 'primary', text: S.link?.connected ? '☁️ Send to my GIRAFE' : '☁️ Connect and send to my GIRAFE', onclick: sendIt })),
    el('div', { class: 'caps', text: `Version ${k.version}. GIRAFE accepts each version once: raise "version" in manifest.json before sending a change.` }),
    S.compat?.girafe?.hostApis && !S.compat.girafe.hostApis.includes(k.hostApi) ? el('div', { class: 'v-prob warn', text: `Written for host API ${k.hostApi}; GIRAFE ${S.compat.girafe.version} runs host API ${S.compat.girafe.hostApis.join(' and ')}. It can't be sent until they match.` }) : null, out,
    marketBox(k.id, 'node', k.name, k.version));
}
// A pack is packed and sent as one: its nodes arrive together in GIRAFE, under its title.
function packSendBox(pk) {
  const key = 'pack:' + pk.id;
  const out = el('div', { class: 'muted', 'data-pack': key });
  const paint = (node, m) => node.replaceChildren(m.t, ...(m.link ? [el('a', { href: m.link.url, download: m.link.name, text: 'download' })] : []));
  const say = (t, link) => { S.packMsg[key] = { t, link }; for (const n of document.querySelectorAll(`[data-pack="${key}"]`)) paint(n, S.packMsg[key]); paint(out, S.packMsg[key]); };
  if (S.packMsg[key]) paint(out, S.packMsg[key]);
  const pack = async () => {
    say('Packing…');
    try { const r = await api('/api/pack', { method: 'POST', body: JSON.stringify({ pack: pk.id }) }); say(`✓ ${r.name} · ${(r.size / 1024).toFixed(1)} KB · signed · `, r); }
    catch (e) { say('⚠️ ' + e.message); }
  };
  const sendIt = async () => {
    if (!S.link?.connected) return openLink(() => sendIt());
    say(`Sending the pack ${pk.name} ${pk.version} to your GIRAFE…`);
    try { const r = await api('/api/girafe/send-pack', { method: 'POST', body: JSON.stringify({ id: pk.id }) }); say(`✓ ${r.message || `${pk.name} ${r.version} is in your GIRAFE account.`}`); }
    catch (e) {
      say('⚠️ ' + e.message); if (/Connect/.test(e.message)) loadLink();
      if (e.code) loadCompat();
      if (e.code === 'kit-outdated') for (const n of document.querySelectorAll(`[data-pack="${key}"]`)) n.append(' ', el('button', { class: 'primary', text: '⬆ Update the kit', onclick: () => openVersions() }));
    }
  };
  return el('div', { class: 'box' }, el('div', { class: 'box-title', text: `Part of the pack "${pk.name}"` }),
    el('div', { class: 'caps', text: `${pk.nodes.length} nodes: ${pk.nodes.join(', ')}. They go to GIRAFE together, as one pack with one set of keys (workspace/nodes/${pk.id}/pack.json).` }),
    pk.problems.length ? el('ul', { class: 'problems' }, ...pk.problems.map((x) => el('li', { text: x }))) : null,
    el('div', { class: 'row' }, el('button', { text: '📦 Pack', title: 'Make a signed .gpack file of the whole pack', onclick: pack }),
      el('button', { class: 'primary', text: S.link?.connected ? '☁️ Send the pack to my GIRAFE' : '☁️ Connect and send the pack', onclick: sendIt })),
    el('div', { class: 'caps', text: `Pack version ${pk.version}. GIRAFE accepts each pack version once: raise "version" in pack.json (and in the manifests of the nodes you changed) before sending again.` }), out,
    marketBox(pk.id, 'pack', pk.name, pk.version));
}
function openLink(after) {
  const ov = $('#keysDialog');
  let poll = null;
  const close = () => { clearTimeout(poll); ov.hidden = true; };
  const draw = () => {
    const L = S.link || {};
    const body = [];
    if (L.connected) {
      body.push(el('div', { class: 'box ok-box' }, el('div', { class: 'box-title', text: '✓ Signed in' }),
        el('div', { class: 'caps', text: `${L.account?.name || ''}${L.account?.email ? ' · ' + L.account.email : ''} on ${L.base} since ${String(L.linkedAt || '').slice(0, 10)}` }),
        el('div', { class: 'caps', text: 'The kit can send and update your own nodes in that account, nothing else. The link is stored like your keys (encrypted, only ever sent to GIRAFE). You can also revoke it from GIRAFE: Settings › Connected kits.' })));
      body.push(el('div', { class: 'row' }, after ? el('button', { class: 'primary', text: 'Continue', onclick: () => { close(); after(); } }) : null,
        el('button', { text: '🚪 Leave this computer…', title: 'Keep the kit ready, or sign out and erase your work from this computer', onclick: () => { close(); openLeave(); } })));
    } else if (L.pending && L.pending.state === 'waiting') {
      body.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Approve on GIRAFE' }),
        el('div', { class: 'link-code', text: L.pending.userCode }),
        el('div', { class: 'caps', text: 'Click below: GIRAFE opens with this code. Log in (or create an account), check the code is the same, and click Allow. This window notices by itself.' }),
        el('div', { class: 'row', style: { marginTop: '8px' } }, el('button', { class: 'primary', text: `Open ${new URL(L.pending.verifyUrl).host}`, onclick: () => window.open(L.pending.verifyUrl, '_blank', 'noopener') })),
        L.pending.error ? el('div', { class: 'problems', text: L.pending.error }) : el('div', { class: 'muted', text: '⏳ waiting for your approval…' })));
      poll = setTimeout(async () => { await loadLink(); if (S.link?.connected) await loadKeys(); draw(); }, 2000);
    } else {
      if (L.pending && L.pending.state !== 'approved') body.push(el('div', { class: 'problems', text: L.pending.state === 'denied' ? 'You said no on GIRAFE. Nothing was linked.' : 'The code expired. Start again.' }));
      body.push(el('p', { class: 'desc', text: 'Optional. Connecting lets the kit send your nodes to your GIRAFE account, where they work on all your devices and only you see them. Your GIRAFE password is never typed in the kit: you log in on GIRAFE itself.' }));
      const err = el('div', { class: 'problems' });
      body.push(el('div', { class: 'row' }, el('button', { class: 'primary', text: 'Connect', onclick: async () => {
        try { S.link = await api('/api/girafe/connect', { method: 'POST' }); draw(); } catch (e) { err.textContent = e.message; }
      } })), err);
    }
    ov.replaceChildren(el('div', { class: 'dialog' },
      el('div', { class: 'dialog-hd' }, el('h3', { text: '☁️ GIRAFE account' }), el('button', { class: 'link', text: '✕', title: 'Close', onclick: close })),
      ...body));
    ov.hidden = false;
  };
  loadLink().then(draw);
}

// ---------- the GIRAFE Market (publishing) ----------
S.market = null; S.listings = {}; S.marketMsg = {};
async function loadMarket() {
  try { S.market = await api('/api/market'); } catch { S.market = null; }
  const btn = $('#marketBtn');
  if (btn) { btn.textContent = S.market?.connected ? '🛒 Market ✓' : '🛒 Market'; btn.title = S.market?.connected ? `Publishing as ${S.market.account?.name || ''} on ${S.market.base}` : 'Publish your nodes on the GIRAFE Market'; }
}
// Under "Share this node": submit it (or its pack) for review on the market, with its market/ folder.
function marketBox(id, kind, name, version) {
  const key = `${kind}:${id}`;
  const out = el('div', { class: 'muted', 'data-market': key });
  const say = (t) => { S.marketMsg[key] = t; for (const n of document.querySelectorAll(`[data-market="${key}"]`)) n.textContent = t; out.textContent = t; };
  if (S.marketMsg[key]) out.textContent = S.marketMsg[key];
  const info = el('div', { class: 'caps', text: 'After submitting, add its pictures, videos and texts on its market page (a new version starts with the page of the one before).' });
  const after = el('div', { class: 'row' });
  const notes = el('input', { type: 'text', placeholder: 'What changed in this version (optional)' });
  const submit = async () => {
    if (!S.market?.connected) return openMarket(() => submit());
    delete S.listings[key];
    say(`Submitting ${name} ${version} to the market…`);
    try {
      const r = await api('/api/market/submit', { method: 'POST', body: JSON.stringify({ id, kind, notes: notes.value }) });
      const extra = [r.sent.listing ? 'its text' : null, r.sent.cover ? 'its tile background' : null, r.sent.media ? `${r.sent.media} picture${r.sent.media === 1 ? '' : 's'}/video${r.sent.media === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
      say(`✓ ${name} ${r.version} is waiting for review${extra ? `, with ${extra}` : ''}.${r.sent.problems.length ? ' ⚠️ ' + r.sent.problems.join(' · ') : ''}`);
      notes.value = '';
      after.replaceChildren(marketPageBtn(r.submission.id, '✏️ Dress up its market page'));
    } catch (e) {
      say('⚠️ ' + e.message); if (e.needsLink || /Connect/.test(e.message)) loadMarket();
      if (e.code === 'pending') after.replaceChildren(marketPageBtn(null, '✏️ Open what is waiting on the market'));
    }
  };
  return el('div', { class: 'market-box' },
    el('div', { class: 'box-title', text: '🛒 GIRAFE Market' }),
    el('div', { class: 'caps', text: 'Offer it to everyone: an admin reviews each version before it shows up on the market.' }),
    info, el('div', { class: 'field' }, notes),
    el('div', { class: 'row' }, el('button', { class: 'market-btn', text: S.market?.connected ? (kind === 'pack' ? '🛒 Submit the pack to the market' : '🛒 Submit to the market') : '🛒 Connect and submit', onclick: submit })),
    out, after);
}
// Opens a submission's page editor on the market (or the submissions list).
function marketPageBtn(subId, text) {
  const url = `${S.market?.base || 'https://market.girafe.live'}/submissions${subId ? '/' + subId : ''}`;
  return el('button', { class: 'primary', text, onclick: () => window.open(url, '_blank', 'noopener') });
}
function openMarket(after) {
  const ov = $('#keysDialog');
  let poll = null;
  const close = () => { clearTimeout(poll); ov.hidden = true; };
  const list = el('div', { class: 'market-subs' }, el('div', { class: 'muted', text: 'Asking the market…' }));
  const msg = el('div', { class: 'muted' });
  // What you can publish (your packs, and your nodes outside a pack) with where each stands on the
  // market and the one thing to do next. Disconnecting is not the way to do anything here.
  const loadSubs = async () => {
    let d;
    try { d = await api('/api/market/submissions'); } catch (e) { return list.replaceChildren(el('div', { class: 'problems', text: e.message })); }
    const base = S.market.base;
    const inPack = new Set((S.packs || []).flatMap((pk) => pk.nodes));
    const shipped = new Set(S.info?.shipped || ['example-upper', 'gemini-image']);
    const mine = [
      ...(S.packs || []).map((pk) => ({ id: pk.id, kind: 'pack', name: pk.name, version: pk.version })),
      ...S.pluginList.filter((k) => !inPack.has(k.id) && !shipped.has(k.id)).map((k) => ({ id: k.id, kind: 'node', name: k.name, version: k.version })),
    ];
    const latestOf = (id) => d.submissions.find((s) => s.packageId === id && s.status !== 'superseded');
    const rows = mine.map((it) => {
      const s = latestOf(it.id);
      const same = s && s.version === it.version;
      const row = el('div', { class: 'market-sub' });
      const send = async (btn) => {
        btn.disabled = true; msg.textContent = `Submitting ${it.name} ${it.version}…`;
        try { const r = await api('/api/market/submit', { method: 'POST', body: JSON.stringify({ id: it.id, kind: it.kind, notes: '' }) }); msg.textContent = `✓ ${it.name} ${r.version} is waiting for review. Dress up its page now.`; await loadSubs(); }
        catch (e) { msg.textContent = '⚠️ ' + e.message; btn.disabled = false; }
      };
      let state; const acts = [];
      if (same && s.status === 'pending') { state = '⏳ waiting for review'; acts.push(marketPageBtn(s.id, '✏️ Edit its market page')); }
      else if (same && s.status === 'approved') { state = '✓ on the market'; if (s.itemId) acts.push(el('button', { text: 'See it', onclick: () => window.open(`${base}/item/${s.itemId}`, '_blank', 'noopener') })); acts.push(el('span', { class: 'caps', text: 'Raise its version to send changes.' })); }
      else {
        state = !s ? 'not on the market yet' : s.status === 'rejected' ? `✕ ${s.version} not accepted${s.reason ? `: ${s.reason}` : ''}` : s.status === 'withdrawn' ? `${s.version} withdrawn` : `${s.version} on the market, ${it.version} here`;
        const b = el('button', { class: 'primary', text: `🛒 Submit ${it.version}`, onclick: () => send(b) }); acts.push(b);
        if (s && same) acts.push(el('span', { class: 'caps', text: `${it.version} was already sent once: raise the version if the market refuses it.` }));
      }
      row.replaceChildren(el('div', {}, el('b', { text: `${it.kind === 'pack' ? '📦' : '🧩'} ${it.name} ${it.version}` }), ' ', el('span', { class: 'muted', text: state })), el('div', { class: 'row' }, ...acts));
      return row;
    });
    list.replaceChildren(el('div', { class: 'box-title', text: 'Your nodes and packs' }),
      ...(rows.length ? rows : [el('div', { class: 'muted', text: 'No node of yours yet. Make one, then come back here to publish it.' })]), msg,
      el('div', { class: 'row' }, el('button', { class: 'link', text: `All my submissions on ${new URL(base).host} ↗`, onclick: () => window.open(`${base}/submissions`, '_blank', 'noopener') })));
  };
  const draw = () => {
    const L = S.market || {};
    const body = [];
    if (L.connected) {
      body.push(el('div', { class: 'caps' }, `✓ Publishing as ${L.account?.name || ''}${L.account?.email ? ' · ' + L.account.email : ''} on ${new URL(L.base).host}`));
      if (after) body.push(el('div', { class: 'row' }, el('button', { class: 'primary', text: 'Continue', onclick: () => { close(); after(); } })));
      body.push(list); loadSubs();
      body.push(el('div', { class: 'row', style: { marginTop: '6px' } }, el('button', { class: 'link muted', text: 'Use another market account…', title: 'Disconnects this kit from the market; you connect again with the other account.', onclick: async () => {
        if (!confirm(`Disconnect this kit from ${L.account?.name || 'this account'} on the market? You will connect again with the other account. Nothing on the market is deleted.`)) return;
        await api('/api/market/disconnect', { method: 'POST' }); await loadMarket(); await loadKeys(); draw(); renderPanel();
      } })));
    } else if (L.pending && L.pending.state === 'waiting') {
      body.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Approve on the market' }),
        el('div', { class: 'link-code', text: L.pending.userCode }),
        el('div', { class: 'caps', text: 'Click below: the market opens with this code. Sign in there (or create an account), check the code is the same, and click Allow. This window notices by itself.' }),
        el('div', { class: 'row', style: { marginTop: '8px' } }, el('button', { class: 'primary', text: `Open ${new URL(L.pending.verifyUrl).host}`, onclick: () => window.open(L.pending.verifyUrl, '_blank', 'noopener') })),
        L.pending.error ? el('div', { class: 'problems', text: L.pending.error }) : el('div', { class: 'muted', text: '⏳ waiting for your approval…' })));
      poll = setTimeout(async () => { await loadMarket(); if (S.market?.connected) { await loadKeys(); renderPanel(); } draw(); }, 2000);
    } else {
      if (L.pending && L.pending.state !== 'approved') body.push(el('div', { class: 'problems', text: L.pending.state === 'denied' ? 'You said no on the market. Nothing was linked.' : 'The code expired. Start again.' }));
      body.push(el('p', { class: 'desc', text: 'Publish your nodes and packs on the GIRAFE Market, where other people can install them in one click. Connect once with your market account (you sign in on the market itself, never in the kit), then press "Submit to the market" on a node or a pack.' }));
      body.push(el('div', { class: 'caps', text: 'Pictures, videos and texts are added on the market itself, right after you submit: no folder to prepare.' }));
      const err = el('div', { class: 'problems' });
      body.push(el('div', { class: 'row' }, el('button', { class: 'primary', text: 'Connect', onclick: async () => {
        try { S.market = await api('/api/market/connect', { method: 'POST' }); draw(); } catch (e) { err.textContent = e.message; }
      } })), err);
    }
    ov.replaceChildren(el('div', { class: 'dialog' },
      el('div', { class: 'dialog-hd' }, el('h3', { text: '🛒 GIRAFE Market' }), el('button', { class: 'link', text: '✕', title: 'Close', onclick: close })),
      ...body));
    ov.hidden = false;
  };
  loadMarket().then(draw);
}

// ---------- key bank ----------
S.keys = []; S.services = {};
async function loadKeys() { const d = await api('/api/keys'); S.keys = d.keys; S.services = d.services; }
function keyField(f, value, onSet) {
  const usable = S.keys.filter((k) => !f.services || f.services.includes(k.service));
  const sel = el('select', {}, el('option', { value: '', text: usable.length ? '- choose a key -' : '- no key yet -' }),
    ...usable.map((k) => el('option', { value: k.id, text: `${k.label} · ${k.masked}` })));
  sel.value = value || '';
  sel.addEventListener('change', () => { onSet(sel.value); renderPanel(); render({ panel: false }); });
  const names = (f.services || []).map((s) => S.services[s]?.label || s).join(', ');
  return el('div', { class: 'field' }, el('label', { text: f.label }), sel,
    el('div', { class: 'muted', style: { marginTop: '4px' } }, usable.length ? '' : `Add a ${names} key first. `, el('button', { class: 'link', text: '🔑 Manage keys…', onclick: () => openKeys() })));
}
function modelField(f, n, value, onSet) {
  const listId = 'models-' + n.id;
  const input = el('input', { type: 'text', placeholder: f.placeholder || '', list: listId });
  input.value = value || '';
  input.addEventListener('input', () => onSet(input.value.trim()));
  const dl = el('datalist', { id: listId });
  const note = el('div', { class: 'muted' });
  const btn = el('button', { class: 'link', text: 'List the models this key can use', onclick: async () => {
    if (!n.keyId) return (note.textContent = 'Choose a key first.');
    note.textContent = 'Asking…';
    try {
      const { models } = await api('/api/models', { method: 'POST', body: JSON.stringify({ keyId: n.keyId, kind: f.kind || 'text' }) });
      dl.replaceChildren(...models.map((m) => el('option', { value: m.id, text: m.label })));
      note.textContent = `${models.length} models: click the field to pick one.`;
      input.focus();
    } catch (e) { note.textContent = e.message; }
  } });
  return el('div', { class: 'field' }, el('label', { text: f.label }), input, dl, el('div', { class: 'row', style: { marginTop: '4px', alignItems: 'center' } }, btn), note);
}
function openKeys() {
  const ov = $('#keysDialog');
  const draw = () => {
    const label = el('input', { placeholder: 'Name, e.g. "My Gemini key"' });
    const service = el('select', {}, ...Object.entries(S.services).filter(([, x]) => !x.internal).map(([id, s]) => el('option', { value: id, text: s.label })));
    const value = el('input', { type: 'password', placeholder: 'Paste the key', autocomplete: 'off' });
    value.addEventListener('input', () => { const v = value.value.trim(); service.value = /^sk-ant-/.test(v) ? 'anthropic' : /^AIza/.test(v) ? 'gemini' : /^sk-/.test(v) ? 'openai' : /^(github_pat_|gh[pousr]_)/.test(v) ? 'github' : /^tsk_/.test(v) ? 'tripo' : service.value; });
    const err = el('div', { class: 'problems' });
    const add = async () => {
      const v = value.value;
      value.value = ''; // the page doesn't keep the key: it goes once to the kit, on this computer
      try {
        const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ label: label.value, service: service.value, value: v }) });
        await loadKeys();
        S.lastPaste = { label: r.key.label, during: r.during, fingerprint: r.key.fingerprint };
        draw(); renderPanel(); if (r.key.service === 'github') { loadGitHub(); if (S.ghReturn) { S.ghReturn = false; S.lastPaste = null; return openGitHub(); } }
      } catch (e) { err.textContent = e.message; value.value = v; }
    };
    ov.replaceChildren(el('div', { class: 'dialog dialog-wide' },
      el('div', { class: 'dialog-hd' }, el('h3', { text: '🔑 Key bank' }), el('button', { class: 'link', text: '✕', title: 'Close', onclick: () => { ov.hidden = true; S.lastPaste = null; } })),
      el('p', { class: 'desc', text: 'Keys for the nodes that call an outside service (Prompt, Generate image). They stay on this computer, encrypted, in workspace/.kit/. Nodes you build as plugins never see them.' }),
      S.keys.length ? el('div', { class: 'box' }, ...S.keys.map((k) => el('div', { class: 'key-row' },
        el('div', {}, el('b', { text: k.label }), el('div', { class: 'muted', text: `${S.services[k.service]?.label || k.service} · ${k.masked}` })),
        el('button', { class: 'danger', text: k.service === 'girafe' || k.service === 'market' ? 'Disconnect' : 'Delete', onclick: async () => { if (!confirm(k.service === 'girafe' ? 'Disconnect the kit from your GIRAFE account?' : k.service === 'market' ? 'Disconnect the kit from the market?' : `Delete the key "${k.label}"?`)) return; if (k.service === 'girafe') await api('/api/girafe/disconnect', { method: 'POST' }); else if (k.service === 'market') await api('/api/market/disconnect', { method: 'POST' }); else await api('/api/keys/' + k.id, { method: 'DELETE' }); await loadKeys(); await loadLink(); await loadMarket(); draw(); renderPanel(); } })))) : el('div', { class: 'muted', text: 'No keys yet.' }),
      el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Add a key' }),
        el('div', { class: 'field' }, el('label', { text: 'Key' }), value),
        el('div', { class: 'field' }, el('label', { text: 'Service' }), service),
        el('div', { class: 'field' }, el('label', { text: 'Name' }), label),
        err, el('button', { class: 'primary', text: 'Save the key', onclick: add })),
      S.lastPaste ? pasteReport(S.lastPaste) : null,
      networkBox(),
      el('div', { class: 'muted' }, 'Where to get one: ', ...Object.values(S.services).filter((x) => x.get && !x.internal).flatMap((x, i) => [i ? ' · ' : '', el('a', { href: x.get, target: '_blank', rel: 'noopener', text: x.label })]))));
    ov.hidden = false;
    value.focus();
  };
  draw();
}
function pasteReport(p) {
  const clean = p.during.internet === 0 && p.during.unexpected === 0;
  return el('div', { class: 'box ' + (clean ? 'ok-box' : 'warn-box') },
    el('div', { class: 'box-title', text: clean ? '🛡 Key saved, nothing left this computer' : '⚠️ Check the network log' }),
    el('div', { class: 'caps', text: clean
      ? `"${p.label}" went from this page to the kit on your computer, and was saved encrypted. While saving it, the kit made no internet request. The page can't contact anything else: it is locked to the kit. Fingerprint ${p.fingerprint} (not the key).`
      : `While saving "${p.label}", the kit's process made ${p.during.internet} internet request(s), ${p.during.unexpected} of them not through its guard. See the log below.` }));
}
function networkBox() {
  const box = el('div', { class: 'box' }, el('div', { class: 'box-title', text: '🛡 Network: where your keys go' }), el('div', { class: 'muted', text: 'Loading…' }));
  api('/api/network').then((r) => {
    const s = r.stats;
    const ok = s.blocked === 0 && s.unexpected === 0;
    const rows = r.log.slice(0, 25).map((e) => el('div', { class: 'net-row ' + (e.result === 'blocked' || e.result === 'unexpected' ? 'bad' : '') },
      el('span', { class: 'net-time', text: e.at.slice(11, 19) }),
      el('span', { class: 'net-what', text: `${e.purpose || '?'}${e.key ? ' · key "' + e.key + '"' : ''}` }),
      el('span', { class: 'net-host', text: e.host }),
      el('span', { class: 'net-res', text: e.result + (e.status ? ` · ${e.status}` : '') + (e.detail ? ': ' + e.detail : '') })));
    box.replaceChildren(el('div', { class: 'box-title', text: '🛡 Network: where your keys go' }),
      el('div', { class: 'caps', text: `${ok ? '✓' : '⚠️'} Since the kit started: ${s.requests} request(s) to the internet, ${s.withKey} with a key, each to its own service only. Blocked: ${s.blocked}. Not through the guard: ${s.unexpected}.` }),
      el('div', { class: 'caps', text: 'Allowed addresses: ' + Object.entries(r.hosts).map(([k, h]) => `${S.services[k]?.label || k} → ${h.join(', ')}`).join(' · ') }),
      rows.length ? el('div', { class: 'net-log' }, ...rows) : el('div', { class: 'muted', text: 'No internet request yet.' }));
  }).catch((e) => box.append(el('div', { class: 'problems', text: e.message })));
  return box;
}
function imageField(n) {
  const pick = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  const zone = el('div', { class: 'img-drop', onclick: () => pick.click() },
    isRef(n.image) ? el('img', { src: n.image.imageUrl, alt: '' }) : null,
    isRef(n.image) ? `${n.image.name || 'picture'} · click or drop to replace` : 'Drop a picture here, or click to choose one');
  const upload = async (file) => {
    if (!file) return;
    try {
      const r = await fetch('/api/files?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const d = await r.json(); if (!r.ok) throw new Error(d.error);
      n.image = d.ref; changed();
    } catch (e) { flash('Upload failed: ' + e.message); }
  };
  pick.addEventListener('change', () => upload(pick.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); upload(e.dataTransfer.files[0]); });
  return el('div', { class: 'field' }, el('label', { text: 'Picture' }), zone, pick);
}
// A file field (host API 2): files chosen in the panel, kept as references in the node's settings.
function fileField(f, value, set) {
  const list = (Array.isArray(value) ? value : value ? [value] : []).filter(isRef);
  const pick = el('input', { type: 'file', accept: f.accept || '', multiple: !!f.multiple, hidden: true });
  const upload = async (files) => {
    const got = [];
    for (const file of [...files].slice(0, f.multiple ? 20 : 1)) {
      try {
        const r = await fetch('/api/files?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        const d = await r.json(); if (!r.ok) throw new Error(d.error);
        got.push({ ...d.ref, name: file.name });
      } catch (e) { flash(`${file.name}: ${e.message}`); }
    }
    if (!got.length) return;
    set(f.multiple ? [...list, ...got.filter((g) => !list.some((r) => r.key === g.key))] : got[0]); renderPanel();
  };
  pick.addEventListener('change', () => upload(pick.files));
  const zone = el('div', { class: 'img-drop', onclick: () => pick.click() }, f.multiple ? 'Drop files here, or click to add some' : (list.length ? 'Click or drop to replace' : 'Drop a file here, or click to choose one'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); upload(e.dataTransfer.files); });
  const rows = list.map((r, i) => el('div', { class: 'file-row' },
    el('span', { text: `${f.multiple ? (i + 1) + '. ' : ''}${isModel(r) ? '🧊' : '📄'} ${r.name || r.key}${r.size ? ' · ' + mb(r.size) : ''}` }),
    el('button', { class: 'link', text: '✕', title: 'Remove', onclick: () => { const next = list.filter((_, j) => j !== i); set(f.multiple ? next : null); renderPanel(); } })));
  return el('div', { class: 'field' }, el('label', { text: f.label || f.key }), ...rows, zone, pick);
}
// display "runs" (host API 2): the latest run and the earlier ones the host kept for this node.
function valuesView(values) {
  const pics = picsOf(values);
  if (!pics.length) return values.slice(0, 50).map((v) => el('div', { class: 'out-item', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }));
  return [el('div', { class: 'thumbs' }, ...pics.map((r) => (isModel(r)
    ? el('div', { class: 'model-card' }, thumbOf(r) ? el('img', { src: thumbOf(r), alt: '' }) : el('div', { class: 'pm-model-tile', text: '🧊' }),
      el('div', {}, el('b', { text: r.name || '3D model' }), el('div', { class: 'muted', text: [r.size ? mb(r.size) : '', r.rig ? '🦴 ' + (r.rig.type || 'rigged') : '', r.animation ? '🏃 ' + (r.animation.name || '') : ''].filter(Boolean).join(' · ') }),
        el('a', { href: r.imageUrl, download: r.name || 'model.glb', text: '⬇ Download' })))
    : el('a', { href: r.imageUrl, target: '_blank' }, el('img', { src: r.imageUrl, alt: '' })))))];
}
function runsBox(n, st) {
  const box = el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Runs kept here' }), el('div', { class: 'muted', text: 'Loading…' }));
  api('/api/node-runs/' + encodeURIComponent(n.id)).then(({ runs }) => {
    const parts = [el('div', { class: 'box-title', text: `Runs kept here (${runs.length})` })];
    if (st && st.note && st.status === 'error') parts.push(el('div', { class: 'problems', text: st.note }));
    if (!runs.length) parts.push(el('div', { class: 'muted', text: 'Nothing yet: run the graph, and what reaches this node is kept here, run after run.' }));
    runs.forEach((r, i) => parts.push(el('div', { class: i ? 'run-earlier' : 'run-latest' },
      el('div', { class: 'muted', text: `${i ? 'Earlier run' : 'Latest'} · ${new Date(r.at).toLocaleString()}` }), ...valuesView(r.values))));
    if (runs.length) parts.push(el('div', { class: 'row' }, el('button', { class: 'danger', text: 'Forget these runs', onclick: async () => { await api('/api/node-runs/' + encodeURIComponent(n.id), { method: 'DELETE' }); renderPanel(); } })));
    box.replaceChildren(...parts);
  }).catch((e) => box.replaceChildren(el('div', { class: 'problems', text: e.message })));
  return box;
}
function runBox(st) {
  const pics = picsOf(st.outputs || []);
  return el('div', { class: 'box' }, el('div', { class: 'box-title', text: `Last run · ${st.status}${st.firings ? ' · fired ' + st.firings + '×' : ''}` }),
    st.note ? el('div', { class: st.status === 'error' ? 'problems' : 'muted', text: st.note }) : null,
    pics.length ? el('div', { class: 'thumbs' }, ...pics.map((r) => (isModel(r)
      ? el('div', { class: 'model-card' }, thumbOf(r) ? el('img', { src: thumbOf(r), alt: '' }) : el('div', { class: 'pm-model-tile', text: '🧊' }),
        el('div', {}, el('b', { text: r.name || '3D model' }), el('div', { class: 'muted', text: [r.size ? mb(r.size) : '', r.credits != null ? r.credits + ' credits' : '', r.taskId ? 'task ' + r.taskId : ''].filter(Boolean).join(' · ') }),
          el('a', { href: r.imageUrl, download: r.name || 'model.glb', text: '⬇ Download' })))
      : el('a', { href: r.imageUrl, target: '_blank' }, el('img', { src: r.imageUrl, alt: '' }))))) : null,
    ...(!pics.length ? (st.outputs || []).slice(0, 50).map((v) => el('div', { class: 'out-item', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) })) : []),
    st.logs?.length ? el('details', {}, el('summary', { text: `Log (${st.logs.length})` }), ...st.logs.map((l) => el('div', { class: 'out-item', text: l }))) : null);
}
function wirePanel(w) {
  if (!w) return [];
  const idx = dataWiresInto(w.to).indexOf(w);
  const count = S.run?.wires?.[w.id]?.count;
  return [el('h3', { text: 'Wire' }), el('p', { class: 'desc', text: `${node(w.from)?.title} (${w.port || 'out'}) → ${node(w.to)?.title}, ${w.flow ? 'flow socket (runs it only when something arrives)' : 'socket ' + letter(idx)}` }),
    count !== undefined ? el('div', { class: 'muted', text: `Last run: ${count} item${count === 1 ? '' : 's'} went through.` }) : null,
    el('div', { class: 'row', style: { marginTop: '12px' } }, el('button', { class: 'danger', text: '🗑 Delete wire', onclick: deleteSelected }))].filter(Boolean);
}
function graphPanel() {
  const i = S.info || {};
  return [el('h3', { text: 'GIRAFE node kit' }),
    el('p', { class: 'desc', text: 'Build a node, wire it between core nodes, run the graph. Everything runs on this machine; nothing goes to GIRAFE.' }),
    el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Versions' }),
      el('div', { class: 'caps', text: `Simulated GIRAFE ${i.girafe} · host API ${i.hostApi} · kit ${i.kit}` }),
      el('div', { class: 'caps', text: S.compat?.girafe?.version ? `GIRAFE (${new URL(S.compat.girafe.base).host}) is ${S.compat.girafe.version} · runs host API ${S.compat.girafe.hostApis.join(', ')} · needs kit ${S.compat.girafe.minKit}+` : 'GIRAFE\'s own version: not known yet.' }),
      ...(S.compat?.problems || []).filter((x) => x.level !== 'info' || x.code === 'update-available').map((x) => el('div', { class: 'v-prob ' + x.level, text: x.text })),
      el('div', { class: 'row' }, el('button', { text: '🔄 Versions and updates', onclick: () => openVersions() }))),
    el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Start a node' }),
      el('div', { class: 'caps' }, 'Copy ', el('code', { text: 'workspace/nodes/example-upper' }), ' to a new folder, change its id in manifest.json, edit node.js. Read ', el('code', { text: 'HOST_API.md' }), '.')),
    el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Keys' }),
      el('div', { class: 'caps', text: 'Delete: remove the selected node or wire · Ctrl+Z: undo · right-click: add a node · Escape: clear the selection' })),
    el('div', { class: 'row' }, el('button', { class: 'danger', text: '🗑 Delete this graph', onclick: deleteGraph }))];
}

// ---------- run ----------
let pollTimer = null;
let readyTimer = null;
async function runGraph() {
  await save();
  for (const n of S.graph.nodes) if (nodeRun(n.id)) S.run.nodes[n.id] = { status: 'idle' };
  try {
    const { runId } = await api('/api/run', { method: 'POST', body: JSON.stringify({ graph: S.graph }) });
    S.runId = runId; S.run = { status: 'running', nodes: {}, wires: {}, asks: [] };
    clearTimeout(readyTimer); S.backToReady = false;
    $('#runBtn').hidden = true; $('#stopBtn').hidden = false;
    poll();
  } catch (e) { flash('Run failed: ' + e.message); }
}
async function poll() {
  clearTimeout(pollTimer);
  try {
    const { run } = await api('/api/runs/' + S.runId);
    const before = JSON.stringify(S.run);
    S.run = run;
    if (JSON.stringify(run) !== before) { render(); }
    updateRunStatus();
    if (run.status === 'running') pollTimer = setTimeout(poll, 350);
    else {
      $('#runBtn').hidden = false; $('#stopBtn').hidden = true;
      clearTimeout(readyTimer); readyTimer = setTimeout(() => { S.backToReady = true; render({ panel: false }); }, READY_AFTER_MS);
    }
  } catch (e) { flash(e.message); $('#runBtn').hidden = false; $('#stopBtn').hidden = true; }
}
function updateRunStatus() {
  const r = S.run;
  if (!r) return ($('#runStatus').textContent = '');
  const all = Object.values(r.nodes || {});
  const done = all.filter((s) => ['done', 'skipped', 'error', 'stopped'].includes(s.status)).length;
  $('#runStatus').textContent = r.status === 'running' ? (r.asks?.length ? '✋ waiting for you' : `running ${done}/${all.length}`) : r.status === 'done' ? '✓ done' : r.status === 'stopped' ? '⏹ stopped' : '⚠️ ' + (r.error || 'a node failed');
}
function renderAsks() {
  const dock = $('#askDock');
  const a = S.run?.status === 'running' && S.run.asks?.[0];
  if (!a) { dock.hidden = true; return; }
  dock.hidden = false;
  const answer = async (v) => { try { await api(`/api/runs/${S.runId}/answer`, { method: 'POST', body: JSON.stringify({ askId: a.id, answer: v }) }); poll(); } catch (e) { flash(e.message); } };
  const prev = a.preview;
  dock.replaceChildren(el('div', { class: 'who', text: `✋ ${a.title} is waiting${S.run.asks.length > 1 ? ` · ${S.run.asks.length} questions` : ''}` }),
    el('div', { class: 'q', text: a.text }),
    prev !== null && prev !== undefined ? el('details', {}, el('summary', { text: 'What it passes on if you answer' }), isRef(prev) ? el('img', { src: prev.imageUrl, style: { maxWidth: '100%', maxHeight: '160px' } }) : el('div', { class: 'out-item', text: typeof prev === 'string' ? prev : JSON.stringify(prev, null, 2) })) : null,
    el('div', { class: 'row' }, el('button', { text: a.noLabel || 'No', onclick: () => answer('no') }), el('button', { class: 'primary', text: a.yesLabel || 'Yes', onclick: () => answer('yes') })));
}

// ---------- graph buttons ----------
async function newGraph() {
  const { id } = await api('/api/graphs', { method: 'POST', body: JSON.stringify({ title: 'New graph' }) });
  await loadGraphList(id);
}
async function deleteGraph() {
  if (!S.graphId || !confirm(`Delete "${S.graph.title}"?`)) return;
  await api('/api/graphs/' + S.graphId, { method: 'DELETE' });
  localStorage.removeItem('kit.graph');
  const { graphs } = await api('/api/graphs');
  if (!graphs.length) await newGraph(); else await loadGraphList(graphs[0].id);
}

// ---------- versions: kit <-> GIRAFE, and "Update the kit" (kit/compat.js, kit/updater.js) ----------
S.compat = null;
async function loadCompat(force) {
  try { S.compat = await api('/api/compat' + (force ? '?force=1' : '')); } catch { return; }
  const c = S.compat;
  const worst = c.problems.find((x) => x.level === 'block') ? 'block' : c.problems.find((x) => x.level === 'warn') ? 'warn' : c.updateAvailable ? 'update' : null;
  const b = $('#versionAlert');
  b.hidden = !worst;
  b.className = 'version-alert' + (worst ? ' v-' + worst : '');
  b.textContent = worst === 'block' ? '⛔ Update the kit' : worst === 'warn' ? '⚠️ Versions' : worst === 'update' ? `⬆ Kit ${c.latest.version}` : '';
  b.title = c.problems.filter((x) => x.level !== 'info' || x.code === 'update-available').map((x) => x.text).join('\n');
  const last = c.update?.last;
  if (last && !last.seen && last.at && Date.now() - Date.parse(last.at) < 5 * 60_000 && !S.lastShown) { S.lastShown = true; flash(last.ok ? `✓ Updated from kit ${last.from} to ${last.to}` : `⚠️ ${last.error}`); }
  if (!$('#panel').contains(document.activeElement)) renderPanel();
}
function openVersions() {
  let close = () => {};
  const draw = (note) => {
    const c = S.compat || { kit: {}, girafe: {}, problems: [], update: {} };
    const u = c.update || {};
    const rows = [['This kit', `${c.kit.version} · builds nodes for host API ${c.kit.hostApi} (accepts ${(c.kit.hostApis || []).join(', ')}) · simulates GIRAFE ${c.kit.simulates}`],
      ['GIRAFE', c.girafe?.version ? `${c.girafe.version} on ${new URL(c.girafe.base).host} · runs host API ${c.girafe.hostApis.join(', ')} · works with kit ${c.girafe.minKit} or newer${c.girafe.stale ? ' (last known, offline)' : ''}` : 'not known (offline, or a GIRAFE that doesn\'t say)'],
      ['Newest kit', c.latest ? `${c.latest.version} (${c.latest.from})` : 'not known'],
      ['Updates by', u.mode === 'git' ? 'git pull (this kit is a git clone)' : 'downloading the release from GitHub (your workspace is never touched)'],
      ['Node', c.kit.node]];
    const last = u.last;
    const body = [el('div', { class: 'v-table' }, ...rows.flatMap(([a, b]) => [el('span', { text: a }), el('span', { text: b })])),
      ...(c.problems.length ? c.problems.map((x) => el('div', { class: 'v-prob ' + x.level, text: x.text })) : [el('div', { class: 'v-prob info', text: 'The kit and GIRAFE match. Nothing to do.' })]),
      last ? el('div', { class: 'muted', text: last.ok ? `Last update: kit ${last.from} → ${last.to}, ${String(last.at).slice(0, 16).replace('T', ' ')}.` : `Last update: ${last.error}` }) : null,
      u.ready === false ? el('div', { class: 'v-prob warn', text: u.why }) : null,
      !u.supervised ? el('div', { class: 'muted', text: 'Started without its watcher (--no-watch): after an update, close the kit and start it again yourself.' }) : null,
      note ? el('div', { class: note.bad ? 'problems' : 'muted', text: note.text }) : null,
      el('div', { class: 'row', style: { marginTop: '10px' } },
        el('button', { text: '🔄 Check again', onclick: async () => { draw({ text: 'Checking…' }); await loadCompat(true); draw(); } }),
        el('button', { class: 'primary', text: u.mode === 'git' ? '⬆ Update the kit (git pull)' : `⬆ Update the kit${c.latest && c.updateAvailable ? ' to ' + c.latest.version : ''}`, disabled: u.ready === false || u.busy || (u.mode !== 'git' && !c.updateAvailable), onclick: () => runUpdate(draw) })),
      el('div', { class: 'caps', text: 'Before replacing anything, the kit copies its current files to workspace/.kit/update/. If the new version does not start, it puts them back by itself. Your nodes, graphs, keys and files (workspace/) are never touched.' })];
    close = dialog('🔄 Versions and updates', ...body);
  };
  draw();
  loadCompat(true).then(() => draw());
}
async function runUpdate(draw) {
  const before = S.info.kit;
  draw({ text: 'Updating… (downloading and checking)' });
  let r;
  try { r = await api('/api/update', { method: 'POST' }); } catch (e) { return draw({ text: '⚠️ ' + e.message, bad: true }); }
  if (r.upToDate) { await loadCompat(true); return draw({ text: `Already up to date (kit ${r.version}).` }); }
  if (r.restart !== 'auto') return draw({ text: `Kit ${r.to} is in place. Close the kit and start it again to use it.` });
  const ov = $('#keysDialog');
  ov.replaceChildren(el('div', { class: 'dialog' }, el('div', { class: 'v-restart' }, el('h3', { text: `Restarting on kit ${r.to}…` }), el('div', { class: 'muted', id: 'restartNote', text: 'This page reloads by itself in a few seconds.' }))));
  ov.hidden = false;
  const t0 = Date.now();
  const wait = async () => {
    try {
      const i = await (await fetch('/api/info', { cache: 'no-store' })).json();
      if (i.kit && i.kit !== before) return location.reload();
      if (i.kit === before && Date.now() - t0 > 8000) return location.reload(); // put back: the reload shows why
    } catch { /* restarting */ }
    if (Date.now() - t0 > 90_000) { $('#restartNote').textContent = 'The kit did not come back. Start it again (double-click the starter).'; return; }
    setTimeout(wait, 1000);
  };
  setTimeout(wait, 1500);
}

// ---------- start ----------
// ---------- signing in (kit/session.js) ----------
// The kit does nothing until you sign in with your GIRAFE account. You say whose computer it is.
function signInScreen(ses) {
  S.signingIn = true;
  const root = el('div', { class: 'signin' });
  document.body.append(root);
  let poll = null;
  const draw = (st, err) => {
    const p = st.pending;
    const waiting = p && p.state === 'waiting';
    root.replaceChildren(el('div', { class: 'signin-card' },
      el('img', { class: 'signin-logo', src: 'giraffe.svg', alt: '', width: 64, height: 64 }),
      el('h1', { text: 'Sign in with your GIRAFE account' }),
      el('p', { class: 'desc', text: 'Your nodes, keys and links come with your account. Nothing works in the kit before you sign in.' }),
      st.note ? el('div', { class: 'box warn-box' }, el('div', { class: 'caps', text: st.note })) : null,
      waiting
        ? el('div', { class: 'signin-wait' },
          el('div', { class: 'caps', text: `On ${new URL(p.verifyUrl).host}, check this code and click Allow:` }),
          el('div', { class: 'link-code', text: p.userCode }),
          el('button', { class: 'primary big', text: `Open ${new URL(p.verifyUrl).host}`, onclick: () => window.open(p.verifyUrl, '_blank', 'noopener') }),
          el('div', { class: 'muted', text: p.error ? '⚠️ ' + p.error : '⏳ Waiting for your Allow… this page notices by itself.' }),
          el('button', { class: 'link', text: 'Start again', onclick: () => go(st.trust) }))
        : el('div', { class: 'signin-choices' },
          el('button', { class: 'signin-choice', onclick: () => go('mine') },
            el('b', { text: '💻 This is my computer' }),
            el('span', { text: 'Stay signed in. Closing the page leaves the kit ready, like a browser.' })),
          el('button', { class: 'signin-choice', onclick: () => go('passing') },
            el('b', { text: '🌍 Not my computer' }),
            el('span', { text: `A café, a friend's: when the kit's page is closed for ${st.idleMinutes} minutes, your nodes are saved to GitHub and everything of yours is erased from here.` }))),
      p && (p.state === 'denied' || p.state === 'expired') ? el('div', { class: 'problems', text: p.state === 'denied' ? 'You said no on girafe.live. Choose again to retry.' : 'The code expired. Choose again.' }) : null,
      err ? el('div', { class: 'problems', text: err }) : null));
  };
  const watch = async () => {
    clearTimeout(poll);
    let st; try { st = await api('/api/session'); } catch { poll = setTimeout(watch, 3000); return; }
    if (st.signedIn) { root.classList.add('done'); setTimeout(() => location.reload(), 500); return; }
    draw(st);
    if (st.pending && st.pending.state === 'waiting') poll = setTimeout(watch, 2000);
  };
  const go = async (trust) => {
    try { const st = await api('/api/session/signin', { method: 'POST', body: JSON.stringify({ trust }) }); draw(st); if (st.pending?.verifyUrl) window.open(st.pending.verifyUrl, '_blank', 'noopener'); watch(); }
    catch (e) { draw(ses, e.message); }
  };
  draw(ses);
  if (ses.pending && ses.pending.state === 'waiting') watch();
}

// Leave this computer: keep the kit ready, or sign out and erase everything of yours from it.
function openLeave() {
  const ov = $('#keysDialog');
  const close = () => { ov.hidden = true; };
  const out = el('div');
  const erase = async (force) => {
    out.replaceChildren(el('div', { class: 'muted', text: 'Saving your nodes to GitHub, then signing out…' }));
    try {
      const r = await fetch('/api/session/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ erase: true, force }) }).then((x) => x.json());
      if (r.ok) {
        S.signingIn = true;
        out.replaceChildren(el('div', { class: 'box ok-box' }, el('div', { class: 'box-title', text: '✓ Signed out, your work erased from this computer' }), el('div', { class: 'caps', text: 'You can close this page.' })));
        setTimeout(() => location.reload(), 4000);
        return;
      }
      out.replaceChildren(el('div', { class: 'problems', text: r.error }),
        r.unsaved ? el('ul', { class: 'problems' }, ...r.unsaved.map((x) => el('li', { text: `${x.id}: ${x.why}` }))) : null,
        r.code === 'unsaved' ? el('div', { class: 'row' },
          !r.github ? el('button', { class: 'primary', text: 'Set up GitHub first', onclick: () => { close(); openGitHub(); } }) : null,
          el('button', { class: 'danger', text: 'Erase anyway (those nodes are lost)', onclick: () => { if (confirm(`Erase anyway? ${r.unsaved.map((x) => x.id).join(', ')} will be gone from everywhere.`)) erase(true); } })) : null);
    } catch (e) { out.replaceChildren(el('div', { class: 'problems', text: e.message })); }
  };
  ov.replaceChildren(el('div', { class: 'dialog' },
    el('div', { class: 'dialog-hd' }, el('h3', { text: '🚪 Leave this computer' }), el('button', { class: 'link', text: '✕', title: 'Close', onclick: close })),
    el('div', { class: 'caps', text: `Signed in as ${S.session?.account?.name || ''}${S.session?.account?.email ? ' · ' + S.session.account.email : ''}` }),
    el('div', { class: 'leave-choices' },
      el('button', { class: 'signin-choice', onclick: () => { out.replaceChildren(el('div', { class: 'box ok-box' }, el('div', { class: 'caps', text: 'The kit stays ready on this computer. You can close the page; next time it opens straight away.' }))); } },
        el('b', { text: '💻 Keep it ready here' }), el('span', { text: 'Stay signed in on this computer.' })),
      el('button', { class: 'signin-choice danger-choice', onclick: () => erase(false) },
        el('b', { text: '🧹 Sign out and erase my work' }), el('span', { text: 'Your nodes are saved to GitHub first. Then the kit signs out of GIRAFE and the market, and removes your nodes, graphs and keys from this computer.' }))),
    out));
  ov.hidden = false;
}

(async function start() {
  const ses = await api('/api/session');
  S.session = ses;
  if (ses.required && !ses.signedIn) return signInScreen(ses);
  // The page says it is open, so a computer that isn't yours knows when it was left.
  const beat = () => fetch('/api/session/beat', { method: 'POST' }).catch(() => {});
  beat(); setInterval(beat, 30_000);
  S.info = await api('/api/info');
  $('#versionBadge').textContent = `GIRAFE ${S.info.girafe} (simulated) · host API ${S.info.hostApi}`;
  $('#versionBadge').title = `The GIRAFE this kit pretends to be. Kit ${S.info.kit}. Plugins must name host API ${S.info.hostApi}.`;
  $('#palHint').replaceChildren('Your nodes live in ', el('code', { text: S.info.workspace + (S.info.workspace.includes('\\') ? '\\' : '/') + 'nodes' }), '. Changes are picked up on the next run. Kit updates and new downloads never touch this folder.');
  await loadKinds();
  initCanvas();
  checkWorkspace();
  $('#graphSel').addEventListener('change', (e) => openGraph(e.target.value));
  $('#newGraph').addEventListener('click', newGraph);
  $('#graphTitle').addEventListener('input', (e) => { S.graph.title = e.target.value; changed({ undoable: false, panel: false }); });
  $('#runBtn').addEventListener('click', runGraph);
  $('#stopBtn').addEventListener('click', () => api(`/api/runs/${S.runId}/stop`, { method: 'POST' }).then(poll));
  $('#fitBtn').addEventListener('click', fit);
  $('#keysBtn').addEventListener('click', openKeys);
  await loadKeys();
  $('#linkBtn').addEventListener('click', () => openLink());
  $('#leaveBtn').addEventListener('click', () => openLeave());
  if (ses.required) $('#leaveBtn').hidden = false; else $('#leaveBtn').hidden = true;
  await loadLink();
  $('#marketBtn').addEventListener('click', () => openMarket());
  await loadMarket();
  $('#ghBtn').addEventListener('click', () => openGitHub());
  await loadGitHub();
  setInterval(() => loadGitHub(), 5000);
  setInterval(() => { if (S.gh?.connected && !document.hidden) loadGitHub({ remote: true }); }, 120000);
  if (S.gh?.connected) loadGitHub({ remote: true });
  $('#versionAlert').addEventListener('click', () => openVersions());
  $('#versionBadge').addEventListener('click', () => openVersions());
  loadCompat();
  setInterval(() => { if (!document.hidden) loadCompat(); }, 30 * 60_000);
  $('#reloadKinds').addEventListener('click', () => loadKinds().then(render));
  window.addEventListener('focus', () => loadKinds().then(render));
  const { graphs } = await api('/api/graphs');
  if (!graphs.length) await newGraph(); else await loadGraphList();
})();


// ---------- your nodes on GitHub (kit/github.js) ----------
// The kit talks to GitHub's API itself (no git program): a token you paste in 🔑 Keys, sent to
// api.github.com only, through the network guard. Only the node folders are ever uploaded.
const GH_STATE = {
  clean: { mark: '', tip: 'Saved on GitHub' },
  changed: { mark: '●', tip: 'Changed here since it was saved on GitHub' },
  new: { mark: '＋', tip: 'Not on GitHub yet' },
  behind: { mark: '⬇', tip: 'GitHub has a newer version' },
  conflict: { mark: '⚠', tip: 'Changed both here and on GitHub' },
  deleted: { mark: '✕', tip: 'Removed from GitHub, still here' },
  remote: { mark: '☁', tip: 'Only on GitHub' },
  error: { mark: '⚠', tip: 'Can\'t be read' },
};
S.gh = null;
const ghNode = (id) => (S.gh?.connected ? S.gh.nodes?.[id] || null : null);
let ghLast = '';
async function loadGitHub({ remote = false } = {}) {
  try { S.gh = await api('/api/github' + (remote ? '?remote=1' : '')); } catch { return; }
  const btn = $('#ghBtn');
  const n = S.gh.connected ? Object.values(S.gh.nodes).filter((x) => ['changed', 'behind', 'conflict', 'deleted'].includes(x.state)).length : 0;
  btn.replaceChildren(ghMark(), ' ' + (S.gh.connected ? `${S.gh.repo}${n ? ' · ' + n : ''}` : 'GitHub'));
  btn.classList.toggle('gh-pending', n > 0);
  const sig = JSON.stringify(S.gh);
  if (sig !== ghLast) { ghLast = sig; renderPalette(); }
}
function ghMenuItems(id, name) {
  if (!S.gh?.connected) return [['Keep my nodes on GitHub…', () => openGitHub()]];
  const g = ghNode(id) || { state: 'new' };
  const items = [];
  if (['changed', 'new', 'deleted'].includes(g.state)) items.push(['💾 Save to GitHub…', () => ghSaveDialog(id, name)]);
  if (g.state === 'conflict') items.push(['💾 Keep mine (save over GitHub)…', () => ghSaveDialog(id, name, { mine: true })]);
  if (['behind', 'conflict', 'remote'].includes(g.state)) items.push([g.state === 'remote' ? '⬇ Get it from GitHub' : '⬇ Take GitHub\'s version', () => ghTake(id, name)]);
  if (['changed', 'conflict', 'new', 'deleted'].includes(g.state) && g.state !== 'new') items.push(['🔍 See my changes', () => ghDiff(id, name)]);
  if (g.state === 'changed') items.push(['↩ Undo my changes', () => ghTake(id, name, { undo: true })]);
  if (g.state !== 'new') items.push(['🕘 History…', () => ghHistory(id, name)]);
  items.push(['🔄 Check GitHub now', () => loadGitHub({ remote: true })]);
  return items;
}
function ghRemoteOnly() {
  if (!S.gh?.connected) return [];
  return Object.entries(S.gh.nodes).filter(([, g]) => g.state === 'remote').map(([id]) =>
    el('button', { class: 'pm-palette-btn gh-remote', title: 'Only on GitHub: right-click to get it', onclick: () => ghTake(id, id), oncontextmenu: (ev) => { ev.preventDefault(); showMenu(ev.clientX, ev.clientY, ghMenuItems(id, id), id); } },
      id, el('span', { class: 'gh-mark', text: '☁' })));
}
function ghInvite() {
  let off = false; try { off = localStorage.getItem('kit.gh.later') === '1'; } catch {}
  if (S.gh?.connected || off || !S.pluginList.length || !S.gh) return null;
  return el('div', { class: 'gh-invite' }, el('b', {}, ghMark(), ' Keep your nodes safe'),
    el('div', { class: 'muted', text: 'Save them to a private GitHub repo of yours: history, and the same nodes on every computer.' }),
    el('div', { class: 'row' }, el('button', { class: 'primary', text: 'Set it up', onclick: () => openGitHub() }),
      el('button', { text: 'Not now', onclick: () => { try { localStorage.setItem('kit.gh.later', '1'); } catch {} renderPalette(); } })));
}
const ghErr = (box, e) => box.replaceChildren(el('div', { class: 'problems', text: e.message }));
// GitHub's own mark (Octicons "mark-github", MIT), drawn in the text colour.
const GH_PATH = 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z';
function ghMark() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'gh-mark');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', GH_PATH); p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}
// A title with the GitHub mark in front.
const ghTitle = (text) => [ghMark(), ' ' + text];

function dialog(title, ...body) {
  const ov = $('#keysDialog');
  const close = () => { ov.hidden = true; };
  ov.replaceChildren(el('div', { class: 'dialog dialog-wide' }, el('div', { class: 'dialog-hd' }, Array.isArray(title) ? el('h3', {}, ...title) : el('h3', { text: title }), el('button', { class: 'link', text: '✕', title: 'Close', onclick: close })), ...body));
  ov.hidden = false;
  return close;
}
function openGitHub() {
  if (S.gh?.connected) return ghOverview();
  const tokens = S.keys.filter((k) => k.service === 'github');
  const repo = el('input', { placeholder: 'your-name/my-girafe-nodes', value: S.ghRepoDraft || '' });
  repo.addEventListener('input', () => { S.ghRepoDraft = repo.value; });
  const keySel = el('select', {}, ...(tokens.length ? tokens.map((k) => el('option', { value: k.id, text: `${k.label} · ${k.masked}` })) : [el('option', { value: '', text: '- no GitHub token yet -' })]));
  const out = el('div');
  const go = async (allowPublic = false) => {
    out.replaceChildren(el('div', { class: 'muted', text: 'Checking the repo on GitHub…' }));
    try {
      S.gh = await api('/api/github/connect', { method: 'POST', body: JSON.stringify({ keyId: keySel.value, repo: repo.value, allowPublic }) });
      await loadGitHub(); renderPalette(); ghOverview();
    } catch (e) {
      ghErr(out, e);
      if (/public/.test(e.message)) out.append(el('button', { class: 'danger', text: 'Use this public repo anyway', onclick: () => go(true) }));
    }
  };
  dialog(ghTitle('Keep your nodes on GitHub'),
    el('p', { class: 'desc', text: 'Your nodes (workspace/nodes) are saved to a GitHub repo of yours: every save is a version you can go back to, and another computer can get them. Only the node folders go there: never your keys, the signing key, or your test graphs.' }),
    el('div', { class: 'box' }, el('div', { class: 'box-title', text: '1 · Make an empty private repo' }),
      el('div', { class: 'caps', text: 'On GitHub: New repository → a name (e.g. my-girafe-nodes) → Private → Create. Leave it empty.' }),
      el('div', { class: 'row' }, el('a', { href: 'https://github.com/new', target: '_blank', rel: 'noopener', text: 'Open github.com/new' }))),
    el('div', { class: 'box' }, el('div', { class: 'box-title', text: '2 · Make a token for that repo only' }),
      el('div', { class: 'caps', text: 'Fine-grained token → Repository access: Only select repositories → your new repo → Permissions: Contents: Read and write. Copy it, then add it in 🔑 Keys (it is recognised as GitHub).' }),
      el('div', { class: 'row' }, el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'Make the token' }), el('button', { text: '🔑 Paste it in Keys…', onclick: () => { S.ghReturn = true; openKeys(); } }))),
    el('div', { class: 'box' }, el('div', { class: 'box-title', text: '3 · Connect' }),
      el('div', { class: 'field' }, el('label', { text: 'Repo (owner/name or its address)' }), repo),
      el('div', { class: 'field' }, el('label', { text: 'Token' }), keySel),
      el('div', { class: 'row' }, el('button', { class: 'primary', text: 'Connect', disabled: !tokens.length, onclick: () => go() }),
        el('button', { class: 'link', text: 'Refresh the token list', onclick: async () => { await loadKeys(); openGitHub(); } })),
      out),
    el('div', { class: 'muted', text: 'The token is stored like your other keys (encrypted on this computer) and only ever sent to api.github.com - see 🔑 Keys › Network.' }));
}
function ghOverview() {
  const g = S.gh;
  const list = el('div', { class: 'box' });
  const draw = () => {
    const rows = Object.entries(S.gh.nodes || {}).sort(([a], [b]) => a.localeCompare(b));
    list.replaceChildren(el('div', { class: 'box-title', text: 'Your nodes' }),
      ...(rows.length ? rows.map(([id, n]) => el('div', { class: 'key-row gh-row gh-' + n.state },
        el('div', {}, el('b', { text: id }), el('div', { class: 'muted', text: `${GH_STATE[n.state]?.tip || n.state}${n.savedAt ? ' · last saved or fetched ' + n.savedAt.slice(0, 16).replace('T', ' ') : ''}` })),
        el('button', { text: '⋯', title: 'Actions', onclick: (ev) => showMenu(ev.clientX, ev.clientY, ghMenuItems(id, id), id) }))) : [el('div', { class: 'muted', text: 'No node yet.' })]));
  };
  draw();
  const close = dialog(ghTitle('GitHub'),
    el('div', { class: 'box ok-box' }, el('div', { class: 'box-title', text: '✓ Connected' }),
      el('div', { class: 'caps' }, el('a', { href: g.url, target: '_blank', rel: 'noopener', text: `${g.owner}/${g.repo}` }), ` · branch ${g.branch} · ${g.private ? 'private' : 'PUBLIC'}`),
      g.error ? el('div', { class: 'problems', text: g.error }) : el('div', { class: 'muted', text: g.checkedAt ? 'Checked with GitHub at ' + g.checkedAt.slice(11, 16) : 'Not checked with GitHub yet' })),
    list,
    el('div', { class: 'row' }, el('button', { text: '🔄 Check GitHub now', onclick: async () => { await loadGitHub({ remote: true }); ghOverview(); } }),
      el('button', { class: 'danger', text: 'Stop using GitHub', onclick: async () => { if (!confirm('Stop using this repo? Nothing is deleted: not on GitHub, not here.')) return; await api('/api/github/disconnect', { method: 'POST' }); await loadGitHub(); close(); } })),
    el('div', { class: 'muted', text: 'Right-click a node in "Your nodes" (or on the canvas) for Save, changes, history. A pulsing node has changes not saved to GitHub.' }));
}
function ghSaveDialog(id, name, { mine = false } = {}) {
  const msg = el('input', { placeholder: 'What changed? e.g. "Retry when the service is busy"' });
  const out = el('div');
  const go = async () => {
    out.replaceChildren(el('div', { class: 'muted', text: 'Saving to GitHub…' }));
    try {
      const r = await api('/api/github/save', { method: 'POST', body: JSON.stringify({ id, message: msg.value, mine }) });
      await loadGitHub();
      out.replaceChildren(el('div', { class: 'box ok-box' }, el('div', { class: 'box-title', text: r.nothing ? 'Nothing to save' : '✓ Saved' }),
        r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener', text: 'See it on GitHub' }) : el('div', { class: 'caps', text: 'GitHub already has exactly these files.' })));
    } catch (e) {
      ghErr(out, e);
      if (e.message.includes('newer version') || e.message.includes('both here')) out.append(el('div', { class: 'row' },
        el('button', { text: '⬇ Take GitHub\'s version', onclick: () => ghTake(id, name) }),
        el('button', { class: 'danger', text: 'Save mine over it', onclick: () => ghSaveDialog(id, name, { mine: true }) })));
    }
  };
  msg.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  dialog(`💾 Save ${name} to GitHub`,
    mine ? el('div', { class: 'box warn-box' }, el('div', { class: 'caps', text: 'GitHub has another version of this node. Saving replaces it with yours (the other one stays in the history).' })) : null,
    el('div', { class: 'field' }, el('label', { text: 'A few words about this change' }), msg),
    el('div', { class: 'caps', text: 'The files are checked first: anything that looks like a key stops the save.' }),
    el('div', { class: 'row' }, el('button', { class: 'primary', text: mine ? 'Save mine over it' : 'Save', onclick: go }), el('button', { text: '🔍 See my changes', onclick: () => ghDiff(id, name) })),
    out);
  msg.focus();
}
async function ghTake(id, name, { undo = false } = {}) {
  if (!confirm(undo ? `Undo your changes to ${name}? Its files go back to the version on GitHub.` : `Replace ${name} on this computer with the version on GitHub? Your unsaved work, if any, is copied to workspace/.kit/backups first.`)) return;
  try {
    const r = await api('/api/github/update', { method: 'POST', body: JSON.stringify({ id }) });
    await loadKinds(); await loadGitHub(); render();
    flash(r.backup ? `${name}: GitHub's version is here. Yours was copied to ${r.backup}` : `${name}: GitHub's version is here.`);
  } catch (e) { alert(e.message); }
}
async function ghDiff(id, name) {
  const body = el('div', {}, el('div', { class: 'muted', text: 'Comparing with GitHub…' }));
  dialog(`🔍 ${name}: changes not on GitHub`, body);
  try {
    const { files } = await api('/api/github/diff?id=' + encodeURIComponent(id));
    body.replaceChildren(...(files.length ? files.map((f) => el('div', { class: 'box' },
      el('div', { class: 'box-title', text: `${f.kind === 'added' ? '＋ new' : f.kind === 'removed' ? '－ removed' : '● changed'} · ${f.file}` }),
      f.lines ? el('pre', { class: 'gh-diff' }, ...f.lines.map((l) => el('div', { class: 'gh-l gh-l' + (l.t === '+' ? 'add' : l.t === '-' ? 'del' : l.t === '…' ? 'gap' : 'ctx'), text: l.t === '…' ? (l.s || '⋯') : `${l.t} ${l.s}` }))) : el('div', { class: 'muted', text: 'Not a text file.' }))) : [el('div', { class: 'muted', text: 'Same as on GitHub.' })]));
  } catch (e) { ghErr(body, e); }
}
async function ghHistory(id, name) {
  const body = el('div', {}, el('div', { class: 'muted', text: 'Reading the history on GitHub…' }));
  dialog(`🕘 ${name}: versions on GitHub`, body);
  try {
    const { commits } = await api('/api/github/history?id=' + encodeURIComponent(id));
    body.replaceChildren(el('div', { class: 'caps', text: 'Putting an older version back changes the files here; save it to make it the latest. Unsaved work is copied to workspace/.kit/backups first.' }),
      ...(commits.length ? commits.map((c, i) => el('div', { class: 'key-row' },
        el('div', {}, el('b', { text: c.message || '(no message)' }), el('div', { class: 'muted' }, `${String(c.at || '').slice(0, 16).replace('T', ' ')} · ${c.author} · `, el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.sha.slice(0, 7) }))),
        i === 0 ? el('span', { class: 'badge', text: 'latest' }) : el('button', { text: 'Put this one back', onclick: async () => {
          if (!confirm(`Put the version "${c.message}" back in ${name}?`)) return;
          try { const r = await api('/api/github/restore', { method: 'POST', body: JSON.stringify({ id, commit: c.sha }) }); await loadKinds(); await loadGitHub(); render(); $('#keysDialog').hidden = true; flash(`${name}: older version back${r.backup ? ', yours copied to ' + r.backup : ''}. Save it to make it the latest.`); }
          catch (e) { alert(e.message); }
        } }))) : [el('div', { class: 'muted', text: 'No version on GitHub yet.' })]));
  } catch (e) { ghErr(body, e); }
}


// ---------- where your work lives (kit/home.js) ----------
// One folder in your home, shared by every copy of the kit, so a new download never hides your work.
// On start: say so once if old work was just moved there, and offer to bring work still sitting in
// another kit folder (an older download in Downloads, Desktop or Documents).
async function checkWorkspace() {
  let w;
  try { w = await api('/api/workspace'); } catch { return; }
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('kit.ws.dismissed') || '{}'); } catch {}
  const others = (w.others || []).filter((o) => !seen[o.path]);
  if (S.info.migratedFrom) {
    dialog('📦 Your work has a permanent home',
      el('p', { class: 'desc', text: 'Your nodes, graphs, keys, GitHub link and signing key were copied from the kit\'s own folder to:' }),
      el('div', { class: 'box' }, el('code', { text: w.root })),
      el('p', { class: 'desc', text: 'Every copy of the kit on this computer now uses that folder. Updating the kit, or downloading it again, can no longer lose your work. The old folder was left as it was.' }),
      others.length ? el('button', { class: 'primary', text: 'Next', onclick: () => offerOthers(others, w.root) }) : null);
    return;
  }
  if (others.length) offerOthers(others, w.root);
}
function describeKit(o) {
  const bits = [];
  if (o.nodes.length) bits.push(`${o.nodes.length} node${o.nodes.length > 1 ? 's' : ''}: ${o.nodes.join(', ')}`);
  if (o.graphs) bits.push(`${o.graphs} graph${o.graphs > 1 ? 's' : ''}`);
  if (o.keys) bits.push('your keys');
  if (o.github) bits.push('the GitHub link');
  if (o.authorKey) bits.push('your signing key');
  if (o.girafe) bits.push('the GIRAFE connection');
  if (o.market) bits.push('the Market connection');
  return bits.join(' · ');
}
function offerOthers(others, root) {
  const out = el('div');
  const rows = others.map((o) => {
    const status = el('div', { class: 'muted' });
    const btn = el('button', { class: 'primary', text: 'Bring it here', onclick: async () => {
      btn.disabled = true; status.textContent = 'Copying…';
      try {
        const r = await api('/api/workspace/import', { method: 'POST', body: JSON.stringify({ path: o.path }) });
        const got = [r.nodes.length ? `${r.nodes.length} node${r.nodes.length > 1 ? 's' : ''}` : null, r.graphs ? `${r.graphs} graph${r.graphs > 1 ? 's' : ''}` : null, r.keys ? 'keys' : null, r.github ? 'GitHub link' : null, r.authorKey ? 'signing key' : null, r.girafe ? 'GIRAFE connection' : null, r.market ? 'Market connection' : null].filter(Boolean);
        let text = got.length ? `✓ Brought here: ${got.join(', ')}.` : '✓ Nothing new: everything was already here.';
        if (r.skippedNodes.length) text += ` Kept the copies already here of: ${r.skippedNodes.join(', ')}.`;
        if (r.conflicts.length) text += ` This folder already has its own ${r.conflicts.join(', ')}; the other one was left in ${o.path}.`;
        status.textContent = text;
        if (r.restart === 'manual') status.textContent += ' Close the kit and start it again to use them.';
        else { status.textContent += ' Restarting…'; setTimeout(function wait() { fetch('/api/info', { cache: 'no-store' }).then(() => location.reload(), () => setTimeout(wait, 800)); }, 1800); }
      } catch (e) { status.textContent = '⚠️ ' + e.message; btn.disabled = false; }
    } });
    const later = el('button', { text: 'Not now', onclick: () => { try { const d = JSON.parse(localStorage.getItem('kit.ws.dismissed') || '{}'); d[o.path] = Date.now(); localStorage.setItem('kit.ws.dismissed', JSON.stringify(d)); } catch {} row.remove(); if (!out.querySelector('.box')) $('#keysDialog').hidden = true; } });
    const row = el('div', { class: 'box' },
      el('div', { class: 'box-title', style: { textTransform: 'none', letterSpacing: '0' }, text: o.path }),
      el('div', { class: 'desc', text: describeKit(o) }),
      o.modifiedAt ? el('div', { class: 'muted', text: 'Last changed ' + String(o.modifiedAt).slice(0, 16).replace('T', ' ') }) : null,
      el('div', { class: 'row', style: { marginTop: '8px' } }, btn, later), status);
    return row;
  });
  out.replaceChildren(...rows);
  dialog('📦 Work found in another kit folder',
    el('p', { class: 'desc', text: 'Another copy of the kit on this computer still holds work of yours. Bring it into your workspace so this kit has it:' }),
    el('div', { class: 'muted' }, 'Your workspace: ', el('code', { text: root })),
    out,
    el('div', { class: 'caps', text: 'Nothing is overwritten: nodes already here stay as they are, and keys or the signing key come over only when this workspace has none. The other folder is left untouched.' }));
}
