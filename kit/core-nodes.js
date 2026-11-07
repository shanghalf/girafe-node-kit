// The core GIRAFE nodes the kit simulates. They behave like the real ones, without AI or APIs.
// Their settings are plain fields on the node object (n.value, n.prompt...), as in GIRAFE.
const isRef = (v) => !!(v && typeof v === 'object' && v.key && v.mime);

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (isRef(v)) return [v];
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s[0] === '[') {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch {}
  }
  return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

const asWire = (v) => (typeof v === 'string' || isRef(v) ? v : JSON.stringify(v));

const KINDS = {
  input: {
    label: 'Input', color: '#5fa8e8', icon: '✏️',
    help: 'A value you type. It starts the graph.',
    needsInput: false, inputs: false, outputs: ['out'],
    fields: [{ key: 'value', type: 'textarea', label: 'Value', placeholder: 'Text, a number, or a JSON list like ["a","b"]' }],
    async run({ n, emit }) { emit('out', String(n.value ?? '')); },
  },

  image: {
    label: 'Image', color: '#e86fa8', icon: '🖼',
    help: 'A picture you add. It is sent on as a file reference, like GIRAFE\'s Image node.',
    needsInput: false, inputs: false, outputs: ['out'],
    fields: [{ key: 'image', type: 'image', label: 'Picture' }],
    async run({ n, emit }) {
      if (!isRef(n.image)) throw new Error('Add a picture in the panel first.');
      emit('out', n.image);
    },
  },

  forEach: {
    label: 'For each', color: '#4fc1a6', icon: '🔁',
    help: 'Takes a list (JSON list, or one item per line) and sends each item on, one by one. Everything after it runs once per item.',
    needsInput: true, inputs: true, outputs: ['out'], streams: true,
    fields: [{ key: 'max', type: 'number', label: 'At most (items)', placeholder: '100' }],
    async run({ n, ins, emit, st }) {
      const items = parseList(ins.A);
      const max = Math.max(1, Math.min(1000, Number(n.max) || 100));
      for (const it of items.slice(0, max)) emit('out', asWire(it));
      st.note = `${Math.min(items.length, max)} items` + (items.length > max ? ` (of ${items.length})` : '');
    },
  },

  ask: {
    label: 'Yes / No', color: '#e8c33d', icon: '✋',
    help: 'Stops and asks you a question. What comes in goes out of "yes" or "no", whichever you answer; the other branch is skipped.',
    needsInput: false, inputs: true, outputs: ['yes', 'no'],
    fields: [
      { key: 'prompt', type: 'textarea', label: 'Question', placeholder: 'Is this right? {{A}}' },
      { key: 'yesLabel', type: 'text', label: '"Yes" button', placeholder: 'Yes' },
      { key: 'noLabel', type: 'text', label: '"No" button', placeholder: 'No' },
    ],
    async run({ n, ins, emit, ask, st }) {
      const fill = (s) => String(s || '').replace(/\{\{([A-Z]+)\}\}/g, (_, k) => {
        const v = ins[k]; return v === undefined ? '' : typeof v === 'string' ? v : isRef(v) ? (v.name || 'picture') : JSON.stringify(v);
      });
      const text = fill(n.prompt) || 'Go on?';
      st.status = 'waiting';
      const answer = await ask({ nodeId: n.id, title: n.title || 'Yes / No', text, yesLabel: n.yesLabel || 'Yes', noLabel: n.noLabel || 'No', preview: ins.A ?? null });
      st.status = 'running';
      const out = ins.A !== undefined ? ins.A : answer;
      emit(answer === 'yes' ? 'yes' : 'no', out);
      st.note = `answered ${answer}`;
    },
  },

  collect: {
    label: 'Collect', color: '#9aa6b8', icon: '🧺',
    help: 'Waits until everything has arrived, then sends one list. Pictures show as a grid.',
    needsInput: true, inputs: true, outputs: ['out'], collects: true,
    fields: [],
    async run({ ports, emit, st }) {
      const all = ports.flatMap((p) => p.values);
      const items = all.flatMap((v) => (typeof v === 'string' && v.trim().startsWith('[') ? (() => { try { const a = JSON.parse(v); return Array.isArray(a) && a.every(isRef) ? a : [v]; } catch { return [v]; } })() : [v]));
      emit('out', JSON.stringify(items));
      st.note = `${items.length} item${items.length === 1 ? '' : 's'}`;
    },
  },
};

// What the browser needs to draw and edit core nodes.
function describe() {
  return Object.entries(KINDS).map(([type, k]) => ({
    type, name: k.label, color: k.color, icon: k.icon, description: k.help, core: true,
    inputs: k.inputs ? { min: k.needsInput ? 1 : 0, max: 8 } : { min: 0, max: 0 },
    outputs: k.outputs, fields: k.fields,
  }));
}

module.exports = { KINDS, describe, parseList, isRef };
