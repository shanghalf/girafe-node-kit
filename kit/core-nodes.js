// The core GIRAFE nodes the kit simulates. They behave like the real ones, without AI or APIs.
// Their settings are plain fields on the node object (n.value, n.prompt...), as in GIRAFE.
const fs = require('fs');
const store = require('./store');
const textAI = require('./ai/text');
const gemini = require('./ai/gemini-image');
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

// Pictures in an input: a file reference, or a JSON list of them (what Collect sends).
function picturesIn(v) {
  if (isRef(v)) return [v];
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { const a = JSON.parse(v); if (Array.isArray(a) && a.length && a.every(isRef)) return a; } catch {} }
  if (Array.isArray(v) && v.length && v.every(isRef)) return v;
  return [];
}
const readPicture = (ref) => {
  const p = store.filePath(ref.key);
  if (!p || !fs.existsSync(p)) throw new Error(`A picture on the input is missing from the kit (${ref.name || ref.key}).`);
  return { mime: ref.mime, data: fs.readFileSync(p).toString('base64'), key: ref.key };
};
const asText = (v) => { const pics = picturesIn(v); if (pics.length) return pics.length === 1 ? '[the attached picture]' : `[${pics.length} attached pictures]`; return typeof v === 'string' ? v : JSON.stringify(v); };

// Same rules as GIRAFE's Prompt node: {{A}}, {{B}}... put an input where you want it;
// without placeholders, the inputs are added after the instructions.
function buildPromptText(prompt, ins) {
  const letters = Object.keys(ins).sort();
  let text = String(prompt || '').trim();
  if (/\{\{([A-Z]+|input)\}\}/.test(text)) {
    text = text.replace(/\{\{([A-Z]+|input)\}\}/g, (m, k) => (k === 'input' ? letters.map((l) => asText(ins[l])).join('\n') : ins[k] !== undefined ? asText(ins[k]) : m));
  } else if (letters.length === 1) text += `\n\nInput:\n${asText(ins[letters[0]])}`;
  else if (letters.length > 1) text += '\n\n' + letters.map((l) => `${l}: ${asText(ins[l])}`).join('\n');
  return text.trim();
}
const today = () => new Date().toISOString().slice(0, 10);
const systemPrompt = () => `Today's date is ${today()} (ISO 8601, YYYY-MM-DD). When reasoning about whether a date is overdue, upcoming, or in the past, compare it against this real current date - never against your own training cutoff, which is not "today".`;

const asWire = (v) => (typeof v === 'string' || isRef(v) ? v : JSON.stringify(v));

const AI_SERVICES = ['anthropic', 'openai', 'gemini'];

