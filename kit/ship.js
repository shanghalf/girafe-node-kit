// Ship: one button for "this is ready, put it everywhere".
//
// A node lives in four places at once - here, in your GitHub repository, in your GIRAFE account,
// and (if you publish) on the market - and until now each had its own button, its own version
// rules and its own idea of what "up to date" means. You had to remember which of the four was
// behind, and raise the version by hand whenever one of them refused.
//
// This file is the one place that knows. It answers two questions:
//   matrix(...)  where is each thing, and which targets are behind?
//   plan(...)    what version should this become, and which members of a pack move with it?
// and then ship() does the three steps in order, stopping at the first failure with its name.
//
// The rule, everywhere: the package HASH says whether something changed; the version number only
// says what to call it. A target is behind when its hash differs from the one here. If a target
// already holds this very version number while the files differ, the version MUST rise - that is
// GIRAFE's own rule (it refuses the second one with 409 version-not-higher), and it is simply
// true: two different things cannot both be 1.2.0.
//
// The pure parts (everything but ship()) take plain data and return plain data, so the rules can
// be read and tested without a network, a disk or a kit.

const fs = require('fs');
const path = require('path');

const RE_VERSION = /^\d+\.\d+\.\d+$/;
const parts = (v) => String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => { const x = parts(a); const y = parts(b); for (let i = 0; i < 3; i++) { const d = x[i] - y[i]; if (d) return d; } return 0; };
const bumped = (v, how) => {
  const [a, b, c] = parts(v);
  if (how === 'major') return `${a + 1}.0.0`;
  if (how === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
};

// ---- the matrix ----------------------------------------------------------------------------
// here:   { id, kind: 'node'|'pack', version, hash, members: [{ id, version, hash }] }
// github: what github.status() says for each node id ({ state }), or null when not set up
// girafe: GET /api/kit/plugins, or null when not signed in
// market: the submissions listing, or null when not connected
// Each target comes back as one of:
//   off        not set up here (nothing to say)
//   missing    this target has never had it
//   behind     it has an older version, or the same version with different files
//   current    the same files
//   ahead      it has a newer version than this computer (someone else shipped; save first)
//   waiting    (market) a version is sitting in review
function targetState({ here, there }) {
  if (!there) return { state: 'missing' };
  if (there.hash && here.hash && there.hash === here.hash) return { state: 'current', version: there.version };
  const c = cmp(here.version, there.version);
  if (c > 0) return { state: 'behind', version: there.version };
  if (c < 0) return { state: 'ahead', version: there.version };
  // Same number, and this target never says what files it holds (an older market): take its word.
  if (!there.hash) return { state: 'current', version: there.version, unsure: true };
  // Same number, different files: the version has to rise before this can go anywhere.
  return { state: 'behind', version: there.version, sameNumber: true };
}

function matrix(here, { github = null, girafe = null, market = null } = {}) {
  const out = { id: here.id, kind: here.kind, version: here.version, hash: here.hash, targets: {} };

  // GitHub works on nodes, so a pack is "behind" when any of its members (or its own folder) is.
  if (!github || !github.connected) out.targets.github = { state: 'off' };
  else {
    const ids = here.kind === 'pack' ? [here.id, ...(here.members || []).map((m) => m.id)] : [here.id];
    const states = ids.map((id) => (github.nodes || {})[id]?.state || 'new');
    const dirty = states.filter((s) => ['new', 'changed', 'deleted'].includes(s)).length;
    const stuck = states.find((s) => ['conflict', 'behind'].includes(s)) || null;
    out.targets.github = stuck
      ? { state: stuck === 'behind' ? 'ahead' : 'stuck', why: stuck }
      : dirty ? { state: states.every((s) => s === 'new') ? 'missing' : 'behind', dirty } : { state: 'current' };
  }

  const inGirafe = girafe && (here.kind === 'pack'
    ? (girafe.packs || []).find((p) => p.id === here.id)
    : (girafe.nodes || []).find((n) => n.id === here.id));
  out.targets.girafe = !girafe ? { state: 'off' } : targetState({ here, there: inGirafe });
  // Per member, what GIRAFE holds - the bump rule needs it to leave unchanged members alone.
  if (here.kind === 'pack' && girafe) {
    out.girafeMembers = {};
    for (const mem of here.members || []) {
      const n = (girafe.nodes || []).find((x) => x.id === mem.id);
      if (n) out.girafeMembers[mem.id] = { version: n.version, hash: n.hash };
    }
  }

  if (!market) out.targets.market = { state: 'off' };
  else {
    const mine = (market.submissions || []).filter((s) => s.packageId === here.id);
    const waiting = mine.find((s) => s.status === 'pending');
    const live = mine.map((s) => s.item).find(Boolean) || null; // newest first
    out.targets.market = waiting
      ? { state: 'waiting', version: waiting.version }
      : !live ? { state: 'missing' } : targetState({ here, there: { version: live.version, hash: live.hash || null } });
  }
  return out;
}

// ---- the bump rule -------------------------------------------------------------------------
// What this should become, given where the targets are. `how` is what the person picked:
// 'none' | 'patch' | 'minor' | 'major'. 'none' is only honoured when nothing forces a rise.
//
// For a pack: the pack's own version moves, and so does every member whose files changed - but
// NOT a member that is byte-identical to the one already there. That is GIRAFE's rule for a pack
// (an unchanged member must keep its version and hash), and it keeps a pack's history honest.
function plan(here, m, how = 'patch') {
  const need = [];                 // why a rise is forced
  for (const [name, t] of Object.entries(m.targets)) {
    if (t.sameNumber) need.push(name);
  }
  const forced = need.length > 0;
  const rise = forced || (how && how !== 'none');
  const version = rise ? bumped(highestKnown(here, m), forced && (!how || how === 'none') ? 'patch' : how) : here.version;

  const members = [];
  if (here.kind === 'pack') {
    for (const mem of here.members || []) {
      const there = (m.girafeMembers || {})[mem.id] || null;
      const changed = !there || !there.hash || there.hash !== mem.hash;
      const same = there && there.version === mem.version;
      // Only a member whose files changed moves, and only when its number would otherwise clash.
      if (changed && (same || cmp(mem.version, there ? there.version : '0.0.0') <= 0)) {
        members.push({ id: mem.id, from: mem.version, to: bumped(there ? maxV(mem.version, there.version) : mem.version, 'patch') });
      }
    }
  }
  // `highest` is what any bump must build on, so the card can show the same numbers we would.
  // `suggest` is what the card starts on: nothing is raised unless something makes it necessary -
  // a target that has never seen this node is happy with the number it already carries.
  return { version, from: here.version, highest: highestKnown(here, m), rise, forced, forcedBy: need, suggest: forced ? 'patch' : 'none', members };
}
const maxV = (a, b) => (cmp(a, b) >= 0 ? a : b);
// The highest number anyone has, so a bump always lands above every target.
function highestKnown(here, m) {
  let v = here.version;
  for (const t of Object.values(m.targets)) if (t.version && cmp(t.version, v) > 0) v = t.version;
  return v;
}

// ---- writing it down -------------------------------------------------------------------------
// The version lives in the author's own manifest.json / pack.json: rewritten with a plain replace
// so their formatting survives and only the one number changes (same as girafe-link.raiseVersion).
function setVersion(dir, file, version) {
  if (!RE_VERSION.test(version)) throw new Error(`"${version}" is not a version like 1.2.3.`);
  const p = path.join(dir, file);
  const text = fs.readFileSync(p, 'utf8');
  const re = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  if (!re.test(text)) {
    const o = JSON.parse(text);
    fs.writeFileSync(p, JSON.stringify({ ...o, version }, null, 2));
  } else fs.writeFileSync(p, text.replace(re, `$1${version}$3`));
  return version;
}

// What changed, in the author's own CHANGELOG.md, newest first. Their file, so: a heading is
// added at the top (under a first-line title if there is one) and nothing else is touched.
function addChangelog(dir, version, notes, today = new Date()) {
  const text = String(notes || '').trim();
  if (!text) return null;
  const p = path.join(dir, 'CHANGELOG.md');
  const date = typeof today === 'string' ? today : today.toISOString().slice(0, 10);
  // One bullet per line of what they wrote, unless they already wrote bullets.
  const body = text.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (/^[-*]\s/.test(l) || l.startsWith('#') ? l : `- ${l}`)).join('\n');
  const entry = `## ${version} - ${date}\n\n${body}\n`;
  let out;
  try {
    const old = fs.readFileSync(p, 'utf8');
    const lines = old.split('\n');
    const at = lines[0].startsWith('# ') ? 1 : 0;                        // keep the file's title on top
    out = [...lines.slice(0, at), ...(at ? [''] : []), entry, ...lines.slice(at).filter((l, i) => !(i === 0 && !l.trim()))].join('\n');
  } catch { out = `# Changelog\n\n${entry}`; }
  fs.writeFileSync(p, out);
  return p;
}

