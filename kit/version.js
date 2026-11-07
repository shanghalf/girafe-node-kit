// What this kit pretends to be. GIRAFE moves on; when it does, these numbers move with it
// and the kit tells plugin authors what changed (see CHANGELOG.md).
module.exports = {
  KIT_VERSION: '0.1.0',
  // The GIRAFE release this kit simulates. Plugins declare the oldest one they work with.
  GIRAFE_VERSION: '0.67.3',
  // The host API version: the contract between GIRAFE and a plugin node.
  // A plugin's manifest names the one it was written for ("hostApi": 0).
  // Same major = compatible. GIRAFE will keep older majors running for a while after a new one.
  HOST_API: 0,
};
