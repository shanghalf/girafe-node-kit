// Your work lives in one home folder, outside the kit (kit/home.js): an old in-folder workspace is
// moved there, other kit folders are found and brought in, and nothing already there is overwritten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-home-'));
const HOME = path.join(T, 'home');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
// An old kit folder (in Downloads) with work, and this kit's own folder with work too.
function makeKit(dir, nodes, extra = {}) {
  write(path.join(dir, 'kit.js'), '// kit');
  for (const id of nodes) write(path.join(dir, 'workspace', 'nodes', id, 'manifest.json'), JSON.stringify({ id, version: extra.version || '1.0.0' }));
  if (extra.keys) { write(path.join(dir, 'workspace', '.kit', 'keys.json'), extra.keys); write(path.join(dir, 'workspace', '.kit', 'secret.key'), 'sk-' + extra.keys); }
  if (extra.author) write(path.join(dir, 'workspace', '.kit', 'author-ed25519.pem'), extra.author);
  if (extra.github) write(path.join(dir, 'workspace', '.kit', 'github.json'), extra.github);
}
const THIS = path.join(T, 'apps', 'girafe-node-kit-new');
const OLD = path.join(HOME, 'Downloads', 'girafe-node-kit-release', 'girafe-node-kit-release');
makeKit(THIS, ['mine-here'], { keys: 'K1', author: 'A1' });
makeKit(OLD, ['tripo-3d', 'tripo-pack', 'mine-here'], { keys: 'K2', author: 'A2', github: '{"repo":"x"}' });
write(path.join(OLD, 'workspace', 'graphs', 'g1.json'), '{}');

// Run in a child so home.js resolves with these settings.
const run = (code) => JSON.parse(execFileSync(process.execPath, ['-e', `const h=require(${JSON.stringify(path.join(__dirname, '..', 'kit', 'home.js'))});${code}`], {
  env: { ...process.env, GIRAFE_KIT_WORKSPACE: '', GIRAFE_KIT_HOME: HOME, GIRAFE_KIT_LEGACY: path.join(THIS, 'workspace') }, encoding: 'utf8' }));

test('an old in-folder workspace moves home, the old folder is left with a note', () => {
  const s = run('process.stdout.write(JSON.stringify(h.resolve()))');
  const ws = path.join(HOME, 'GIRAFE kit workspace');
  assert.equal(s.root, ws);
  assert.equal(s.mode, 'home');
  assert.equal(s.migratedFrom, path.join(THIS, 'workspace'));
  assert.ok(fs.existsSync(path.join(ws, 'nodes', 'mine-here', 'manifest.json')));
  assert.equal(fs.readFileSync(path.join(ws, '.kit', 'author-ed25519.pem'), 'utf8'), 'A1');
  assert.ok(fs.existsSync(path.join(THIS, 'workspace', 'nodes', 'mine-here')), 'nothing deleted');
  assert.ok(fs.existsSync(path.join(THIS, 'workspace', '.moved-to')));
  // Second start: no second move.
  assert.equal(run('process.stdout.write(JSON.stringify(h.resolve()))').migratedFrom, null);
});

test('another kit folder with work is found and brought in without overwriting', () => {
  const others = run('process.stdout.write(JSON.stringify(h.findOtherKits()))');
  assert.equal(others.length, 1);
  assert.equal(others[0].path, OLD);
  assert.deepEqual(others[0].nodes.sort(), ['mine-here', 'tripo-3d', 'tripo-pack']);
  assert.ok(others[0].authorKey && others[0].github && others[0].keys);
  const r = run(`process.stdout.write(JSON.stringify(h.importFrom(${JSON.stringify(OLD)})))`);
  const ws = path.join(HOME, 'GIRAFE kit workspace');
  assert.deepEqual(r.nodes.sort(), ['tripo-3d', 'tripo-pack']);
  assert.deepEqual(r.skippedNodes, ['mine-here']);
  assert.equal(r.graphs, 1);
  assert.equal(r.github, true);
  assert.deepEqual(r.conflicts.sort(), ['authorKey', 'keys']);
  assert.equal(fs.readFileSync(path.join(ws, '.kit', 'author-ed25519.pem'), 'utf8'), 'A1', 'signing key here kept');
  assert.ok(fs.existsSync(path.join(ws, 'nodes', 'tripo-pack', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(OLD, 'workspace', 'nodes', 'tripo-3d')), 'old folder untouched');
  assert.equal(run('process.stdout.write(JSON.stringify(h.findOtherKits()))').length, 0, 'not offered again');
});

test('a fresh home takes the whole old workspace, signing key and keys included', () => {
  const H2 = path.join(T, 'home2');
  const OLD2 = path.join(H2, 'Desktop', 'girafe-node-kit');
  makeKit(OLD2, ['tripo-rig'], { keys: 'K3', author: 'A3', github: '{}' });
  const env = { ...process.env, GIRAFE_KIT_WORKSPACE: '', GIRAFE_KIT_HOME: H2, GIRAFE_KIT_LEGACY: path.join(T, 'apps', 'fresh-zip', 'workspace') };
  makeKit(path.join(T, 'apps', 'fresh-zip'), []);
  const out = JSON.parse(execFileSync(process.execPath, ['-e', `const h=require(${JSON.stringify(path.join(__dirname, '..', 'kit', 'home.js'))});h.resolve();const r=h.importFrom(${JSON.stringify(OLD2)});process.stdout.write(JSON.stringify(r))`], { env, encoding: 'utf8' }));
  assert.equal(out.authorKey, true);
  assert.equal(out.keys, true);
  const ws = path.join(H2, 'GIRAFE kit workspace');
  assert.equal(fs.readFileSync(path.join(ws, '.kit', 'author-ed25519.pem'), 'utf8'), 'A3');
  assert.equal(fs.readFileSync(path.join(ws, '.kit', 'secret.key'), 'utf8'), 'sk-K3');
});

test('only a folder the kit found can be imported', () => {
  assert.throws(() => run(`h.importFrom(${JSON.stringify(path.join(T, 'nowhere'))})`));
});

test.after(() => fs.rmSync(T, { recursive: true, force: true }));
