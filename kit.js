#!/usr/bin/env node
// girafe-node-kit: start the local GIRAFE simulator and open it in the browser.
//   node kit.js            start and open the browser
//   node kit.js --no-open  start only
//   PORT=5000 node kit.js  another port
//
// kit.js watches the kit it starts (a child process): after "Update the kit" the kit stops with
// code 75 and is started again on the new version; if a new version stops before it is up,
// the previous one is put back and started. Keep this part small: an update doesn't replace
// the copy already running.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`girafe-node-kit needs Node 22 or newer (you have ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

if (process.env.GIRAFE_KIT_CHILD !== '1' && !process.argv.includes('--no-watch')) supervise();
else child();

function supervise() {
  const updater = require('./kit/updater');
  const store = require('./kit/store');
  const portFile = path.join(store.ROOT, '.kit', 'port');
  let current = null;
  let stopping = false;
  const stop = () => { stopping = true; if (current) current.kill('SIGINT'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const run = (again) => {
    const args = process.argv.slice(2).filter((a) => !again || a !== '--open');
    if (again && !args.includes('--no-open')) args.push('--no-open');
    const env = { ...process.env, GIRAFE_KIT_CHILD: '1' };
    if (again) { try { env.PORT = String(Number(fs.readFileSync(portFile, 'utf8')) || env.PORT || ''); } catch {} }
    current = spawn(process.execPath, [__filename, ...args], { stdio: 'inherit', env });
    current.on('exit', async (code, signal) => {
      current = null;
      if (stopping || signal === 'SIGINT' || signal === 'SIGTERM') return process.exit(0);
      if (code === updater.RESTART_CODE) { console.log('\n  Restarting on the new version...\n'); return run(true); }
      const back = code !== 0 ? await updater.rollback() : null;
      if (back) {
        console.error(back.error ? `\n  ${back.error}\n` : `\n  Kit ${back.to} did not start; putting ${back.from} back and starting it.\n`);
        if (!back.error) return run(true);
      }
      process.exit(code ?? 1);
    });
  };
  run(false);
}

function child() {
  const store = require('./kit/store');
  const { start } = require('./kit/server');
  const version = require('./kit/version');
  const seed = require('./kit/seed');
  const updater = require('./kit/updater');
  seed.ensureExample();
  start({ port: Number(process.env.PORT) || 4747 }).then(({ server, url }) => {
    try { fs.writeFileSync(path.join(store.ROOT, '.kit', 'port'), String(server.address().port)); } catch {}
    const done = updater.confirm();
    require('./kit/session').startTimers();
    console.log(`\n  GIRAFE node kit ${version.KIT_VERSION} · simulating GIRAFE ${version.GIRAFE_VERSION} · host API ${version.HOST_API}`);
    if (done) console.log(`  Updated from ${done.from} to ${done.to}.`);
    console.log(`  ${url}`);
    console.log(`  Your nodes: ${store.NODES}`);
    console.log('  Ctrl+C to stop.\n');
    if (!process.argv.includes('--no-open') && !process.env.CI) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      execFile(cmd[0], cmd[1], () => {});
    }
  }).catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}
