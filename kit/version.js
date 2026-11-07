// What this kit pretends to be. GIRAFE moves on; when it does, these numbers move with it
// and the kit tells plugin authors what changed (see CHANGELOG.md).
module.exports = {
  KIT_VERSION: '0.1.0',
  // The GIRAFE release this kit simulates. Plugins declare the oldest one they work with.
  GIRAFE_VERSION: '0.67.3',
  // The host API version: the contract between GIRAFE and a plugin node.
  // A plugin's manifest names the one it was written for ("hostApi": 1).
  // 1 added key slots and ctx.http. Nodes written for an older one keep running while it is listed
  // in SUPPORTED_HOST_APIS (GIRAFE keeps the previous one for a while after a new one).
  HOST_API: 1,
  SUPPORTED_HOST_APIS: [0, 1],
};
