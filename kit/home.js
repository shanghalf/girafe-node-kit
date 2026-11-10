// Where your work lives: one folder in your home, outside the kit's own folder.
//   Windows  C:\Users\<you>\GIRAFE kit workspace
//   Mac      /Users/<you>/GIRAFE kit workspace
//   Linux    ~/GIRAFE kit workspace
// So a new download of the kit, a second copy of it or an update never loses your nodes, your
// keys, the GitHub link or the author key that signs your nodes: every copy of the kit on this
// computer opens the same workspace.
//
// Kits before 0.9.0 kept it inside their own folder (<kit>/workspace). On start, when the home
// workspace holds none of your work yet and the kit's own folder does, it is copied home and the
// old folder gets a .moved-to note (nothing is deleted). Other kit folders found next to this one,
// in Downloads, Desktop or Documents, are offered on the page ("Bring your work here").
//
// GIRAFE_KIT_WORKSPACE names the workspace itself (tests, or to choose a place); GIRAFE_KIT_HOME
// only replaces your home folder in the default location.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT_DIR = path.join(__dirname, '..');
const LEGACY = process.env.GIRAFE_KIT_LEGACY || path.join(KIT_DIR, 'workspace'); // GIRAFE_KIT_LEGACY: tests only
const SHIPPED_FROM = path.join(KIT_DIR, 'workspace');
const NAME = 'GIRAFE kit workspace';
// Nodes that come with the kit (copied into a new workspace; never counted as your work).
const SHIPPED = ['example-upper', 'gemini-image'];
// Files in .kit that only exist once you did something (a key, a link, a signed package).
const KIT_FILES = ['keys.json', 'secret.key', 'author-ed25519.pem', 'author-ed25519.pub', 'github.json', 'girafe.json', 'market.json', 'pack-keys.json', 'plugin-state.json', 'node-runs.json', 'cache.json'];
const MOVED = '.moved-to';
const SKIP_COPY = new Set([path.join('.kit', 'update'), path.join('.kit', 'port')]);

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const files = (p) => { try { return fs.readdirSync(p).filter((f) => !f.startsWith('.')); } catch { return []; } };

function homeWorkspace() {
  return path.join(process.env.GIRAFE_KIT_HOME || os.homedir(), NAME);
}

// What of yours a workspace holds (empty lists = nothing of yours).
function survey(ws) {
  const nodes = dirs(path.join(ws, 'nodes')).filter((d) => !SHIPPED.includes(d) && !d.startsWith('.'));
  const graphs = files(path.join(ws, 'graphs')).filter((f) => f.endsWith('.json') && f !== 'g-example.json');
  const kit = KIT_FILES.filter((f) => exists(path.join(ws, '.kit', f)));
  const has = (f) => kit.includes(f);
  return {
    nodes, graphs: graphs.length, keys: has('keys.json') && has('secret.key'), authorKey: has('author-ed25519.pem'),
    github: has('github.json'), girafe: has('girafe.json'), market: has('market.json'),
    work: nodes.length > 0 || graphs.length > 0 || kit.length > 0,
    movedTo: (() => { try { return fs.readFileSync(path.join(ws, MOVED), 'utf8').split('\n')[0].trim() || null; } catch { return null; } })(),
  };
}

function copyTree(from, to, { force }) {
  fs.cpSync(from, to, {
    recursive: true, force, errorOnExist: false, preserveTimestamps: true,
    filter: (src) => !SKIP_COPY.has(path.relative(from, src)),
  });
}

function markMoved(oldWs, newWs) {
  try {
    fs.writeFileSync(path.join(oldWs, MOVED), `${newWs}\n${new Date().toISOString()}\n`);
    fs.writeFileSync(path.join(oldWs, 'MOVED - read me.txt'),
      `Your GIRAFE kit work (nodes, graphs, keys, GitHub link, signing key) was copied to:\n\n  ${newWs}\n\n`
      + 'Every copy of the kit on this computer now uses that folder, so updates and new downloads never lose it.\n'
      + 'This folder was left as it was. Delete it once you are sure everything is there.\n');
  } catch { /* a read-only old folder: the copy is still done */ }
}

// Seed the kit's own example nodes into a workspace that lacks them.
function seedShipped(ws) {
  for (const id of SHIPPED) {
    const src = path.join(SHIPPED_FROM, 'nodes', id);
    const dst = path.join(ws, 'nodes', id);
    if (exists(src) && !exists(dst)) { try { copyTree(src, dst, { force: false }); } catch { /* the kit still starts */ } }
  }
}

let state = null;

function resolve() {
  if (state) return state;
  if (process.env.GIRAFE_KIT_WORKSPACE) {
    state = { root: path.resolve(process.env.GIRAFE_KIT_WORKSPACE), mode: 'env', migratedFrom: null };
    return state;
  }
  const home = homeWorkspace();
  let migratedFrom = null;
  try {
    const mine = survey(LEGACY);
    if (path.resolve(LEGACY) !== path.resolve(home) && mine.work && !mine.movedTo && !survey(home).work) {
      copyTree(LEGACY, home, { force: true });
      markMoved(LEGACY, home);
      migratedFrom = LEGACY;
    }
    fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
    seedShipped(home);
    state = { root: home, mode: 'home', migratedFrom };
  } catch (e) {
    // No home folder we can write: stay in the kit's own folder, as before.
    state = { root: LEGACY, mode: 'legacy', migratedFrom: null, error: e.message };
  }
  return state;
}

