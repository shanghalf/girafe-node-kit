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
const GLYPH = { idle: '', running: '⏳', waiting: '✋', done: '✓', error: '⚠️', skipped: '⤼', stopped: '⏹' };

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
  const mk = (k) => el('button', { class: 'pal-btn' + (k.problems?.length ? ' bad' : ''), style: { '--c': k.color }, title: k.problems?.length ? k.problems.join('\n') : k.description, onclick: () => addNodeAtCenter(k.type) },
    el('span', { text: k.icon }), el('span', { text: k.name }), k.problems?.length ? el('span', { class: 'badge', text: '⚠' }) : null);
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
function makesLoop(from, to) {
  const seen = new Set(); const stack = [to];
  while (stack.length) { const c = stack.pop(); if (c === from) return true; if (seen.has(c)) continue; seen.add(c); for (const w of S.graph.wires) if (w.from === c) stack.push(w.to); }
  return false;
}
function tryWire(from, port, to) {
  const t = node(to);
  if (!t || from === to) return flash('A node can\'t feed itself.');
  const k = kindOf(t);
  if (!takesInput(k)) return flash(`${k.name} takes no input.`);
  if (wiresInto(to).length >= (k.inputs.max ?? 8)) return flash(`${k.name} takes at most ${k.inputs.max} input${k.inputs.max === 1 ? '' : 's'}.`);
  if (S.graph.wires.some((w) => w.from === from && w.to === to && (w.port || 'out') === port)) return flash('Already wired.');
  if (makesLoop(from, to)) return flash('That wire would make a loop.');
  const w = { id: uid('w'), from, port, to };
  S.graph.wires.push(w); S.sel = { type: 'wire', id: w.id }; changed();
}
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
  const els = ns.map((n) => document.querySelector(`.node[data-id="${n.id}"]`));
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
  if (panel && !(document.activeElement?.matches('input, textarea, select') && $('#panel').contains(document.activeElement))) renderPanel();
  renderAsks();
}
function nodeRun(id) { return S.run?.nodes?.[id] || null; }

function renderNode(n) {
  const k = kindOf(n);
  const st = nodeRun(n.id);
  const ins = wiresInto(n.id);
  const e = el('div', {
    class: `node${S.sel?.type === 'node' && S.sel.id === n.id ? ' sel' : ''}${n.disabled ? ' off' : ''}${st ? ' st-' + st.status : ''}`,
    'data-id': n.id, style: { left: n.x + 'px', top: n.y + 'px', '--c': k.color },
  });
  const hd = el('div', { class: 'node-hd', onpointerdown: (ev) => beginNodeDrag(ev, n) },
    el('span', { text: k.icon }),
    el('span', { class: 'ttl', text: n.title || k.name, title: k.name }),
    el('span', { class: 'glyph', text: GLYPH[st?.status] || '' }),
    el('button', { class: 'tog', title: n.disabled ? 'Turned off: click to turn on' : 'Click to turn off (skip it in runs)', onpointerdown: (ev) => ev.stopPropagation(), onclick: (ev) => { ev.stopPropagation(); n.disabled = !n.disabled; changed(); } }));
  const insCol = el('div', { class: 'ins' });
  if (takesInput(k)) {
    ins.forEach((w, i) => insCol.append(el('div', { class: 'port' }, el('span', { class: 'sock', 'data-in': n.id, 'data-idx': i }), letter(i))));
    if (ins.length < (k.inputs.max ?? 8)) insCol.append(el('div', { class: 'port' }, el('span', { class: 'sock empty', 'data-in': n.id, 'data-idx': ins.length }), el('span', { class: 'muted', text: letter(ins.length) })));
  }
  const outsCol = el('div', { class: 'outs' }, ...(k.outputs || ['out']).map((p) => el('div', { class: 'port' }, (k.outputs || []).length > 1 ? el('span', { text: outLabel(n, p) }) : null,
    el('span', { class: 'sock', 'data-out': n.id, 'data-port': p, onpointerdown: (ev) => beginWireDrag(ev, n.id, p) }))));
  e.append(hd, el('div', { class: 'node-io' }, insCol, outsCol), el('div', { class: 'node-body' }, ...nodeSummary(n, k, st)));
  e.addEventListener('pointerdown', (ev) => { if (ev.button === 0) { S.sel = { type: 'node', id: n.id }; markSel(); renderPanel(); } });
  e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); S.sel = { type: 'node', id: n.id }; markSel(); renderPanel(); showMenu(ev.clientX, ev.clientY, [[ '🗑 Delete', deleteSelected ], [ n.disabled ? '● Turn on' : '○ Turn off', () => { n.disabled = !n.disabled; changed(); } ], [ '⧉ Duplicate', () => duplicate(n) ]], k.name); });
  return e;
}
function outLabel(n, p) { if (n.type === 'ask') return p === 'yes' ? (n.yesLabel || 'yes') : (n.noLabel || 'no'); return p; }
function duplicate(n) { const c = structuredClone(n); c.id = uid('n'); c.x += 30; c.y += 30; S.graph.nodes.push(c); S.sel = { type: 'node', id: c.id }; changed(); }

