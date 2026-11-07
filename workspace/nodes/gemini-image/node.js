// Gemini image, as a plugin. Same request as GIRAFE's core Generate image node, but everything
// goes through ctx: the picture bytes (ctx.files), the call (ctx.http with the "gemini" key slot:
// the host adds the key, this code never sees it) and the result (ctx.files.write).
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const LEGACY = 'gemini-2.5-flash-image';
const ONE_K_ONLY = ['gemini-3.1-flash-lite-image', LEGACY];
const RATIOS = { '1:1': 'Square (1:1)', '3:4': 'Portrait (3:4)', '4:3': 'Landscape (4:3)', '9:16': 'Tall portrait (9:16)', '16:9': 'Widescreen (16:9)' };
const MAX_REFS = 14;

function picturesIn(ctx, v) {
  if (ctx.isFile(v)) return [v];
  if (Array.isArray(v) && v.length && v.every((x) => ctx.isFile(x))) return v;
  return [];
}

async function generate(ctx, model, text, refs, settings) {
  const cfg = {};
  if (RATIOS[settings.aspectRatio]) cfg.aspectRatio = settings.aspectRatio;
  if (['2K', '4K'].includes(settings.imageSize) && !ONE_K_ONLY.includes(model)) cfg.imageSize = settings.imageSize;
  const res = await ctx.http({
    slot: 'gemini',
    method: 'POST',
    url: `${API}/${model}:generateContent`,
    json: {
      contents: [{ parts: [{ text }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data } }))] }],
      generationConfig: { responseModalities: ['IMAGE'], ...(Object.keys(cfg).length ? { imageConfig: cfg } : {}) },
    },
  });
  const msg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new Error(`Gemini rejected the API key: ${msg}`);
  if (res.status === 429) throw new Error(`Gemini rate limit hit: ${msg}`);
  if (!res.ok) throw Object.assign(new Error(`Gemini image generation failed (HTTP ${res.status}): ${msg}`), { unknownModel: res.status === 404 || /not found|not supported|does not exist/i.test(msg) });
  const cand = res.json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const img = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  if (!img) {
    if (['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT'].includes(cand?.finishReason)) throw new Error('Gemini declined to generate this image (safety filters)');
    const said = parts.find((p) => p?.text)?.text;
    throw new Error(said ? `Gemini did not return an image - replied instead: ${said.slice(0, 200)}` : 'Gemini did not return an image');
  }
  const d = img.inlineData || img.inline_data;
  return { data: d.data, mime: d.mimeType || d.mime_type || 'image/png' };
}

module.exports = {
  async run(ctx) {
    const s = ctx.settings;
    const texts = [], refs = [];
    for (const letter of Object.keys(ctx.inputs).sort()) {
      const v = ctx.inputs[letter];
      const pics = picturesIn(ctx, v);
      if (pics.length) refs.push(...pics);
      else if (String(v ?? '').trim()) texts.push(typeof v === 'string' ? v : JSON.stringify(v));
    }
    let text = [String(s.prompt || '').trim(), ...texts].filter(Boolean).join('\n\n');
    if (!text && refs.length) text = 'Make a new picture based on the attached picture(s).';
    if (!text) throw new Error('Describe the picture, or wire in some text.');
    if (RATIOS[s.aspectRatio]) text += `\n\nAspect ratio: ${RATIOS[s.aspectRatio]}.`;

    const pictures = [];
    for (const ref of refs.slice(0, MAX_REFS)) {
      const f = await ctx.files.read(ref);
      pictures.push({ mime: f.mime, data: f.bytes.toString('base64') });
    }
    const model = s.model || 'gemini-nano-banana-2.1';
    await ctx.progress(`generating with ${model}${pictures.length ? ` from ${pictures.length} picture(s)` : ''}…`);
    let out, used = model;
    try { out = await generate(ctx, model, text, pictures, s); }
    catch (e) {
      if (!e.unknownModel || model === LEGACY) throw e;
      await ctx.log(`${model} is not open to this key; trying ${LEGACY}`);
      used = LEGACY; out = await generate(ctx, LEGACY, text, pictures, s);
    }
    const ref = await ctx.files.write(Buffer.from(out.data, 'base64'), out.mime, `${ctx.title || 'image'}.${out.mime.split('/')[1] || 'png'}`);
    await ctx.progress(`✓ ${pictures.length ? 'image to image' : 'text to image'} · ${used}`);
    return ref;
  },
};
