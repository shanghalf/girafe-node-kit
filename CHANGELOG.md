# Changelog

The kit simulates a given GIRAFE release and host API. When either changes, it's noted here
with what plugin authors need to do.

## Unreleased (on main)

- Manifest: optional `"category"`, the section a node is listed under in GIRAFE's palette.
  Gemini image (now 1.1.0) is in "Image generation".
- GIRAFE now accepts linked kits and sent nodes (admin accounts first): the node shows in the
  Promptmixer palette on all your devices, with versions you can roll back.
- Connect: a local GIRAFE on another port of the same machine is accepted (`KIT_GIRAFE_URL`).
- Nodes now look and behave like GIRAFE's Promptmixer nodes: 220 px cards with the state
  animation, kind label, ⏻ toggle, lettered sockets on both sides, wires coloured by their source
  (green when something went through, grey dashes when nothing did).
- The square flow socket on every node (run only when something reaches it).
- Grab any wired socket to move that wire; drop it on empty canvas to remove it.
- **Prompt** node (Anthropic, OpenAI or Gemini; pictures on its inputs go to the model) and
  **Generate image** node (Gemini, text to image or image to image), both like GIRAFE's, with
  saved answers/pictures so a repeated request costs nothing.
- Local **key bank** (🔑 Keys): keys saved encrypted on this computer, shown masked only.
- **Network guard**: a key may only go to its own service, in its login header; every outgoing
  request of the kit is watched and listed (🔑 Keys > Network); the page is locked to the kit.
- **Host API 1** (nodes for host API 0 still run): key slots and `ctx.http`. A plugin declares
  `"keys"` and `"network"`; the user picks a key per slot in the panel; the host adds the key and
  sends through the network guard; the plugin never sees it. Inside a plugin's process, `fetch`
  and the network modules are gone: `ctx.http` is the only way out.
- **Gemini image** (`workspace/nodes/gemini-image`): Generate image rebuilt as a plugin, the first
  real plugin and the test case for packaging and the marketplace.
- The panel says what a plugin may do in plain words.
- **📦 Pack**: a plugin node becomes one signed `.gnode` file (checksums, package hash,
  Ed25519 signature; the author key is made on first pack and stays in `workspace/.kit/`).
- **☁️ Connect to GIRAFE** (optional): one-click device link, approved on girafe.live; no password
  in the kit; the link token is kept and guarded like a key. **Send to my GIRAFE** packs and
  uploads a node to your account (GIRAFE's side comes next).

## 0.1.0 · simulates GIRAFE 0.67.3 · host API 0 (draft)

- Canvas with the core nodes Input, Image, For each, Yes / No and Collect.
- Plugin nodes from `workspace/nodes/`, run one firing per process in Node's permission sandbox.
- Host API 0: inputs, settings, emit, progress, log, file read/write.
- Not yet: AI calls, HTTP with key slots, network limits.
