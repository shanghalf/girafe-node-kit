// What this kit pretends to be. GIRAFE moves on; when it does, these numbers move with it
// and the kit tells plugin authors what changed (see CHANGELOG.md).
module.exports = {
  KIT_VERSION: '0.11.2',
  // The GIRAFE release this kit simulates. Plugins declare the oldest one they work with.
  GIRAFE_VERSION: '0.73.0',
  // The host API version: the contract between GIRAFE and a plugin node.
  // A plugin's manifest names the one it was written for ("hostApi": 1).
  // 1 added key slots and ctx.http. Nodes written for an older one keep running while it is listed
  // in SUPPORTED_HOST_APIS (GIRAFE keeps the previous one for a while after a new one).
  // 2 added long runs, ctx.state, ctx.files.fromUrl, ctx.http forms, wildcard hosts and the
  // tripo key service (GIRAFE 0.69.0).
  HOST_API: 2,
  SUPPORTED_HOST_APIS: [0, 1, 2],
};
