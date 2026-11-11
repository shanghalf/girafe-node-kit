// Service tasks for a "tasks" field (host API 2): the list of past tasks a node can pick from, read
// from the service's own history with the node's key, or from the history file the service lets
// you export. Both go through the package's "billing" declaration (HOST_API.md › Billing), so the
// kit knows nothing about Tripo or any other service. Same rules as GIRAFE's plugin-billing.js
// (serviceTasks / parseCsv) - keep the two in step.
const netguard = require('./netguard');
const keys = require('./keys');

const TASK_RE = /^[A-Za-z0-9._:-]{4,100}$/;
const MAX_PAGES = 30;
const MAX_ITEMS = 1000;
const DAY = 86400000;
const BEARER = new Set(['openai', 'tripo']);
// Test runs: the official address goes to a fake server (KIT_*_URL), like ctx.http.
const TEST_BASE = { tripo: [['https://openapi.tripo3d.ai/v3', 'KIT_TRIPO_URL'], ['https://openapi.tripo3d.com/v3', 'KIT_TRIPO_COM_URL']] };
function testRedirect(service, url) {
  for (const [official, env] of TEST_BASE[service] || []) if (process.env[env] && url.startsWith(official)) return process.env[env] + url.slice(official.length);
  return url;
}

const getPath = (o, p) => String(p || '').split('.').filter(Boolean).reduce((x, k) => (x == null ? undefined : x[k]), o);
const toTime = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) : NaN);

// One task as the panel and the node see it.
function cleanTask(t) {
  if (!t || !TASK_RE.test(String(t.taskId || ''))) return null;
  const created = toTime(t.createdAt);
  const units = t.units === '' || t.units == null ? null : Number(t.units);
  return {
    taskId: String(t.taskId),
    type: String(t.type || 'task').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'task',
    model: t.model ? String(t.model).slice(0, 60) : null,
    status: String(t.status || '').toLowerCase().slice(0, 30),
    units: Number.isFinite(units) && units >= 0 && units < 1e6 ? units : null,
    createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
  };
}

// The history file the service exports (columns named by billing.csv).
function parseCsv(text, map) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const cells = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',' || ch === ';') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  };
  const head = cells(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (name) => (name ? head.indexOf(String(name).toLowerCase()) : -1);
  if (col(map.taskId) < 0) throw new Error(`This file has no "${map.taskId}" column - is it the service's history export?`);
  return lines.slice(1, 20001).map((line) => {
    const c = cells(line);
    const get = (k) => (col(map[k]) >= 0 ? String(c[col(map[k])] || '').trim() : '');
    return { taskId: get('taskId'), units: get('units'), type: get('type'), model: get('model'), status: get('status'), createdAt: get('createdAt') };
  });
}

// Successful tasks only (the service's own "ok" words), newest first, each id once.
function finish(list, billing) {
  const ok = new Set(((billing.history && billing.history.ok) || ['success', 'succeeded', 'done', 'completed']).map((s) => String(s).toLowerCase()));
  const seen = new Set();
  return list.map(cleanTask).filter((t) => t && (!t.status || ok.has(t.status)) && !seen.has(t.taskId) && seen.add(t.taskId))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, MAX_ITEMS);
}

async function getJson(service, key, url) {
  const res = await netguard.send(testRedirect(service, url), { method: 'GET', headers: { [netguard.AUTH_HEADER[service]]: BEARER.has(service) ? `Bearer ${key.value}` : key.value, accept: 'application/json' }, signal: AbortSignal.timeout(30000) },
    { service, key: key.value, keyLabel: key.label, purpose: `${service} history` });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    const msg = json && (json.message || (json.error && (json.error.message || json.error))) || text.slice(0, 200);
    const e = new Error(res.status === 401 || res.status === 403 ? `${service} refused the key (${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}) - check the key chosen for this node.` : `${service} answered ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`);
    e.status = res.status; throw e;
  }
  if (!json) throw new Error(`${service} did not answer with JSON.`);
  return json;
}

// The history over one window of billing.history.maxDays days ending at `before` (default now).
// Pages: "next" + "cursorParam" (a cursor) when declared, else {page} in the address.
async function fromService(billing, keyId, before) {
  const h = billing.history;
  if (!h) throw new Error(`This service declares no history the kit can read. Load its exported file instead.`);
  const key = keys.use(keyId, billing.service);
  const days = h.maxDays || 31;
  let end = before ? new Date(before) : new Date();
  if (!Number.isFinite(end.getTime())) throw new Error('"before" is not a date');
  const start = new Date(end.getTime() - days * DAY);
  const fill = (tpl, page) => String(tpl).replace(/\{(start|end|page)\}/g, (_, k) => encodeURIComponent(k === 'page' ? page : (k === 'start' ? start : end).toISOString()));
  const items = [];
  let cursor = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let url = fill(h.url, page);
    if (h.next && cursor) url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(h.cursorParam || 'cursor')}=${encodeURIComponent(cursor)}`;
    let json;
    try { json = await getJson(billing.service, key, url); }
    catch (e) {
      // Some services refuse a window that ends in the last minutes: try again ending 31 min ago.
      if (e.status === 400 && page === 1 && !before && end > Date.now() - 30 * 60000) { end = new Date(Date.now() - 31 * 60000); page = 0; continue; }
      throw e;
    }
    const list = getPath(json, h.items);
    const got = (Array.isArray(list) ? list : []).map((x) => { const f = {}; for (const [k, p] of Object.entries(h.fields)) f[k] = getPath(x, p); return f; });
    items.push(...got);
    if (h.next) { cursor = getPath(json, h.next); if (!cursor || !got.length) break; }
    else if (!/\{page\}/.test(h.url) || !got.length) break;
  }
  return { tasks: finish(items, billing), from: start.toISOString(), to: end.toISOString() };
}

function fromCsv(billing, csv) {
  if (!billing.csv) throw new Error('This service declares no history file format.');
  return { tasks: finish(parseCsv(csv, billing.csv), billing) };
}

module.exports = { fromService, fromCsv, parseCsv, cleanTask, MAX_ITEMS };