// Other kit folders on this computer that still hold work not brought home.
function findOtherKits() {
  const s = resolve();
  if (s.mode !== 'home') return [];
  const here = path.resolve(path.dirname(LEGACY));
  const h = process.env.GIRAFE_KIT_HOME || os.homedir();
  const places = [path.dirname(here), path.join(h, 'Downloads'), path.join(h, 'Desktop'), path.join(h, 'Documents'), h];
  const seen = new Set();
  const out = [];
  const consider = (dir) => {
    const d = path.resolve(dir);
    if (d === here || seen.has(d)) return;
    seen.add(d);
    if (!exists(path.join(d, 'kit.js')) || !exists(path.join(d, 'workspace'))) return;
    const ws = path.join(d, 'workspace');
    const sv = survey(ws);
    if (!sv.work || sv.movedTo) return;
    let at = null;
    try { at = fs.statSync(ws).mtime.toISOString(); } catch {}
    out.push({ path: d, workspace: ws, ...sv, modifiedAt: at });
  };
  for (const place of places) {
    for (const name of dirs(place)) {
      if (!/girafe|node.?kit/i.test(name)) continue;
      const d = path.join(place, name);
      consider(d);
      for (const inner of dirs(d)) if (/girafe|node.?kit/i.test(inner)) consider(path.join(d, inner)); // a zip unpacked into a folder of the same name
    }
  }
  return out.slice(0, 20);
}

// Bring another kit folder's work into the home workspace. Only a folder findOtherKits() lists.
// Nothing here is overwritten: your nodes, graphs and files already here win; keys, the GitHub
// link and the signing key come over only when this workspace has none.
function importFrom(kitDir) {
  const s = resolve();
  if (s.mode !== 'home') throw Object.assign(new Error('This kit does not use the home workspace.'), { status: 409 });
  const found = findOtherKits().find((k) => path.resolve(k.path) === path.resolve(String(kitDir || '')));
  if (!found) throw Object.assign(new Error('That folder is not a kit with work to bring.'), { status: 404 });
  const from = found.workspace;
  const to = s.root;
  const before = survey(to);
  const report = { nodes: [], skippedNodes: [], graphs: 0, keys: false, authorKey: false, github: false, girafe: false, market: false, conflicts: [] };

  if (!before.work) {
    copyTree(from, to, { force: true });
    Object.assign(report, { nodes: found.nodes, graphs: found.graphs, keys: found.keys, authorKey: found.authorKey, github: found.github, girafe: found.girafe, market: found.market });
  } else {
    for (const id of found.nodes) {
      const dst = path.join(to, 'nodes', id);
      if (exists(dst)) { report.skippedNodes.push(id); continue; }
      copyTree(path.join(from, 'nodes', id), dst, { force: false });
      report.nodes.push(id);
    }
    for (const f of files(path.join(from, 'graphs'))) {
      const dst = path.join(to, 'graphs', f);
      if (f.endsWith('.json') && !exists(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(from, 'graphs', f), dst); report.graphs++; }
    }
    const kitFrom = path.join(from, '.kit');
    const kitTo = path.join(to, '.kit');
    fs.mkdirSync(kitTo, { recursive: true });
    const take = (names, flag) => {
      if (!names.every((n) => exists(path.join(kitFrom, n)))) return;
      if (names.some((n) => exists(path.join(kitTo, n)))) {
        const same = names.every((n) => { try { return fs.readFileSync(path.join(kitFrom, n)).equals(fs.readFileSync(path.join(kitTo, n))); } catch { return false; } });
        if (!same) report.conflicts.push(flag);
        return;
      }
      for (const n of names) fs.copyFileSync(path.join(kitFrom, n), path.join(kitTo, n));
      report[flag] = true;
    };
    take(['keys.json', 'secret.key'], 'keys');
    take(['author-ed25519.pem'], 'authorKey');
    if (report.authorKey && exists(path.join(kitFrom, 'author-ed25519.pub'))) fs.copyFileSync(path.join(kitFrom, 'author-ed25519.pub'), path.join(kitTo, 'author-ed25519.pub'));
    take(['github.json'], 'github');
    take(['girafe.json'], 'girafe');
    take(['market.json'], 'market');
    for (const n of ['pack-keys.json', 'plugin-state.json', 'node-runs.json']) if (exists(path.join(kitFrom, n)) && !exists(path.join(kitTo, n))) fs.copyFileSync(path.join(kitFrom, n), path.join(kitTo, n));
    if (exists(path.join(kitFrom, 'files'))) copyTree(path.join(kitFrom, 'files'), path.join(kitTo, 'files'), { force: false });
  }
  markMoved(from, to);
  return { from: found.path, to, ...report };
}

module.exports = { resolve, survey, findOtherKits, importFrom, homeWorkspace, LEGACY, SHIPPED, NAME };
