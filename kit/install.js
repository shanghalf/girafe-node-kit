// One home for the kit itself: ~/GIRAFE kit.
//
// The kit is downloaded as a zip and unpacked wherever the browser put it - Downloads, Desktop, a
// folder of the day. On a second computer, or a month later, finding it again is the thing that
// takes ten minutes. So the launcher (tools/start.sh, tools/start.ps1) calls this before starting
// anything: if the kit is not in its home, it copies itself there, leaves a note behind, makes a
// desktop shortcut, and runs from the copy. From then on there is one place and one shortcut.
//
//   Windows  C:\Users\<you>\GIRAFE kit
//   Mac      /Users/<you>/GIRAFE kit
//   Linux    ~/GIRAFE kit
//
// What is never touched: your work. It lives in ~/GIRAFE kit workspace (kit/home.js), outside the
// kit's folder, so copying the kit cannot reach it. The original folder is never deleted either -
// the copy is a copy. A git clone is left exactly where it is: that is a developer's kit, and
// `node kit.js` must keep working from it.
//
// GIRAFE_KIT_HOME replaces the home folder (tests).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'GIRAFE kit';
// Copied on a first install only, never on a later one: the kit's own shipped example nodes and,
// to spare a 30 MB download on the same computer, the private Node it may have fetched.
const ONCE = new Set(['workspace', '.runtime']);
// Never copied at all.
const NEVER = new Set(['.git', 'node_modules', '.installed-from', '.DS_Store']);

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const homeDir = () => process.env.GIRAFE_KIT_HOME || os.homedir();
const homeKit = () => path.join(homeDir(), NAME);
const desktop = () => path.join(homeDir(), 'Desktop');
const isGitClone = (dir) => exists(path.join(dir, '.git'));
const isKit = (dir) => exists(path.join(dir, 'kit.js')) && exists(path.join(dir, 'kit', 'server.js'));

function versionOf(dir) {
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''); } catch { return ''; }
}
function cmp(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// What should happen, without doing it (so the launcher, the page and the tests can all ask).
//   here          run from this folder: it is the home, or a git clone, or home is unreachable
//   copy          copy this folder to the home and run from there
//   use-existing  the home already holds a kit at least as new: run that one instead
function plan(from = path.join(__dirname, '..')) {
  const target = homeKit();
  if (path.resolve(from) === path.resolve(target)) return { action: 'here', target, why: 'already home' };
  if (isGitClone(from)) return { action: 'here', target, why: 'a git clone stays where it is' };
  if (!isKit(from)) return { action: 'here', target, why: 'not a kit folder' };
  if (isKit(target)) {
    const mine = versionOf(from); const theirs = versionOf(target);
    if (cmp(theirs, mine) >= 0) return { action: 'use-existing', target, why: `${NAME} already holds ${theirs || 'a kit'}`, version: theirs };
    return { action: 'copy', target, why: `${NAME} holds ${theirs || 'an older kit'}, this one is ${mine}`, version: mine, replaces: theirs };
  }
  return { action: 'copy', target, why: 'first install', version: versionOf(from) };
}

// The one place that writes into the home folder. Returns the folder to run the kit from.
function install(from = path.join(__dirname, '..')) {
  const p = plan(from);
  if (p.action !== 'copy') return { ...p, kitDir: p.action === 'use-existing' ? p.target : from };
  const fresh = !isKit(p.target);
  fs.mkdirSync(p.target, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (NEVER.has(name)) continue;
    if (ONCE.has(name) && exists(path.join(p.target, name))) continue;
    fs.cpSync(path.join(from, name), path.join(p.target, name), { recursive: true, force: true, errorOnExist: false });
  }
  try {
    fs.writeFileSync(path.join(from, '.installed-from'), `${p.target}\n${new Date().toISOString()}\n`);
    fs.writeFileSync(path.join(from, 'MOVED - read me.txt'),
      `The GIRAFE node kit now lives in one place on this computer:\n\n  ${p.target}\n\n`
      + 'A shortcut called "GIRAFE kit" was put on your desktop; start it from there.\n'
      + 'This folder was left as it was - you can delete it. Your nodes and keys were never in it:\n'
      + `they live in "${path.join(homeDir(), 'GIRAFE kit workspace')}".\n`);
  } catch { /* a read-only download folder: the copy is done anyway */ }
  return { ...p, kitDir: p.target, copied: true, fresh };
}

// A shortcut named "GIRAFE kit" on the desktop, made once and left alone afterwards (an update
// never touches the desktop). Nothing here fails the start: a shortcut is a convenience.
function shortcut(kitDir = homeKit()) {
  const dir = desktop();
  if (!exists(dir)) return { made: false, why: 'no Desktop folder' };
  try {
    if (process.platform === 'win32') {
      const file = path.join(dir, `${NAME}.lnk`);
      if (exists(file)) return { made: false, file, why: 'already there' };
      const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(file)});`
        + `$s.TargetPath=${q(path.join(kitDir, 'Start GIRAFE kit (Windows).cmd'))};`
        + `$s.WorkingDirectory=${q(kitDir)};$s.Description='GIRAFE node kit';$s.Save()`;
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
      return { made: true, file };
    }
    if (process.platform === 'darwin') {
      const file = path.join(dir, `${NAME}.command`);
      if (exists(file)) return { made: false, file, why: 'already there' };
      fs.writeFileSync(file, `#!/bin/sh\nexec ${sh(path.join(kitDir, 'tools', 'start.sh'))}\n`, { mode: 0o755 });
      return { made: true, file };
    }
    const file = path.join(dir, 'girafe-kit.desktop');
    if (exists(file)) return { made: false, file, why: 'already there' };
    fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', `Name=${NAME}`, 'Comment=Build GIRAFE nodes on this computer',
      `Exec=${path.join(kitDir, 'tools', 'start.sh')}`, `Path=${kitDir}`, 'Terminal=true', 'Categories=Development;', ''].join('\n'), { mode: 0o755 });
    return { made: true, file };
  } catch (e) { return { made: false, error: e.message }; }
}

