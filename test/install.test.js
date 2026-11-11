// One home for the kit (kit/install.js): a kit unzipped anywhere copies itself to ~/GIRAFE kit,
// leaves a note behind, and runs from there - without ever touching the person's work, and
// without moving a developer's git clone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KIT = path.join(__dirname, '..');
// A plausible unzipped kit: the files that matter plus some bulk to notice if it is copied.
function fakeKit(dir, version) {
  fs.mkdirSync(path.join(dir, 'kit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace', 'nodes', 'example-upper'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.runtime', 'node-v22'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kit.js'), '// kit\n');
  fs.writeFileSync(path.join(dir, 'kit', 'server.js'), '// server\n');
  fs.writeFileSync(path.join(dir, 'kit', 'install.js'), fs.readFileSync(path.join(KIT, 'kit', 'install.js')));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'girafe-node-kit', version }));
  fs.writeFileSync(path.join(dir, 'workspace', 'nodes', 'example-upper', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(dir, '.runtime', 'node-v22', 'node'), 'binary');
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk', 'x.js'), '//');
  return dir;
}
const withHome = (fn) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-home-'));
  const before = process.env.GIRAFE_KIT_HOME;
  process.env.GIRAFE_KIT_HOME = home;
  delete require.cache[require.resolve('../kit/install.js')];
  try { return fn(home, require('../kit/install.js')); }
  finally { if (before === undefined) delete process.env.GIRAFE_KIT_HOME; else process.env.GIRAFE_KIT_HOME = before; fs.rmSync(home, { recursive: true, force: true }); }
};

test('a kit unzipped anywhere moves into ~/GIRAFE kit and says where it went', () => {
  withHome((home, install) => {
    const from = fakeKit(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dl-')), '0.14.0');
    const r = install.install(from);
    assert.equal(r.action, 'copy');
    assert.equal(r.kitDir, path.join(home, 'GIRAFE kit'));
    assert.ok(fs.existsSync(path.join(r.kitDir, 'kit.js')));
    assert.ok(fs.existsSync(path.join(r.kitDir, 'kit', 'server.js')));
    // the shipped examples and a Node already downloaded come along on a first install
    assert.ok(fs.existsSync(path.join(r.kitDir, 'workspace', 'nodes', 'example-upper')));
    assert.ok(fs.existsSync(path.join(r.kitDir, '.runtime', 'node-v22', 'node')));
    // node_modules never does
    assert.ok(!fs.existsSync(path.join(r.kitDir, 'node_modules')));
    // the original is left alone, with a note
    assert.ok(fs.existsSync(path.join(from, 'kit.js')), 'nothing is deleted');
    assert.match(fs.readFileSync(path.join(from, '.installed-from'), 'utf8'), /GIRAFE kit/);
    assert.match(fs.readFileSync(path.join(from, 'MOVED - read me.txt'), 'utf8'), /GIRAFE kit workspace/);
    fs.rmSync(from, { recursive: true, force: true });
  });
});

test('a second, older download starts the kit already at home instead of replacing it', () => {
  withHome((home, install) => {
    fakeKit(path.join(home, 'GIRAFE kit'), '0.14.0');
    const from = fakeKit(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dl-')), '0.13.1');
    const r = install.install(from);
    assert.equal(r.action, 'use-existing');
    assert.equal(r.kitDir, path.join(home, 'GIRAFE kit'));
    assert.equal(install.versionOf(r.kitDir), '0.14.0', 'the newer kit at home is untouched');
    fs.rmSync(from, { recursive: true, force: true });
  });
});

test('a newer download replaces the kit at home, but never its workspace', () => {
  withHome((home, install) => {
    const at = path.join(home, 'GIRAFE kit');
    fakeKit(at, '0.14.0');
    fs.writeFileSync(path.join(at, 'workspace', 'nodes', 'example-upper', 'mine.txt'), 'do not lose me');
    const from = fakeKit(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dl-')), '0.15.0');
    const r = install.install(from);
    assert.equal(r.action, 'copy');
    assert.equal(install.versionOf(at), '0.15.0');
    assert.equal(fs.readFileSync(path.join(at, 'workspace', 'nodes', 'example-upper', 'mine.txt'), 'utf8'), 'do not lose me');
    fs.rmSync(from, { recursive: true, force: true });
  });
});

test('a git clone is never moved', () => {
  withHome((home, install) => {
    const from = fakeKit(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-git-')), '0.14.0');
    fs.mkdirSync(path.join(from, '.git'));
    const r = install.install(from);
    assert.equal(r.action, 'here');
    assert.match(r.why, /git clone/);
    assert.equal(r.kitDir, from);
    assert.ok(!fs.existsSync(path.join(home, 'GIRAFE kit')));
    fs.rmSync(from, { recursive: true, force: true });
  });
});

test('--prepare prints the folder to run from as its last line', () => {
  withHome((home, install) => {
    const from = fakeKit(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-dl-')), '0.14.0');
    const out = execFileSync(process.execPath, [path.join(from, 'kit', 'install.js'), '--prepare'], { env: { ...process.env, GIRAFE_KIT_HOME: home }, encoding: 'utf8' });
    assert.equal(out.trim().split('\n').pop().trim(), path.join(home, 'GIRAFE kit'));
    fs.rmSync(from, { recursive: true, force: true });
    void install;
  });
});

test('start with the computer: a login item is written and removed, and nothing else is', () => {
  withHome((home, install) => {
    const kitDir = fakeKit(path.join(home, 'GIRAFE kit'), '0.14.0');
    assert.equal(install.autostartOn(), false);
    if (process.platform === 'win32') return; // the shortcut needs PowerShell; checked by hand
    const on = install.setAutostart(true, kitDir);
    assert.equal(on.on, true);
    assert.ok(fs.existsSync(install.autostartFile()));
    assert.match(fs.readFileSync(install.autostartFile(), 'utf8'), /start\.sh/);
    assert.equal(install.autostartOn(), true);
    install.setAutostart(false, kitDir);
    assert.equal(install.autostartOn(), false);
  });
});
