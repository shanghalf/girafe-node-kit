// One text call to Anthropic, OpenAI or Gemini, with pictures when the input has some.
// Plain fetch, no SDK. The base addresses can be pointed at a fake server for tests
// (KIT_ANTHROPIC_URL, KIT_OPENAI_URL, KIT_GEMINI_URL).
const netguard = require('../netguard');
const DEFAULT_MODEL = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash' };
const TIMEOUT_MS = 180_000;
const MAX_TOKENS = 8192;
const url = {
  anthropic: () => process.env.KIT_ANTHROPIC_URL || 'https://api.anthropic.com/v1',
  openai: () => process.env.KIT_OPENAI_URL || 'https://api.openai.com/v1',
  gemini: () => process.env.KIT_GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
};

async function call(href, init, signal, who, guard) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal && signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await netguard.send(href, { ...init, signal: ctrl.signal }, guard);
    const raw = await res.text();
    let body = null; try { body = JSON.parse(raw); } catch {}
    if (!res.ok) {
      const msg = body?.error?.message || body?.error?.type || raw.slice(0, 300) || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new Error(`${who} rejected the API key: ${msg}`);
      if (res.status === 404) throw new Error(`${who}: ${msg} (HTTP 404 - is the model name right? "List models" shows the ones your key can use)`);
      if (res.status === 429) throw new Error(`${who} rate limit or quota: ${msg}`);
      throw new Error(`${who} failed (HTTP ${res.status}): ${msg}`);
    }
    return body;
  } catch (e) {
    if (signal && signal.aborted) throw new Error('Stopped');
    if (ctrl.signal.aborted) throw new Error(`${who} took longer than ${TIMEOUT_MS / 1000} s`);
    if (e instanceof netguard.Blocked || e.message.includes(who)) throw e;
    throw new Error(`Could not reach ${who}: ${e.message}`);
  } finally {
    clearTimeout(timer); signal && signal.removeEventListener('abort', onAbort);
  }
}

// ask({ service, key, model, system, text, images: [{ mime, data }], signal }) -> { text, model, truncated }
async function ask({ service, key, keyLabel, model, system, text, images = [], signal }) {
  const guard = { service, key, keyLabel, purpose: 'Prompt node' };
  model = model || DEFAULT_MODEL[service];
  if (service === 'anthropic') {
    const body = await call(`${url.anthropic()}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
        { type: 'text', text },
      ] }] }),
    }, signal, 'Anthropic', guard);
    return { text: (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model, truncated: body.stop_reason === 'max_tokens' };
  }
  if (service === 'openai') {
    const body = await call(`${url.openai()}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_completion_tokens: MAX_TOKENS, messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))] },
      ] }),
    }, signal, 'OpenAI', guard);
    const ch = body.choices?.[0];
    return { text: ch?.message?.content || '', model, truncated: ch?.finish_reason === 'length' };
  }
  if (service === 'gemini') {
    const body = await call(`${url.gemini()}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }))] }],
        generationConfig: { maxOutputTokens: MAX_TOKENS },
      }),
    }, signal, 'Gemini', guard);
    const cand = body.candidates?.[0];
    const out = (cand?.content?.parts || []).map((p) => p.text || '').join('');
    if (!out && cand?.finishReason === 'SAFETY') throw new Error('Gemini declined to answer (safety filters)');
    return { text: out, model, truncated: cand?.finishReason === 'MAX_TOKENS' };
  }
  throw new Error(`The Prompt node can't use a "${service}" key; choose an Anthropic, OpenAI or Gemini key.`);
}

// The models this key can use, newest first where the service says. kind: 'text' | 'image'.
async function listModels({ service, key, keyLabel, kind = 'text' }) {
  const guard = { service, key, keyLabel, purpose: 'List models' };
  if (service === 'anthropic') {
    const b = await call(`${url.anthropic()}/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, null, 'Anthropic', guard);
    return (b.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
  }
  if (service === 'openai') {
    const b = await call(`${url.openai()}/models`, { headers: { authorization: `Bearer ${key}` } }, null, 'OpenAI', guard);
    return (b.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|tts|transcribe|search|image/.test(id)).sort().reverse().map((id) => ({ id, label: id }));
  }
  if (service === 'gemini') {
    const b = await call(`${url.gemini()}?pageSize=200`, { headers: { 'x-goog-api-key': key } }, null, 'Gemini', guard);
    return (b.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
      .filter((m) => (kind === 'image' ? /image/.test(m.id) : !/image|tts|embedding|aqa/.test(m.id)));
  }
  return [];
}

module.exports = { ask, listModels, DEFAULT_MODEL };
