// The kit's own small settings, kept with your work (workspace/.kit/settings.json) so they follow
// you when the kit folder is replaced by an update or a new download.
//   autostart   start the kit when the computer starts (off by default; writes a login item -
//               kit/install.js setAutostart - and is only offered when this is your own computer)
//   autoUpdate  update the kit by itself when a newer one is out (on by default; see kit.js)
// Nothing here is a secret: keys live in the key bank, links in their own files.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const install = require('./install');

const FILE = path.join(store.ROOT, '.kit', 'settings.json');
const DEFAULTS = { autoUpdate: true };

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } };
const write = (d) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); };

// autostart is not stored: the login item on this computer is the truth, and it is per computer
// while the workspace is shared between them.
function all() {
  const s = read();
  return { autoUpdate: s.autoUpdate !== false, autostart: install.autostartOn() };
}

function set(patch) {
  const s = read();
  if (typeof patch.autoUpdate === 'boolean') s.autoUpdate = patch.autoUpdate;
  write({ ...DEFAULTS, ...s });
  if (typeof patch.autostart === 'boolean') {
    try { install.setAutostart(patch.autostart); }
    catch (e) { return { ...all(), autostartError: e.message }; }
  }
  return all();
}

module.exports = { all, set, FILE };
