#!/usr/bin/env node
// girafe-node-kit: start the local GIRAFE simulator and open it in the browser.
//   node kit.js            start and open the browser
//   node kit.js --no-open  start only
//   PORT=5000 node kit.js  another port
const { execFile } = require('child_process');
const store = require('./kit/store');
const { start } = require('./kit/server');
const version = require('./kit/version');
const seed = require('./kit/seed');

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`girafe-node-kit needs Node 22 or newer (you have ${process.versions.node}). Get it from https://nodejs.org`);
  process.exit(1);
}

seed.ensureExample();

start({ port: Number(process.env.PORT) || 4747 }).then(({ url }) => {
  console.log(`\n  GIRAFE node kit ${version.KIT_VERSION} · simulating GIRAFE ${version.GIRAFE_VERSION} · host API ${version.HOST_API}`);
  console.log(`  ${url}`);
  console.log(`  Your nodes: ${store.NODES}`);
  console.log('  Ctrl+C to stop.\n');
  if (!process.argv.includes('--no-open') && !process.env.CI) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    execFile(cmd[0], cmd[1], () => {});
  }
}).catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