// Start with the computer. Off by default, and only ever turned on from the kit's own page.
function autostartFile() {
  if (process.platform === 'win32') return path.join(homeDir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.lnk`);
  if (process.platform === 'darwin') return path.join(homeDir(), 'Library', 'LaunchAgents', 'live.girafe.kit.plist');
  return path.join(homeDir(), '.config', 'autostart', 'girafe-kit.desktop');
}
const autostartOn = () => exists(autostartFile());

function setAutostart(on, kitDir = path.join(__dirname, '..')) {
  const file = autostartFile();
  if (!on) { try { fs.unlinkSync(file); } catch { /* not there */ } return { on: false, file }; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(file)});`
      + `$s.TargetPath='powershell.exe';`
      + `$s.Arguments=${q(`-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${path.join(kitDir, 'tools', 'start.ps1')}" --no-open`)};`
      + `$s.WorkingDirectory=${q(kitDir)};$s.Save()`;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    return { on: true, file };
  }
  if (process.platform === 'darwin') {
    fs.writeFileSync(file, ['<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '  <key>Label</key><string>live.girafe.kit</string>',
      '  <key>ProgramArguments</key><array>',
      `    <string>${xml(path.join(kitDir, 'tools', 'start.sh'))}</string><string>--no-open</string>`,
      '  </array>',
      '  <key>RunAtLoad</key><true/>',
      '</dict></plist>', ''].join('\n'));
    try { execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' }); } catch { /* loads at the next login anyway */ }
    return { on: true, file };
  }
  fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', `Name=${NAME}`,
    `Exec=${path.join(kitDir, 'tools', 'start.sh')} --no-open`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
  return { on: true, file };
}

// Quoting, so a folder name with a quote or a space in it cannot become part of a command.
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;                 // PowerShell single quotes
const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;             // /bin/sh single quotes
const xml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

module.exports = { plan, install, shortcut, setAutostart, autostartOn, autostartFile, homeKit, versionOf, NAME };

// node kit/install.js --prepare
// Prints the folder to run the kit from on the last line of stdout; everything else goes to
// stderr, so a launcher can do: KIT=$(node kit/install.js --prepare)
if (require.main === module && process.argv.includes('--prepare')) {
  let r;
  try { r = install(); } catch (e) { process.stderr.write(`  Could not copy the kit to ${homeKit()}: ${e.message}\n  Starting from here instead.\n`); r = { kitDir: path.join(__dirname, '..'), action: 'here' }; }
  if (r.copied) {
    process.stderr.write(`\n  The kit now lives in one place: ${r.kitDir}\n`);
    const s = shortcut(r.kitDir);
    if (s.made) process.stderr.write('  A "GIRAFE kit" shortcut was put on your desktop.\n');
  } else if (r.action === 'use-existing') {
    process.stderr.write(`\n  ${r.why}: starting that one.\n`);
  }
  process.stdout.write(`${r.kitDir}\n`);
}
