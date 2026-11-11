// The "As in GIRAFE" panel: what a plugin node's panel shows once it is in GIRAFE's Promptmixer.
// It follows GIRAFE's own code (frontend/src/PromptMixerView.jsx: the node inspector and
// renderPluginFields; PhoneModel.jsx and viewerLook.js for the 3D viewer) with GIRAFE's styles
// (girafe-panel.css). Same fields in the same order, same words, same 3D viewer. When GIRAFE's panel
// changes, change this file with it.
//
// It works on the kit's own graph: what you set here is what the kit's panel sets (settings, key
// slots), so a run uses it.

const isRef = (v) => !!(v && typeof v === 'object' && v.key && v.mime);
const isModel = (r) => isRef(r) && /^model\//.test(r.mime);
const isPic = (r) => isRef(r) && /^image\//.test(r.mime);
const truncate = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const plural = (n, one, many) => (n === 1 ? one : many).replace('{n}', n);

// ----- the look of a 3D model: GIRAFE's viewerLook.js -----
const LOOKS = ['natural', 'matte', 'clay', 'studio', 'bright'];
const LOOK_NAMES = { natural: 'Natural', matte: 'Matte', clay: 'Clay (shape only)', studio: 'Studio (shiny)', bright: 'Bright' };
const LOOK_SPEC = {
  natural: { attrs: { 'tone-mapping': 'agx', exposure: '1', 'shadow-intensity': '1', 'shadow-softness': '1' }, mat: { rough: 0.62, metal: 0.15 } },
  matte: { attrs: { 'tone-mapping': 'agx', exposure: '1.05', 'shadow-intensity': '1', 'shadow-softness': '1' }, mat: { rough: 0.92, metal: 0, dropMR: true } },
  clay: { attrs: { 'tone-mapping': 'agx', exposure: '1.1', 'shadow-intensity': '1.2', 'shadow-softness': '0.8' }, mat: { rough: 0.95, metal: 0, dropMR: true, clay: true } },
  studio: { attrs: { 'tone-mapping': 'neutral', exposure: '1.05', 'shadow-intensity': '1', 'shadow-softness': '0.5' }, mat: null },
  bright: { attrs: { 'tone-mapping': 'agx', exposure: '1.45', 'shadow-intensity': '0.8', 'shadow-softness': '1' }, mat: { rough: 0.62, metal: 0.15 } },
};
const LOOK_KEY = 'girafe.3d.look';
const getLook = () => { try { const v = localStorage.getItem(LOOK_KEY); return LOOKS.includes(v) ? v : 'natural'; } catch { return 'natural'; } };
function applyLookMaterials(viewer, look) {
  const spec = (LOOK_SPEC[look] || LOOK_SPEC.natural).mat;
  const mats = viewer && viewer.model && Array.isArray(viewer.model.materials) ? viewer.model.materials : [];
  if (!viewer.__girafeOrig) viewer.__girafeOrig = new Map();
  for (const m of mats) {
    const pbr = m && m.pbrMetallicRoughness;
    if (!pbr) continue;
    try {
      if (!viewer.__girafeOrig.has(m)) {
        viewer.__girafeOrig.set(m, { rough: pbr.roughnessFactor, metal: pbr.metallicFactor, color: [...(pbr.baseColorFactor || [1, 1, 1, 1])],
          mrTex: pbr.metallicRoughnessTexture && pbr.metallicRoughnessTexture.texture, colorTex: pbr.baseColorTexture && pbr.baseColorTexture.texture });
      }
      const o = viewer.__girafeOrig.get(m);
      pbr.setRoughnessFactor(spec ? Math.max(o.rough ?? 1, spec.rough) : o.rough ?? 1);
      pbr.setMetallicFactor(spec ? Math.min(o.metal ?? 0, spec.metal) : o.metal ?? 0);
      if (pbr.metallicRoughnessTexture && pbr.metallicRoughnessTexture.setTexture) pbr.metallicRoughnessTexture.setTexture(spec && spec.dropMR ? null : o.mrTex || null);
      if (pbr.baseColorTexture && pbr.baseColorTexture.setTexture) pbr.baseColorTexture.setTexture(spec && spec.clay ? null : o.colorTex || null);
      pbr.setBaseColorFactor(spec && spec.clay ? [0.82, 0.78, 0.73, 1] : o.color);
    } catch { /* this material can't be changed */ }
  }
}
function setLook(viewer, look) {
  for (const [k, v] of Object.entries((LOOK_SPEC[look] || LOOK_SPEC.natural).attrs)) viewer.setAttribute(k, v);
  if (viewer.loaded) applyLookMaterials(viewer, look);
}
// The same viewer GIRAFE uses (model-viewer 4.4.0, Apache 2.0), kept in the kit: nothing from the internet.
let viewerLoading = null;
const loadViewer = () => (viewerLoading ||= import('./vendor/model-viewer-4.4.0.min.js'));

