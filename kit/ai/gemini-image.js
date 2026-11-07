// Gemini image generation, ported from GIRAFE (server/gemini-image.js): the same models,
// request shape, fallback and error wording. Plain fetch, no SDK.
const netguard = require('../netguard');
const TEXT_MODEL = 'gemini-nano-banana-2.1';
const REF_MODEL = 'gemini-nano-banana-2.1';
const LEGACY_MODEL = 'gemini-2.5-flash-image';
const MAX_REFS = 14;
const IMAGE_SIZES = ['1K', '2K', '4K'];
const ONE_K_ONLY = new Set(['gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image']);
const IMAGE_MODELS = [
  { id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1 - recommended, generation and editing' },
  { id: 'gemini-3-pro-image', label: 'Nano Banana Pro - best quality, most precise' },
  { id: 'gemini-3.1-flash-lite-image', label: 'Nano Banana 2 Lite - fastest, cheapest, 1K only' },
  { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 - previous generation' },
  { id: 'gemini-2.5-flash-image', label: 'Nano Banana (legacy)' },
];
const ASPECT_RATIOS = { '1:1': 'Square (1:1)', '3:4': 'Portrait (3:4)', '4:3': 'Landscape (4:3)', '9:16': 'Tall portrait (9:16)', '16:9': 'Widescreen (16:9)' };
const base = () => process.env.KIT_GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 120_000;
const isUnknownModel = (err) => /\(HTTP 404\)|not found|is not supported|does not exist|unknown model/i.test(String(err && err.message));

function imageConfigFor(model, aspectRatio, imageSize) {
  const cfg = {};
  if (ASPECT_RATIOS[aspectRatio]) cfg.aspectRatio = aspectRatio;
  if (IMAGE_SIZES.includes(imageSize) && imageSize !== '1K' && !ONE_K_ONLY.has(model)) cfg.imageSize = imageSize;
  return Object.keys(cfg).length ? { imageConfig: cfg } : null;
}

// generateImage(key, { prompt, aspectRatio, imageSize, model, images: [{ mime, data }], signal })
//   -> { base64, mime, model, fellBack }
async function generateImage(apiKey, opts = {}) {
  const want = opts.model || (opts.images && opts.images.length ? REF_MODEL : TEXT_MODEL);
  try {
    return { ...(await once(apiKey, { ...opts, model: want })), model: want, fellBack: false };
  } catch (err) {
    if (want === LEGACY_MODEL || !isUnknownModel(err)) throw err;
    return { ...(await once(apiKey, { ...opts, model: LEGACY_MODEL })), model: LEGACY_MODEL, fellBack: true };
  }
}

async function once(apiKey, { prompt, aspectRatio, imageSize, model, images, signal, keyLabel }) {
  const label = ASPECT_RATIOS[aspectRatio];
  const text = String(prompt || '').trim() + (label ? `\n\nAspect ratio: ${label}.` : '');
  if (!text.trim()) throw new Error('No prompt text to generate an image from');
  const refs = (images || []).slice(0, MAX_REFS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), TIMEOUT_MS);
  const onAbort = () => ctrl.abort(new Error('Stopped'));
  signal && signal.addEventListener('abort', onAbort, { once: true });
  let res, raw;
  try {
    res = await netguard.send(`${base()}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime || 'image/png', data: r.data } }))] }],
        generationConfig: { responseModalities: ['IMAGE'], ...(imageConfigFor(model, aspectRatio, imageSize) || {}) },
      }),
      signal: ctrl.signal,
    }, { service: 'gemini', key: apiKey, keyLabel, purpose: 'Generate image node' });
    raw = await res.text();
  } catch (err) {
    if (err instanceof netguard.Blocked) throw err;
    if (signal && signal.aborted) throw new Error('Stopped');
    if (ctrl.signal.aborted) throw new Error('Gemini image generation timed out after 120s');
    throw new Error(`Could not reach Gemini: ${err.message}`);
  } finally {
    clearTimeout(timer); signal && signal.removeEventListener('abort', onAbort);
  }
  let body = null; try { body = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const msg = body?.error?.message || raw.slice(0, 300) || `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new Error(`Gemini rejected the API key: ${msg}`);
    if (res.status === 429) {
      const free = /free_tier/i.test(msg) && /limit:\s*0/i.test(msg);
      throw new Error(`Gemini rate limit hit: ${msg}${free ? ' (the key\'s Google project looks like it is on the AI Studio Free tier, which has no image quota: check aistudio.google.com)' : ''}`);
    }
    throw new Error(`Gemini image generation failed (HTTP ${res.status}): ${msg}`);
  }
  const cand = body?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  if (!img) {
    if (['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT'].includes(cand?.finishReason)) throw new Error('Gemini declined to generate this image (safety filters)');
    const said = parts.find((p) => p?.text)?.text;
    throw new Error(said ? `Gemini did not return an image - replied instead: ${said.slice(0, 200)}` : `Gemini did not return an image (finish reason: ${cand?.finishReason || 'unknown'})`);
  }
  const d = img.inlineData || img.inline_data;
  return { base64: d.data, mime: d.mimeType || d.mime_type || 'image/png' };
}

module.exports = { generateImage, IMAGE_MODELS, ASPECT_RATIOS, IMAGE_SIZES, TEXT_MODEL, REF_MODEL, LEGACY_MODEL, MAX_REFS, imageConfigFor };
