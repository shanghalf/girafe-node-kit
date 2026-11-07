// A small run engine with the same rules plugin authors meet on GIRAFE:
//  - values travel between nodes as text, or as file references { imageUrl, key, mime }
//  - input sockets are lettered A, B, C... by the order the wires were drawn
//  - a node fed by a stream (For each, or anything after it) fires once per item;
//    other inputs keep their single value for every firing
//  - Collect waits for the whole stream and sends one list
//  - a node whose inputs all stayed empty is skipped (and so is everything after it)
// It runs every node of a level before the next one (GIRAFE streams item by item; the
// results are the same, only the order of the progress lights differs).
const crypto = require('crypto');
const core = require('./core-nodes');
const plugins = require('./plugins');

const letter = (i) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

function order(graph) {
  const ids = graph.nodes.map((n) => n.id);
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const w of graph.wires) if (indeg.has(w.to) && indeg.has(w.from)) indeg.set(w.to, indeg.get(w.to) + 1);
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const out = [];
  while (queue.length) {
    const id = queue.shift(); out.push(id);
    for (const w of graph.wires) if (w.from === id && indeg.has(w.to)) { indeg.set(w.to, indeg.get(w.to) - 1); if (indeg.get(w.to) === 0) queue.push(w.to); }
  }
  if (out.length !== ids.length) throw new Error('The graph has a loop; remove one wire.');
  return out;
}

function kindOf(n, pluginList) {
  if (core.KINDS[n.type]) return { core: core.KINDS[n.type] };
  if (String(n.type).startsWith('plugin:')) {
    const p = pluginList.find((x) => x.type === n.type);
    return p ? { plugin: p } : { missing: true };
  }
  return { missing: true };
}

function createRun(graph, { onChange } = {}) {
  const id = crypto.randomUUID();
  const ctrl = new AbortController();
  const rs = { id, status: 'running', startedAt: Date.now(), nodes: {}, wires: {}, asks: [], log: [] };
  const answers = new Map();
  const changed = () => onChange && onChange(rs);
  for (const n of graph.nodes) rs.nodes[n.id] = { status: 'idle' };

  const ask = (req) => new Promise((resolve, reject) => {
    const a = { id: crypto.randomUUID(), ...req, since: Date.now() };
    rs.asks.push(a); answers.set(a.id, { resolve, reject }); changed();
    ctrl.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
  });

  const promise = (async () => {
    const pluginList = plugins.listPlugins();
    const ids = order(graph);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const produced = new Map(); // nodeId -> { packets: { port: [values] }, stream: bool }

    for (const nid of ids) {
      if (ctrl.signal.aborted) break;
      const n = byId.get(nid);
      const st = rs.nodes[nid];
      const kind = kindOf(n, pluginList);
      const inWires = graph.wires.filter((w) => w.to === nid && byId.has(w.from));
      const ports = inWires.map((w, i) => {
        const src = produced.get(w.from) || { packets: {}, stream: false };
        const port = w.port || 'out';
        return { letter: letter(i), values: src.packets[port] || [], stream: src.stream };
      });
      const empty = (p) => p.values.length === 0;
      const result = { packets: {}, stream: false };
      const emit = (port, value) => { (result.packets[port] = result.packets[port] || []).push(value); };
      produced.set(nid, result);

      if (n.disabled) { st.status = 'skipped'; st.note = 'turned off'; changed(); continue; }
      if (kind.missing) { st.status = 'error'; st.note = `unknown node type "${n.type}" (plugin removed?)`; changed(); continue; }
      const needsInput = kind.core ? kind.core.needsInput : (kind.plugin.inputs?.min ?? 0) > 0;
      if ((ports.length && ports.every(empty)) || (needsInput && !ports.length)) {
        st.status = 'skipped'; st.note = ports.length ? 'nothing arrived on its inputs' : 'nothing is wired into it'; changed(); continue;
      }

      st.status = 'running'; st.note = ''; st.outputs = []; st.firings = 0; changed();
      try {
        if (kind.core && kind.core.collects) {
          await kind.core.run({ n, ports, emit, ask, signal: ctrl.signal, st });
          st.firings = 1;
        } else {
          // One firing per item of the streamed inputs; single inputs are re-used every time.
          const streams = ports.filter((p) => p.stream);
          const count = streams.length ? Math.min(...streams.map((p) => p.values.length)) : 1;
          for (let i = 0; i < count; i++) {
            if (ctrl.signal.aborted) throw new Error('Stopped');
            const ins = {};
            for (const p of ports) ins[p.letter] = p.stream ? p.values[i] : p.values[p.values.length - 1];
            for (const k of Object.keys(ins)) if (ins[k] === undefined) delete ins[k];
            if (kind.core) await kind.core.run({ n, ins, emit, ask, signal: ctrl.signal, st, index: i });
            else {
              const r = await plugins.runPlugin(kind.plugin, {
                inputs: ins,
                settings: { ...Object.fromEntries((kind.plugin.fields || []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default])), ...(n.settings || {}) }, title: n.title || kind.plugin.name, signal: ctrl.signal,
                onProgress: (t) => { st.note = t; changed(); },
              });
              for (const o of r.outputs) emit(o.port, o.value);
              if (r.logs.length) st.logs = (st.logs || []).concat(r.logs).slice(-200);
            }
            st.firings = i + 1; changed();
          }
          result.stream = (kind.core && kind.core.streams) || streams.length > 0 || Object.values(result.packets).some((v) => v.length > 1);
        }
        const all = Object.values(result.packets).flat();
        st.outputs = all.slice(0, 200).map((v) => (typeof v === 'string' ? v.slice(0, 20000) : v));
        st.status = 'done';
        if (st.firings > 1 && (!st.note || kind.plugin)) st.note = `ran ${st.firings} times`;
      } catch (e) {
        st.status = ctrl.signal.aborted ? 'stopped' : 'error';
        st.note = e.message;
        result.packets = {};
      }
      for (const w of graph.wires.filter((x) => x.from === nid)) rs.wires[w.id] = { count: (result.packets[w.port || 'out'] || []).length };
      changed();
    }
    rs.status = ctrl.signal.aborted ? 'stopped' : Object.values(rs.nodes).some((s) => s.status === 'error') ? 'error' : 'done';
    rs.endedAt = Date.now(); changed();
    return rs;
  })().catch((e) => { rs.status = 'error'; rs.error = e.message; rs.endedAt = Date.now(); changed(); return rs; });

  return {
    rs, promise,
    stop() { ctrl.abort(); for (const s of Object.values(rs.nodes)) if (s.status === 'running' || s.status === 'waiting') { s.status = 'stopped'; s.note = 'Stopped'; } changed(); },
    answer(askId, value) {
      const a = answers.get(askId);
      if (!a) return false;
      answers.delete(askId);
      rs.asks = rs.asks.filter((x) => x.id !== askId);
      a.resolve(value); changed();
      return true;
    },
  };
}

module.exports = { createRun, order, letter };