export function createGirafePanel({ el, S, api, kindOf, nodeRun, packOf, changed, rerender, runGraph, deleteSelected, openKeys, flash }) {
  // Which kept run shows its models in the one live 3D viewer (GIRAFE keeps a single live viewer).
  const live = new Map(); // node id -> run time

  const field = (label, ...kids) => el('label', { class: 'pm-field' }, el('span', {}, ...(Array.isArray(label) ? label : [label])), ...kids);
  const help = (text, cls = '') => el('p', { class: 'pm-help ' + cls, text });

  function keySelect(value, onSet) {
    const sel = el('select', {}, el('option', { value: '', text: '(no key selected)' }),
      ...S.keys.map((x) => el('option', { value: x.id, text: `${x.label}${x.service ? ` — ${x.service}` : ''}` })));
    sel.value = value || '';
    sel.addEventListener('change', () => onSet(sel.value));
    return sel;
  }

  // A "file" field, as GIRAFE's PluginFileField draws it.
  function fileField(f, value, set) {
    const list = (Array.isArray(value) ? value : value ? [value] : []).filter(isRef);
    const err = el('p', { class: 'pm-help pm-error-text', hidden: true });
    const pick = el('input', { type: 'file', accept: f.accept || '', multiple: !!f.multiple, hidden: true });
    const btn = el('span', { class: 'pm-btn pm-btn-small', text: f.multiple ? '＋ Add files' : list.length ? 'Replace the file' : '＋ Choose a file' });
    pick.addEventListener('change', async () => {
      let next = f.multiple ? [...list] : [];
      for (const file of [...pick.files].slice(0, f.multiple ? 20 : 1)) {
        btn.textContent = `Sending ${file.name}…`;
        try {
          const r = await fetch('/api/files?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
          const d = await r.json(); if (!r.ok) throw new Error(d.error);
          next = [...next.filter((x) => x.key !== d.ref.key), { ...d.ref, name: file.name }];
        } catch (e) { err.textContent = '⚠️ ' + e.message; err.hidden = false; break; }
      }
      set(f.multiple ? next : (next[0] || null)); rerender();
    });
    return el('div', { class: 'pm-field' }, el('span', { text: f.label || f.key }),
      list.length ? el('ul', { class: 'pm-plugin-files' }, ...list.map((x) => el('li', {},
        isPic(x) ? el('img', { src: x.imageUrl, alt: '' }) : el('span', { class: 'pm-plugin-file-icon', text: '🧊' }),
        el('span', { class: 'pm-plugin-file-name', text: x.name || x.key }),
        el('button', { type: 'button', class: 'pm-link-btn', title: 'Remove', text: '✕', onclick: () => { const next = list.filter((y) => y.key !== x.key); set(f.multiple ? next : (next[0] || null)); rerender(); } })))) : null,
      el('label', { class: 'pm-plugin-file-add' }, pick, btn), err);
  }

  // GIRAFE's renderPluginFields.
  function pluginFields(n, k) {
    const out = [];
    const c = k.capabilities || {};
    const pk = k.pack && packOf(k.pack);
    out.push(el('p', { class: 'pm-help' }, `🧩 ${k.description || ''} `, el('span', { class: 'pm-cached-label', text: `· ${pk ? `pack ${pk.name} · ` : ''}plugin ${k.version || ''}` })));
    if (pk) {
      for (const slot of pk.keys || []) {
        out.push(field([slot.label || slot.slot, ' ', el('small', { class: 'pm-palette-pack', text: `for the whole pack ${pk.name}` })],
          keySelect(pk.keySlots?.[slot.slot], async (v) => {
            try { pk.keySlots = (await api(`/api/packs/${pk.id}/keys`, { method: 'POST', body: JSON.stringify({ slot: slot.slot, keyId: v || null }) })).keySlots; } catch (e) { flash(e.message); }
            rerender();
          }),
          help('One key for every node of the pack. GIRAFE adds it to the call; the nodes never see it.')));
      }
    } else {
      for (const slot of c.keys || []) {
        out.push(field(slot.label || slot.slot,
          keySelect(n.keySlots?.[slot.slot], (v) => { n.keySlots = { ...(n.keySlots || {}), [slot.slot]: v }; changed({ undoable: false, panel: false }); }),
          S.keys.length ? help(`Pick your ${slot.service} key from your Key bank. GIRAFE adds it to the call; the plugin never sees it.`)
            : el('p', { class: 'pm-help' }, 'No keys saved yet - add one in My account → Key bank. ', el('button', { type: 'button', class: 'pm-link-btn', text: '(in the kit: 🔑 Keys)', onclick: () => openKeys() }))));
      }
    }
    const settings = n.settings || {};
    const set = (key, v) => { n.settings = { ...(n.settings || {}), [key]: v }; changed({ undoable: false, panel: false }); };
    for (const f of k.fields || []) {
      const v = settings[f.key] ?? f.default ?? '';
      if (f.type === 'file') { out.push(fileField(f, settings[f.key], (x) => set(f.key, x))); continue; }
      if (f.type === 'checkbox') {
        const box = el('input', { type: 'checkbox' }); box.checked = !!v;
        box.addEventListener('change', () => set(f.key, box.checked));
        out.push(el('label', { class: 'pm-field pm-field-check' }, box, ' ', el('span', { text: f.label || f.key })));
        continue;
      }
      let input;
      if (f.type === 'textarea') input = el('textarea', { rows: 4, placeholder: f.placeholder || '' });
      else if (f.type === 'select') input = el('select', {}, ...(f.options || []).map((o) => { const [val, lab] = Array.isArray(o) ? o : [o, o]; return el('option', { value: val, text: lab }); }));
      else input = el('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.placeholder || '' });
      input.value = v;
      input.addEventListener(f.type === 'select' ? 'change' : 'input', () => set(f.key, f.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value));
      out.push(field(f.label || f.key, input));
    }
    const may = [];
    for (const key of c.keys || []) may.push(`use the ${key.service} key you choose below (it never sees the key)`);
    if (c.network?.length) may.push(`connect to ${c.network.join(', ')}`);
    if (c.files === 'readwrite') may.push('read the pictures it gets and make new ones');
    else if (c.files === 'read') may.push('read the pictures it gets');
    if (c.state) may.push('remember a little between runs (what it is waiting for)');
    if (k.limits?.seconds > 60) may.push(`run for up to ${Math.round(k.limits.seconds / 60)} min`);
    out.push(help(`It may: ${may.length ? may.join(' · ') : 'nothing beyond computing'}`));
    return out;
  }

  // GIRAFE's "On the phone" block. A plugin node has nothing to fill in on the phone; its result can be shown.
  function phoneFields(n) {
    const box = el('input', { type: 'checkbox' }); box.checked = !!n.phoneResult;
    box.addEventListener('change', () => { n.phoneResult = box.checked ? { label: '' } : undefined; changed({ undoable: false, panel: false }); rerender(); });
    const kids = [
      el('span', {}, '📱 On the phone', el('small', { class: 'pm-hint', text: ' - switch on 📱 Phone in the top bar to put this graph there' })),
      el('small', { class: 'pm-hint', text: 'Nothing to fill in here on the phone.' }),
      el('label', { class: 'pm-field-checkbox' }, box, el('span', { text: 'Show its result on the phone' })),
    ];
    if (n.phoneResult) {
      const name = el('input', { type: 'text', class: 'pm-phone-label', placeholder: 'Name on the phone (default: the node title)' });
      name.value = n.phoneResult.label || '';
      name.addEventListener('input', () => { n.phoneResult = { ...n.phoneResult, label: name.value.slice(0, 80) }; changed({ undoable: false, panel: false }); });
      kids.push(name);
    }
    return el('div', { class: 'pm-field pm-phone-fields' }, ...kids);
  }

  // The status and the output box. GIRAFE never draws a run's pictures here: it says how many.
  function runInfo(st) {
    const outs = st.outputs || [];
    const lastOut = outs.length ? outs[outs.length - 1] : undefined;
    const parts = [el('div', { text: `Status: ${st.status}` })];
    if (lastOut !== undefined) {
      const refs = (Array.isArray(lastOut) ? lastOut : [lastOut]).filter(isRef);
      const allRefs = refs.length && refs.length === (Array.isArray(lastOut) ? lastOut.length : 1);
      if (allRefs) parts.push(el('div', { class: 'pm-output-box', text: `📷 ${plural(refs.length, '{n} image in this output', '{n} images in this output')}` }));
      else parts.push(el('div', { class: 'pm-output-box', text: truncate(typeof lastOut === 'string' ? lastOut : JSON.stringify(lastOut, null, 2), 2000) }));
    }
    return el('div', { class: 'pm-run-info' }, ...parts);
  }

  // ----- the 3D viewer (GIRAFE's PhoneModelInline) -----
  function modelViewer(models) {
    let cur = 0;
    const on = new Set(models.map((_, i) => i));
    let clips = [];
    const stage = el('div', { class: 'phone-model-stage', style: { height: '320px' } });
    const wait = el('div', { class: 'phone-model-wait', text: '⏳ Loading the 3D model…' });
    const badge = el('span', { class: 'phone-model-badge', hidden: true });
    const tags = el('div', { class: 'phone-model-tags' });
    const lookSel = el('select', { 'aria-label': 'Look' }, ...LOOKS.map((x) => el('option', { value: x, text: LOOK_NAMES[x] })));
    lookSel.value = getLook();
    let viewer = null;
    const labelOf = (m, i) => m.animation?.name || m.name || `Model ${i + 1}`;
    function drawTags() {
      const rows = [];
      if (models.length > 1) rows.push(el('div', { class: 'phone-model-chips', role: 'group', 'aria-label': 'Moves to play' },
        ...models.map((m, i) => el('button', { type: 'button', class: `${on.has(i) ? 'on' : ''}${i === cur ? ' now' : ''}`, text: `${i === cur ? '▶ ' : on.has(i) ? '✓ ' : ''}${labelOf(m, i)}`,
          onclick: () => { if (i === cur) return; on.add(i); show(i); } }))));
      if (clips.length > 1) rows.push(el('div', { class: 'phone-model-chips', role: 'group', 'aria-label': 'Moves in this file' },
        ...clips.map((c) => el('button', { type: 'button', class: viewer && viewer.animationName === c ? 'on now' : 'on', text: c,
          onclick: () => { viewer.animationName = c; viewer.currentTime = 0; viewer.play && viewer.play(); badge.textContent = '▶ ' + c; drawTags(); } }))));
      tags.replaceChildren(...rows);
    }
    function show(i) {
      cur = i; clips = [];
      const m = models[i];
      wait.textContent = '⏳ Loading the 3D model…'; wait.hidden = false;
      const v = document.createElement('model-viewer');
      v.setAttribute('src', m.imageUrl);
      if (isRef(m.preview)) v.setAttribute('poster', m.preview.imageUrl);
      v.setAttribute('alt', labelOf(m, i));
      for (const a of ['camera-controls', 'autoplay', 'auto-rotate']) v.setAttribute(a, '');
      v.setAttribute('auto-rotate-delay', '2500'); v.setAttribute('rotation-per-second', '18deg');
      v.setAttribute('interaction-prompt', 'none'); v.setAttribute('touch-action', 'none');
      setLook(v, lookSel.value);
      v.addEventListener('load', () => {
        wait.hidden = true;
        applyLookMaterials(v, lookSel.value);
        clips = Array.isArray(v.availableAnimations) ? v.availableAnimations : [];
        if (clips.length && v.play) v.play();
        badge.hidden = !(clips.length || m.animation); badge.textContent = '▶ ' + (v.animationName || clips[0] || labelOf(m, i));
        drawTags();
      });
      // Several models (one per move): each plays one loop, then the next one switched on.
      v.addEventListener('loop', () => { const order = [...on].sort((a, b) => a - b); if (order.length > 1) show(order[(order.indexOf(cur) + 1) % order.length]); });
      v.addEventListener('error', () => { wait.textContent = '⚠️ This model could not be loaded.'; wait.hidden = false; });
      viewer = v;
      stage.replaceChildren(v, wait);
      drawTags();
    }
    lookSel.addEventListener('change', () => { try { localStorage.setItem(LOOK_KEY, lookSel.value); } catch { /* not kept */ } if (viewer) setLook(viewer, lookSel.value); });
    stage.append(wait);
    loadViewer().then(() => show(0), (e) => { wait.textContent = '⚠️ The 3D viewer could not be loaded: ' + e.message; });
    return el('div', { class: 'phone-model' },
      el('div', { class: 'phone-model-box' }, stage, badge), tags,
      el('label', { class: 'look-picker' }, el('span', { text: 'Look' }), lookSel));
  }
  function modelCard(models, onRecall) {
    const first = models[0];
    const img = isRef(first.preview) ? first.preview.imageUrl : null;
    const moving = models.filter((m) => m.animation).length;
    return el('div', { class: 'phone-model-card' },
      el('button', { type: 'button', class: 'phone-model-card-pic', onclick: onRecall }, img ? el('img', { src: img, alt: '' }) : '🧊'),
      el('div', { class: 'phone-model-card-body' }, el('b', { text: first.name || '3D model' }),
        el('small', { text: models.length > 1 ? `${models.length} moves` : moving ? 'Animated' : 'Still model' }),
        el('div', { class: 'phone-model-card-acts' }, el('button', { type: 'button', text: '⟲ Show it in 3D', onclick: onRecall }))));
  }

  // What one kept run holds, drawn like a result in GIRAFE.
  function resultOf(n, rec, isLive) {
    const flat = rec.values.flatMap((v) => (Array.isArray(v) ? v : [v]));
    const models = flat.filter(isModel), pics = flat.filter(isPic), texts = flat.filter((v) => !isRef(v));
    const kids = [];
    if (models.length) kids.push(isLive ? modelViewer(models) : modelCard(models, () => { live.set(n.id, rec.at); rerender(); }));
    if (pics.length) kids.push(el('div', { class: 'phone-res-images' }, ...pics.map((r) => el('a', { class: 'phone-res-pic', href: r.imageUrl, target: '_blank' }, el('img', { src: r.imageUrl, alt: '', loading: 'lazy' })))));
    if (texts.length === 1) kids.push(el('div', { class: 'phone-res-text', text: typeof texts[0] === 'string' ? texts[0] : JSON.stringify(texts[0], null, 2) }));
    else if (texts.length) kids.push(el('ol', { class: 'phone-res-list' }, ...texts.slice(0, 100).map((v) => el('li', { text: typeof v === 'string' ? v : JSON.stringify(v) }))));
    if (!kids.length) kids.push(el('p', { class: 'phone-res-none', text: 'Nothing came out.' }));
    return el('div', { class: 'phone-res' }, el('h4', { text: n.title || kindOf(n).name }), ...kids);
  }
  // A "display: runs" node: the list GIRAFE shows in its panel (and on the phone).
  function runsList(n) {
    const box = el('div', { class: 'phone-results' }, el('p', { class: 'phone-run-hint', text: 'Loading…' }));
    api('/api/node-runs/' + encodeURIComponent(n.id)).then(({ runs }) => {
      if (!runs.length) return box.replaceChildren(el('p', { class: 'phone-run-hint', text: 'Nothing yet - run the graph: its results land here, the latest on top.' }));
      const has3d = (r) => r.values.flatMap((v) => (Array.isArray(v) ? v : [v])).some(isModel);
      const wanted = live.get(n.id);
      const liveAt = (runs.find((r) => r.at === wanted && has3d(r)) || runs.find(has3d) || {}).at;
      box.replaceChildren(...runs.map((r, i) => (i === 0
        ? el('div', { class: 'phone-run-rec latest' },
          el('h3', { class: 'phone-results-title' }, el('span', { class: 'phone-latest-badge', text: 'Latest' }), el('small', { text: new Date(r.at).toLocaleString() })),
          resultOf(n, r, r.at === liveAt))
        : el('div', { class: 'phone-run-rec earlier' },
          el('div', { class: 'phone-run-sep' }, el('span', { text: `Earlier run · ${new Date(r.at).toLocaleString()}` })),
          resultOf(n, r, r.at === liveAt)))));
    }).catch((e) => box.replaceChildren(el('p', { class: 'pm-help pm-error-text', text: '⚠️ ' + e.message })));
    return box;
  }

  // The whole panel, in GIRAFE's order: title, Run from here, the plugin's own fields, On the phone,
  // the last run, Delete.
  return function girafePanel(n) {
    const k = kindOf(n);
    const st = nodeRun(n.id);
    const title = el('input', { type: 'text' }); title.value = n.title || '';
    title.addEventListener('input', () => { n.title = title.value; changed({ undoable: false, panel: false }); });
    const running = S.run?.status === 'running';
    const kids = [
      el('h3', { text: `${k.name} node` }),
      field('Title', title),
      el('button', { type: 'button', class: 'pm-btn', disabled: running, title: 'Run this node and everything after it. Nodes feeding it are not executed - their saved results from the last run are used.', text: '▶ Run from here (saved upstream)', onclick: () => runGraph() }),
      el('p', { class: 'kit-note', text: 'In the kit this button runs the whole graph. In GIRAFE it reuses the saved results of the nodes before this one.' }),
      ...(k.missing ? [help('⚠️ This plugin node is not installed in your account. Send it from the GIRAFE node kit, or remove this node.')] : pluginFields(n, k)),
    ];
    if (!k.missing && k.display === 'runs') {
      kids.push(help('Each real run puts what reaches it on top of this list - the same list the phone shows, earlier runs and kept pictures included.'), runsList(n));
    }
    kids.push(phoneFields(n));
    if (st && st.status && st.status !== 'idle') kids.push(runInfo(st));
    kids.push(el('div', { class: 'pm-inspector-actions' }, el('button', { type: 'button', class: 'pm-btn pm-btn-danger', text: '🗑 Delete node', onclick: deleteSelected })));
    return el('div', { class: 'gf' }, ...kids);
  };
}
