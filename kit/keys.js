// The local key bank: API keys for the core nodes that call an outside service
// (Prompt, Generate image), and the GitHub token that saves your nodes to your repo. A key is in plain text only twice: when you paste it (from the
// page to this kit, on your own computer) and in memory for a call to its own service. Stored in workspace/.kit/keys.json, encrypted with AES-256-GCM
// under a random key kept next to it (workspace/.kit/secret.key). The browser only ever sees
// a masked form; plugin nodes never see keys at all.
// On GIRAFE the same keys live in your account's Key bank; nothing here is ever sent there.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const DIR = path.join(store.ROOT, '.kit');
const FILE = path.join(DIR, 'keys.json');
const SECRET = path.join(DIR, 'secret.key');
const SERVICES = {
  anthropic: { label: 'Anthropic (Claude)', get: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', get: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini', get: 'https://aistudio.google.com/apikey' },
  tripo: { label: 'Tripo 3D', get: 'https://platform.tripo3d.ai/api-keys' },
  github: { label: 'GitHub (your nodes repo)', get: 'https://github.com/settings/personal-access-tokens/new' },
  other: { label: 'Other', get: null },
  // Not pasted: the token a GIRAFE account gives this computer when you connect the kit.
  girafe: { label: 'GIRAFE account link', get: null, internal: true },
  // Not pasted either: the token the GIRAFE Market gives this computer (publishing only).
  market: { label: 'GIRAFE Market link', get: null, internal: true },
};

function secret() {
  if (!fs.existsSync(SECRET)) fs.writeFileSync(SECRET, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(SECRET, 'utf8').trim(), 'base64');
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', secret(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { keys: [] }; }
}
function write(data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + '.tmp', FILE);
}
const mask = (v) => (v.length <= 10 ? '•'.repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-4)}`);

// Guess the service from the key's shape; the user can change it.
function guessService(value) {
  if (/^sk-ant-/.test(value)) return 'anthropic';
  if (/^AIza/.test(value)) return 'gemini';
  if (/^sk-/.test(value)) return 'openai';
  if (/^(github_pat_|gh[pousr]_)/.test(value)) return 'github';
  if (/^tsk_/.test(value)) return 'tripo';
  return 'other';
}

// Listing never decrypts: the masked form and a fingerprint are saved when the key is pasted.
function list() {
  return read().keys.map((k) => ({ id: k.id, label: k.label, service: k.service, masked: k.masked || '(saved)', fingerprint: k.fingerprint || null, createdAt: k.createdAt }));
}
function add({ label, service, value }) {
  // A key copied from a code sample sometimes keeps "Bearer " in front; the kit adds it itself.
  value = String(value || '').trim().replace(/^bearer\s+/i, '').trim();
  if (!value) throw new Error('The key is empty.');
  if (value.length > 500) throw new Error('That is too long to be an API key.');
  service = SERVICES[service] ? service : guessService(value);
  const data = read();
  const k = { id: 'k-' + crypto.randomBytes(5).toString('hex'), label: String(label || SERVICES[service].label).trim().slice(0, 80), service, enc: encrypt(value), masked: mask(value), fingerprint: crypto.createHash('sha256').update(value).digest('hex').slice(0, 12), createdAt: new Date().toISOString() };
  data.keys.push(k); write(data);
  return { id: k.id, label: k.label, service: k.service, masked: k.masked, fingerprint: k.fingerprint, createdAt: k.createdAt };
}
function remove(id) {
  const data = read();
  data.keys = data.keys.filter((k) => k.id !== id); write(data);
}
// Server side only: the key value, decrypted in memory for one call to its own service.
// The only callers are kit/ai/* and kit/service-tasks.js, which send it through netguard.send() (own service only).
function use(id, wantService) {
  const k = read().keys.find((x) => x.id === id);
  if (!k) throw new Error('Choose a key for this node (🔑 Keys at the top to add one).');
  if (wantService && ![].concat(wantService).includes(k.service)) throw new Error(`The key "${k.label}" is for ${SERVICES[k.service]?.label || k.service}; this node needs ${[].concat(wantService).map((s) => SERVICES[s].label).join(' or ')}.`);
  return { value: decrypt(k.enc), service: k.service, label: k.label };
}

module.exports = { SERVICES, list, add, remove, use, guessService };
