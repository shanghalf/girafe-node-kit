// A "tasks" field (host API 2): pick past tasks of a key service - a drop-down of task types and a
// list of that type's tasks, loaded from the service's history with the node's key, or from the
// history file the service lets you export. Same look and words as GIRAFE's PluginTasksField
// (frontend/src/PluginTasksField.jsx); used by both of the kit's panels.
//
// The field's value, as the node reads it: { ids: [taskId...], type, items: [{ taskId, type, model,
// units, createdAt }], from } - "ids" are the chosen tasks, "items" what was loaded.

const MAX_ITEMS = 1000;
export const humanType = (t) => { const s = String(t || 'task').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
export function typeChoices(f, items) {
  const counts = {};
  for (const x of items) counts[x.type] = (counts[x.type] || 0) + 1;
  const named = Array.isArray(f.types) ? f.types.map((x) => (Array.isArray(x) ? x : [x, humanType(x)])) : null;
  const list = named ? named : Object.keys(counts).sort().map((t) => [t, humanType(t)]);
  return list.map(([value, label]) => ({ value, label, count: counts[value] || 0 }));
}
export function mergeTasks(f, old, fresh) {
  const allowed = Array.isArray(f.types) ? new Set(f.types.map((x) => (Array.isArray(x) ? x[0] : x))) : null;
  const byId = new Map((old || []).map((x) => [x.taskId, x]));
  for (const x of fresh || []) if (!allowed || allowed.has(x.type)) byId.set(x.taskId, { ...byId.get(x.taskId), ...x });
  return [...byId.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, MAX_ITEMS);
}
const when = (iso) => { const d = iso ? new Date(iso) : null; return d && Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?'; };

export function tasksField({ el, api, f, pluginId, service: svc, keyId, value, set, rerender }) {
  const service = String(svc || '').charAt(0).toUpperCase() + String(svc || '').slice(1);
  const v = value && typeof value === 'object' ? value : {};
  const items = Array.isArray(v.items) ? v.items : [];
  const ids = Array.isArray(v.ids) ? v.ids : [];
  const choices = typeChoices(f, items);
  const type = choices.some((c) => c.value === v.type) ? v.type : (choices.find((c) => c.count) || choices[0] || {}).value;
  const save = (patch) => { set({ ...v, items, ids, type, ...patch }); rerender(); };
  const status = el('p', { class: 'pm-help' });
  const err = el('p', { class: 'pm-help pm-error-text', hidden: true });
  const fail = (e) => { err.textContent = '⚠️ ' + e.message; err.hidden = false; };
  const load = async (body, btn, busy) => {
    const was = btn.textContent; btn.textContent = busy; btn.disabled = true; err.hidden = true;
    try {
      const r = await api('/api/service-tasks', { method: 'POST', body: JSON.stringify({ plugin: pluginId, field: f.key, keyId, ...body }) });
      const merged = mergeTasks(f, items, r.tasks);
      const from = r.from && (!v.from || r.from < v.from) ? r.from : v.from;
      save({ items: merged, from, loadedAt: new Date().toISOString(), lastLoad: `${r.tasks.length}` });
    } catch (e) { fail(e); btn.textContent = was; btn.disabled = false; }
  };
  const fromService = el('button', { type: 'button', class: 'pm-btn pm-btn-small', text: `⟳ Load from ${service}`, title: keyId ? `Read your ${service} history with the key chosen above` : `Choose a ${service} key above first` });
  fromService.disabled = !keyId;
  fromService.addEventListener('click', () => load({}, fromService, 'Loading…'));
  const pick = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  const fromFile = el('span', { class: 'pm-btn pm-btn-small', text: '📄 Load the exported file' });
  pick.addEventListener('change', async () => { const file = pick.files[0]; if (file) await load({ csv: await file.text() }, fromFile, 'Reading…'); });
  const earlier = v.from ? el('button', { type: 'button', class: 'pm-link-btn', text: 'Load earlier', onclick: () => load({ before: v.from }, earlier, 'Loading…') }) : null;
  if (earlier) earlier.disabled = !keyId;
  status.append(items.length ? `${items.length} task${items.length === 1 ? '' : 's'} loaded${v.from ? ` · since ${when(v.from)}` : ''}` : `Load your ${service} tasks to pick from them.`, ...(earlier ? [' · ', earlier] : []));

  const kids = [el('span', { text: f.label || f.key }),
    el('div', { class: 'pm-tasks-load' }, fromService, el('label', { class: 'pm-plugin-file-add' }, pick, fromFile)), status, err];
  if (items.length) {
    const sel = el('select', { class: 'pm-tasks-type' }, ...choices.map((c) => el('option', { value: c.value, text: `${c.label} (${c.count})` })));
    sel.value = type || '';
    sel.addEventListener('change', () => save({ type: sel.value }));
    const rows = items.filter((x) => x.type === type);
    const list = el('div', { class: 'pm-tasks-list', role: 'listbox', 'aria-multiselectable': f.multiple ? 'true' : 'false' },
      ...(rows.length ? rows.map((x) => {
        const on = ids.includes(x.taskId);
        const box = el('input', { type: f.multiple ? 'checkbox' : 'radio', name: `pm-tasks-${pluginId}-${f.key}` }); box.checked = on;
        box.addEventListener('change', () => save({ ids: f.multiple ? (box.checked ? [...ids, x.taskId] : ids.filter((i) => i !== x.taskId)) : [x.taskId] }));
        return el('label', { class: `pm-tasks-row${on ? ' on' : ''}`, title: x.taskId }, box,
          el('span', { class: 'pm-tasks-when', text: when(x.createdAt) }),
          el('span', { class: 'pm-tasks-model', text: x.model || '' }),
          el('span', { class: 'pm-tasks-units', text: x.units != null ? String(x.units) : '' }),
          el('code', { class: 'pm-tasks-id', text: x.taskId.slice(0, 8) }));
      }) : [el('p', { class: 'pm-help', text: 'No task of this type in what was loaded.' })]));
    kids.push(sel, list);
    if (ids.length) kids.push(el('p', { class: 'pm-help' }, `${ids.length} chosen · `, el('button', { type: 'button', class: 'pm-link-btn', text: 'clear', onclick: () => save({ ids: [] }) })));
  }
  return el('div', { class: 'pm-field pm-tasks' }, ...kids);
}