function nodeSummary(n, k, st) {
  const out = [];
  if (n.type === 'input') out.push(el('div', { class: 'preview', text: n.value ? String(n.value).slice(0, 160) : 'No value yet.' }));
  else if (n.type === 'image') out.push(isRef(n.image) ? el('div', { class: 'thumbs one' }, el('img', { src: n.image.imageUrl, alt: '' })) : el('div', { class: 'preview', text: 'No picture yet.' }));
  else if (n.type === 'ask') out.push(el('div', { class: 'preview', text: n.prompt || 'No question yet.' }));
  else if (k.missing) out.push(el('div', { class: 'note err', text: 'Unknown node type.' }));
  else if (k.problems?.length) out.push(el('div', { class: 'note err', text: k.problems[0] }));
  const pics = st?.outputs ? picsOf(st.outputs) : [];
  if (pics.length && n.type !== 'image') out.push(el('div', { class: 'thumbs' }, ...pics.slice(0, 8).map((r) => el('img', { src: r.imageUrl, alt: '' }))));
  else if (st?.outputs?.length && n.type !== 'input' && n.type !== 'image') out.push(el('div', { class: 'preview', text: shortText(st.outputs) }));
  if (st?.note) out.push(el('div', { class: 'note' + (st.status === 'error' ? ' err' : ''), text: st.note }));
  return out;
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
  for (const e of document.querySelectorAll('.node')) e.classList.toggle('sel', S.sel?.type === 'node' && S.sel.id === e.dataset.id);
  drawWires();
}

