// GIRAFE node kit - the canvas, palette and panel. Plain JavaScript, no build step.
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
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const letter = (i) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
const isRef = (v) => !!(v && typeof v === 'object' && v.key && v.mime);
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
  renderPalette();
}
const kindOf = (n) => S.kinds.get(n.type) || { name: n.type, color: '#666', icon: '?', outputs: ['out'], inputs: { min: 0, max: 8 }, fields: [], missing: true, description: 'This node type is not available (a plugin removed or renamed?).' };
const takesInput = (k) => (k.inputs?.max ?? 0) > 0;

function renderPalette() {
  const mk = (k) => el('button', { class: 'pm-palette-btn' + (k.problems?.length ? ' bad' : ''), style: { '--pm-kind-color': k.color }, title: k.problems?.length ? k.problems.join('\n') : k.description, onclick: () => addNodeAtCenter(k.type) },
    kindLabel(k), k.problems?.length ? el('span', { class: 'badge', text: '⚠' }) : null);
  $('#palCore').replaceChildren(...S.coreList.map(mk));
  $('#palPlugins').replaceChildren(...(S.pluginList.length ? S.pluginList.map(mk) : [el('div', { class: 'muted', text: 'None yet.' })]));
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
  e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); S.sel = { type: 'node', id: n.id }; markSel(); renderPanel(); showMenu(ev.clientX, ev.clientY, [[ '🗑 Delete', deleteSelected ], [ n.disabled ? '⏻ Turn on' : '⏽ Turn off', () => { n.disabled = !n.disabled; changed(); } ], [ '⧉ Duplicate', () => duplicate(n) ]], k.name); });
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
      ...pics.map((r) => el('img', { class: 'pm-node-gallery-thumb', src: r.imageUrl, alt: '', title: r.name || '' }))));
  }
  if (st?.note) out.push(el('div', { class: 'pm-node-note', text: st.note }));
  if (st?.outputs?.length && !(n.type === 'image' && isRef(n.image)) && !(n.type === 'collect' && pics.length)) {
    out.push(el('div', { class: 'pm-node-preview', text: pics.length ? `📷 ${pics.length} image${pics.length === 1 ? '' : 's'}` : truncate(shortText(st.outputs), 140) }));
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
  if (namedOuts(k)) {
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
  m.replaceChildren(...(title ? [el('div', { class: 'mt', text: title })] : []), ...items.map(([label, fn]) => el('button', { text: label, onclick: () => { hideMenu(); fn(); } })));
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
  for (const f of k.fields || []) {
    const isPlugin = n.type.startsWith('plugin:');
    const get = () => (isPlugin ? n.settings?.[f.key] : n[f.key]);
    const set = (v) => { if (isPlugin) { n.settings = { ...(n.settings || {}), [f.key]: v }; } else n[f.key] = v; changed({ undoable: false, panel: false }); };
    kids.push(f.type === 'image' ? imageField(n) : field(f, get() ?? (f.default ?? ''), set));
  }
  {
    const ins = dataWiresInto(n.id), flows = flowWiresInto(n.id);
    const src = (w) => `${node(w.from)?.title || '?'}${w.port && w.port !== 'out' ? ' (' + outLabel(node(w.from) || {}, w.port) + ')' : ''}`;
    const rows = [...flows.map((w) => `▣ run if ← ${src(w)}`), ...ins.map((w, i) => `${letter(i)} ← ${src(w)}`)];
    if (takesInput(k) || rows.length) kids.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Inputs' }),
      rows.length ? rows.map((t) => el('div', { class: 'muted', text: t })) : el('div', { class: 'muted', text: 'Nothing wired in yet.' })));
  }
  if (!k.core && !k.missing) kids.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Manifest' }),
    el('div', { class: 'caps', text: `host API ${k.hostApi} · needs GIRAFE ${k.girafe || 'any'} · outputs: ${(k.outputs || []).join(', ')}` }),
    el('div', { class: 'caps', text: 'capabilities: ' + (Object.keys(k.capabilities || {}).length ? JSON.stringify(k.capabilities) : 'none') }),
    el('div', { class: 'caps', text: `folder: workspace/nodes/${k.id}/` })));
  if (st) kids.push(runBox(st));
  kids.push(el('div', { class: 'row' }, el('button', { text: n.disabled ? '● Turn on' : '○ Turn off', onclick: () => { n.disabled = !n.disabled; changed(); } }), el('button', { class: 'danger', text: '🗑 Delete', onclick: deleteSelected })));
  p.replaceChildren(...kids);
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
function runBox(st) {
  const pics = picsOf(st.outputs || []);
  return el('div', { class: 'box' }, el('div', { class: 'box-title', text: `Last run · ${st.status}${st.firings ? ' · fired ' + st.firings + '×' : ''}` }),
    st.note ? el('div', { class: st.status === 'error' ? 'problems' : 'muted', text: st.note }) : null,
    pics.length ? el('div', { class: 'thumbs' }, ...pics.map((r) => el('a', { href: r.imageUrl, target: '_blank' }, el('img', { src: r.imageUrl, alt: '' })))) : null,
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
      el('div', { class: 'caps', text: 'A plugin names the host API and the oldest GIRAFE it works with in its manifest. When GIRAFE moves on, update the kit.' })),
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

// ---------- start ----------
(async function start() {
  S.info = await api('/api/info');
  $('#versionBadge').textContent = `GIRAFE ${S.info.girafe} (simulated) · host API ${S.info.hostApi}`;
  $('#versionBadge').title = `The GIRAFE this kit pretends to be. Kit ${S.info.kit}. Plugins must name host API ${S.info.hostApi}.`;
  await loadKinds();
  initCanvas();
  $('#graphSel').addEventListener('change', (e) => openGraph(e.target.value));
  $('#newGraph').addEventListener('click', newGraph);
  $('#graphTitle').addEventListener('input', (e) => { S.graph.title = e.target.value; changed({ undoable: false, panel: false }); });
  $('#runBtn').addEventListener('click', runGraph);
  $('#stopBtn').addEventListener('click', () => api(`/api/runs/${S.runId}/stop`, { method: 'POST' }).then(poll));
  $('#fitBtn').addEventListener('click', fit);
  $('#reloadKinds').addEventListener('click', () => loadKinds().then(render));
  window.addEventListener('focus', () => loadKinds().then(render));
  const { graphs } = await api('/api/graphs');
  if (!graphs.length) await newGraph(); else await loadGraphList();
})();