const KINDS = {
  input: {
    label: 'Input', color: '#5fa8e8',
    help: 'A value you type. It starts the graph.',
    needsInput: false, inputs: false, outputs: ['out'],
    fields: [{ key: 'value', type: 'textarea', label: 'Value', placeholder: 'Text, a number, or a JSON list like ["a","b"]' }],
    async run({ n, emit }) { emit('out', String(n.value ?? '')); },
  },

  image: {
    label: 'Image', color: '#7b8cf0',
    help: 'A picture you add. It is sent on as a file reference, like GIRAFE\'s Image node.',
    needsInput: false, inputs: false, outputs: ['out'],
    fields: [{ key: 'image', type: 'image', label: 'Picture' }],
    async run({ n, emit }) {
      if (!isRef(n.image)) throw new Error('Add a picture in the panel first.');
      emit('out', n.image);
    },
  },

  forEach: {
    label: 'For each', color: '#6fc3e8',
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
    label: 'Yes / No', color: '#f5d76e',
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

  prompt: {
    label: 'Prompt', color: '#e8a33d',
    help: 'Asks an AI (Anthropic, OpenAI or Gemini, with a key from your key bank). Pictures on its inputs are shown to the model. The same request twice gives the saved answer, with no new call.',
    needsInput: false, inputs: true, outputs: ['out'], usesKeys: AI_SERVICES,
    fields: [
      { key: 'keyId', type: 'key', label: 'API key', services: AI_SERVICES },
      { key: 'model', type: 'model', label: 'Model', kind: 'text', placeholder: 'the service\'s default' },
      { key: 'prompt', type: 'textarea', label: 'Instructions', placeholder: 'What should the AI do? Use {{A}}, {{B}} to place the inputs; otherwise they are added after.' },
      { key: 'fresh', type: 'checkbox', label: 'Always ask again (ignore the saved answer)' },
    ],
    async run({ n, ins, emit, st, signal, index }) {
      const key = require('./keys').use(n.keyId, AI_SERVICES);
      const text = buildPromptText(n.prompt, ins);
      if (!text) throw new Error('Write the instructions first.');
      const pics = Object.values(ins).flatMap(picturesIn).slice(0, 20).map(readPicture);
      const model = (n.model || '').trim() || textAI.DEFAULT_MODEL[key.service];
      const cache = require('./cache');
      const ck = cache.hash('prompt', key.service, model, systemPrompt().slice(0, 30), text, pics.map((p) => p.key));
      const hit = !n.fresh && cache.get(ck);
      if (hit) { emit('out', hit.text); st.note = `♻️ same request as before - saved answer, no new call (${model})`; return; }
      st.note = `asking ${model}${pics.length ? ` with ${pics.length} picture${pics.length === 1 ? '' : 's'}` : ''}…`;
      const r = await textAI.ask({ service: key.service, key: key.value, keyLabel: key.label, model, system: systemPrompt(), text, images: pics.map(({ mime, data }) => ({ mime, data })), signal });
      if (!r.text.trim()) throw new Error(`${model} returned an empty answer.`);
      cache.put(ck, { text: r.text });
      emit('out', r.text);
      st.note = `✓ ${model}${pics.length ? ` · 📷 ${pics.length} picture${pics.length === 1 ? '' : 's'} sent` : ''}${r.truncated ? ' · ⚠️ cut off by the model\'s length limit' : ''}`;
    },
  },

  img: {
    label: 'Generate image', color: '#e86fa8',
    help: 'Makes a picture with Google Gemini (a Gemini key from your key bank). Text on its inputs is added to the description; pictures on its inputs are used as references (image to image). The same request twice gives the saved picture, with no new call.',
    needsInput: false, inputs: true, outputs: ['out'], usesKeys: ['gemini'],
    fields: [
      { key: 'keyId', type: 'key', label: 'Gemini API key', services: ['gemini'] },
      { key: 'prompt', type: 'textarea', label: 'Describe the picture', placeholder: 'A watercolor giraffe reading a map at sunset' },
      { key: 'aspectRatio', type: 'select', label: 'Format', options: [['', 'Model default'], ...Object.entries(gemini.ASPECT_RATIOS)] },
      { key: 'imageSize', type: 'select', label: 'Picture size', options: [['1K', '1K (default)'], ['2K', '2K'], ['4K', '4K']] },
      { key: 'model', type: 'select', label: 'Model', options: [['', 'Automatic (Nano Banana 2.1)'], ...gemini.IMAGE_MODELS.map((m) => [m.id, m.label])] },
      { key: 'fresh', type: 'checkbox', label: 'Always make a new picture (ignore the saved one)' },
    ],
    async run({ n, ins, emit, st, signal }) {
      const key = require('./keys').use(n.keyId, 'gemini');
      const texts = [], refs = [];
      for (const l of Object.keys(ins).sort()) { const p = picturesIn(ins[l]); if (p.length) refs.push(...p); else if (String(asText(ins[l])).trim()) texts.push(asText(ins[l])); }
      let prompt = [String(n.prompt || '').trim(), ...texts].filter(Boolean).join('\n\n');
      if (!prompt && refs.length) prompt = 'Make a new picture based on the attached picture(s).';
      if (!prompt) throw new Error('Describe the picture, or wire in some text.');
      const images = refs.slice(0, gemini.MAX_REFS).map(readPicture);
      const model = n.model || (images.length ? gemini.REF_MODEL : gemini.TEXT_MODEL);
      const cache = require('./cache');
      const ck = cache.hash('img', model, n.aspectRatio || '', n.imageSize || '1K', prompt, images.map((i) => i.key));
      const hit = !n.fresh && cache.get(ck);
      if (hit && store.filePath(hit.file) && fs.existsSync(store.filePath(hit.file))) {
        emit('out', { imageUrl: '/files/' + hit.file, key: hit.file, mime: hit.mime, name: hit.name });
        st.note = '♻️ same request as before - saved picture, no new call'; return;
      }
      st.note = `generating with ${model}${images.length ? ` from ${images.length} reference picture${images.length === 1 ? '' : 's'}` : ''}…`;
      const r = await gemini.generateImage(key.value, { prompt, aspectRatio: n.aspectRatio, imageSize: n.imageSize, model: n.model || undefined, images, signal, keyLabel: key.label });
      const f = store.saveFile(Buffer.from(r.base64, 'base64'), r.mime);
      const ref = { imageUrl: '/files/' + f.key, key: f.key, mime: f.mime, name: (n.title || 'image') + '.' + f.key.split('.').pop() };
      cache.put(ck, { file: f.key, mime: f.mime, name: ref.name });
      emit('out', ref);
      st.note = `✓ ${images.length ? 'image to image' : 'text to image'} · ${r.model}${r.fellBack ? ` (fell back: ${model} is not open to this key)` : ''}${refs.length > gemini.MAX_REFS ? ` · only the first ${gemini.MAX_REFS} pictures were used` : ''}`;
    },
  },

  collect: {
    label: 'Collect', color: '#c0b24a',
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
    type, name: k.label, color: k.color, description: k.help, core: true,
    inputs: k.inputs ? { min: k.needsInput ? 1 : 0, max: 8 } : { min: 0, max: 0 },
    outputs: k.outputs, fields: k.fields,
  }));
}

module.exports = { KINDS, describe, parseList, isRef, buildPromptText, picturesIn };