// ---------- wires ----------
function sockCenter(sel) {
  const s = document.querySelector(sel);
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}
const curve = (a, b) => { const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; };
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
let draft = null;
function drawWires() {
  const svg = $('#wires');
  svg.replaceChildren();
  for (const w of S.graph.wires) {
    const idx = wiresInto(w.to).indexOf(w);
    const a = sockCenter(`[data-out="${w.from}"][data-port="${w.port || 'out'}"]`);
    const b = sockCenter(`[data-in="${w.to}"][data-idx="${idx}"]`);
    if (!a || !b) continue;
    const d = curve(a, b);
    const count = S.run?.wires?.[w.id]?.count;
    const sel = S.sel?.type === 'wire' && S.sel.id === w.id;
    svg.append(svgEl('path', { d, class: `wire${count ? ' has-data' : ''}${sel ? ' sel' : ''}` }));
    const hit = svgEl('path', { d, class: 'wire-hit' });
    hit.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); S.sel = { type: 'wire', id: w.id }; markSel(); renderPanel(); });
    hit.addEventListener('contextmenu', (ev) => { ev.preventDefault(); S.sel = { type: 'wire', id: w.id }; markSel(); showMenu(ev.clientX, ev.clientY, [['🗑 Delete wire', deleteSelected]]); });
    svg.append(hit);
    if (count !== undefined) { const t = svgEl('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6, class: 'wire-count', 'text-anchor': 'middle' }); t.textContent = count === 1 ? '1 item' : `${count} items`; svg.append(t); }
  }
  if (draft) svg.append(svgEl('path', { d: curve(draft.a, draft.b), class: 'wire draft' }));
}

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
  const e = document.querySelector(`.node[data-id="${n.id}"]`);
  let moved = false;
  track(ev, (m) => {
    const dx = (m.clientX - start.x) / S.view.k, dy = (m.clientY - start.y) / S.view.k;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true; n.x = Math.round(start.nx + dx); n.y = Math.round(start.ny + dy);
    e.style.left = n.x + 'px'; e.style.top = n.y + 'px'; drawWires();
  }, () => { if (moved) changed(); });
}
function beginWireDrag(ev, from, port) {
  if (ev.button !== 0) return;
  ev.stopPropagation(); ev.preventDefault();
  const a = sockCenter(`[data-out="${from}"][data-port="${port}"]`);
  draft = { a, b: a };
  track(ev, (m) => { draft.b = toWorld(m.clientX, m.clientY); drawWires(); }, (u) => {
    draft = null; drawWires();
    const hitEl = document.elementFromPoint(u.clientX, u.clientY);
    const target = hitEl?.closest('[data-in]')?.dataset.in || hitEl?.closest('.node')?.dataset.id;
    if (target) return tryWire(from, port, target);
    if (hitEl?.closest('#canvas')) {
      const p = toWorld(u.clientX, u.clientY);
      const kinds = [...S.kinds.values()].filter((k) => takesInput(k) && !k.problems?.length);
      showMenu(u.clientX, u.clientY, kinds.map((k) => [`${k.icon} ${k.name}`, () => { const n = makeNode(k.type, p.x, p.y - 30); S.graph.nodes.push(n); S.graph.wires.push({ id: uid('w'), from, port, to: n.id }); S.sel = { type: 'node', id: n.id }; changed(); }]), 'Add a node fed by this');
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
    if (ev.target.closest('.node') || ev.target.closest('.wire-hit')) return;
    ev.preventDefault();
    const p = toWorld(ev.clientX, ev.clientY);
    showMenu(ev.clientX, ev.clientY, [...S.kinds.values()].filter((k) => !k.problems?.length).map((k) => [`${k.icon} ${k.name}`, () => { const n = makeNode(k.type, p.x, p.y); S.graph.nodes.push(n); S.sel = { type: 'node', id: n.id }; changed(); }]), 'Add a node');
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
    el('h3', {}, el('span', { text: k.icon }), k.name, k.core ? el('span', { class: 'badge', text: 'core' }) : el('span', { class: 'badge', text: 'plugin ' + (k.version || '') })),
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
  if (takesInput(k)) {
    const ins = wiresInto(n.id);
    kids.push(el('div', { class: 'box' }, el('div', { class: 'box-title', text: 'Inputs' }),
      ins.length ? ins.map((w, i) => el('div', { class: 'muted', text: `${letter(i)} ← ${node(w.from)?.title || '?'}${w.port && w.port !== 'out' ? ' (' + w.port + ')' : ''}` })) : el('div', { class: 'muted', text: 'Nothing wired in yet.' })));
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
  const idx = wiresInto(w.to).indexOf(w);
  const count = S.run?.wires?.[w.id]?.count;
  return [el('h3', { text: 'Wire' }), el('p', { class: 'desc', text: `${node(w.from)?.title} (${w.port || 'out'}) → ${node(w.to)?.title}, socket ${letter(idx)}` }),
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
async function runGraph() {
  await save();
  for (const n of S.graph.nodes) if (nodeRun(n.id)) S.run.nodes[n.id] = { status: 'idle' };
  try {
    const { runId } = await api('/api/run', { method: 'POST', body: JSON.stringify({ graph: S.graph }) });
    S.runId = runId; S.run = { status: 'running', nodes: {}, wires: {}, asks: [] };
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
    else { $('#runBtn').hidden = false; $('#stopBtn').hidden = true; }
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