// ---- what is here ----------------------------------------------------------------------------
// One node or one pack, as this computer holds it: version and the hash a package of it carries.
function here(id) {
  const store = require('./store');
  const packs = require('./packs');
  const pkgs = require('./package');
  if (packs.isPackDir(id)) {
    const p = packs.getPack(id);
    if (!p) throw new Error(`No pack "${id}".`);
    return { id, kind: 'pack', name: p.name, version: p.version, hash: pkgs.hashPack(id), dir: path.join(store.NODES, id),
      members: (p.nodes || []).map((n) => ({ id: n, version: readVersion(path.join(store.NODES, n)), hash: pkgs.hashNode(n), dir: path.join(store.NODES, n) })) };
  }
  const dir = path.join(store.NODES, id);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return { id, kind: 'node', name: m.name || id, version: m.version, hash: pkgs.hashNode(id), dir, members: [] };
}
const readVersion = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version; } catch { return '0.0.0'; } };

// ---- shipping ----------------------------------------------------------------------------------
// Bump what has to rise, write the changelog, then: GitHub, GIRAFE, the market - in that order,
// stopping at the first failure with its name. GitHub first on purpose: whatever happens after,
// the work itself is saved somewhere you can get it back from.
//
// Every step is reported, done or not, so the card can show the three columns turning green one
// after the other - and say exactly which one stopped.
async function ship(id, { bump = 'patch', notes = '', targets = ['github', 'girafe', 'market'], deps } = {}) {
  const { github, girafeLink, marketLink, girafePlugins, marketSubmissions } = deps;
  const h = here(id);
  const m = matrix(h, {
    github: targets.includes('github') ? await github.status({ remote: true }).catch(() => null) : null,
    girafe: targets.includes('girafe') ? await girafePlugins().catch(() => null) : null,
    market: targets.includes('market') ? await marketSubmissions().catch(() => null) : null,
  });
  const p = plan(h, m, bump);
  const steps = [];
  const note = String(notes || '').trim();

  // 1. The numbers, on disk, before anything is packed.
  if (p.rise) setVersion(h.dir, h.kind === 'pack' ? 'pack.json' : 'manifest.json', p.version);
  for (const mem of p.members) setVersion(path.join(h.dir, '..', mem.id), 'manifest.json', mem.to);
  if (note) addChangelog(h.dir, p.version, note);
  steps.push({ target: 'version', ok: true, version: p.version, members: p.members });

  const run = async (target, fn) => {
    if (!targets.includes(target)) return true;
    try { const info = await fn(); steps.push({ target, ok: true, ...(info || {}) }); return true; }
    catch (e) { steps.push({ target, ok: false, error: e.message, code: e.code || null }); return false; }
  };

  // 2. GitHub: the pack's own folder and every member, so the repository holds what was shipped.
  const ok1 = await run('github', async () => {
    const st = await github.status();
    if (!st.connected) throw Object.assign(new Error('This computer has no GitHub repository set up.'), { code: 'no-github' });
    const ids = h.kind === 'pack' ? [h.id, ...h.members.map((x) => x.id)] : [h.id];
    const saved = [];
    for (const one of ids) {
      const state = (st.nodes || {})[one]?.state;
      if (state === 'clean') continue;
      await github.save({ id: one, message: note ? `${one} ${p.version}: ${note.split('\n')[0].slice(0, 60)}` : `${one} ${p.version}` });
      saved.push(one);
    }
    return { saved };
  });
  if (!ok1) return { id, kind: h.kind, plan: p, steps, stoppedAt: 'github' };

  // 3. GIRAFE: the account's own palette, on every device.
  const ok2 = await run('girafe', async () => {
    const r = h.kind === 'pack' ? await girafeLink.sendPack(h.id, { notes: note }) : await girafeLink.send(h.id, { notes: note });
    return { version: r.version || p.version, status: r.status || null };
  });
  if (!ok2) return { id, kind: h.kind, plan: p, steps, stoppedAt: 'girafe' };

  // 4. The market: a review, or straight out when the market trusts this publisher.
  await run('market', async () => {
    const r = await marketLink.submit(h.id, { kind: h.kind, notes: note });
    return { status: r.submission ? r.submission.status : null, message: r.message || null };
  });
  const last = steps[steps.length - 1];
  return { id, kind: h.kind, plan: p, steps, stoppedAt: last.ok ? null : last.target };
}

module.exports = { matrix, plan, here, ship, setVersion, addChangelog, bumped, cmp, targetState };
