# Changelog

The kit simulates a given GIRAFE release and host API. When either changes, it's noted here
with what plugin authors need to do.

## 0.5.2 (2026-11-07)

- Fixed: a menu opened from a dialog (the ⋯ next to a node in GitHub) showed behind it.

## 0.5.1 (2026-11-07)

- "Check for a newer kit" works with a private kit repository: a git clone now checks the
  release branch with `git fetch` (your own git login) instead of an anonymous download, which
  GitHub answers 404 for a private repository. No change for plugins.

## 0.5.0 (2026-11-07)

- Host API 2 (still a draft, GIRAFE 0.69.0) gains what the rest of the Tripo pack needs:
  - `"type": "file"` fields (`accept`, `multiple`): files chosen in the node's panel, read with
    `ctx.files.read`. The kit takes pictures and 3D models (GLB, FBX, OBJ, STL, 150 MB).
  - `"outputs": []`: a node that sends nothing on; what it returns is shown on it.
  - `"display": "runs"`: the host keeps what reached the node over its last 10 runs and shows
    them (latest, then earlier), pictures and 3D models included.

## 0.4.0 (2026-11-07)

- **Kit and GIRAFE check each other's version.** The kit asks GIRAFE what it runs
  (`/api/kit/compat`) and says what doesn't match: ⛔ the kit is too old for GIRAFE (sending
  refused), ⚠️ GIRAFE doesn't run this host API yet (such nodes are refused in the kit, with the
  reason, before anything is sent), ⬆ a newer kit exists. GIRAFE (0.68.3) refuses a kit older
  than 0.4.0 with 426, and a node it can't run with a clear 409.
- **🔄 Versions and updates → ⬆ Update the kit**: a git clone pulls; a downloaded kit gets the
  release zip, checked, with the current files backed up first. The kit restarts by itself on
  the new version and goes back to the previous one if the new one doesn't start. Your
  `workspace/` is never touched.
- `kit.js` now runs the kit as a child process and watches it (`--no-watch` to run it in one
  process).
- Kits before 0.4.0 can no longer link or send to GIRAFE 0.68.3+: download the kit again once.

## 0.3.0 (2026-11-07)

- **Host API 2**, simulating GIRAFE 0.69.0 (not released yet: nodes written for host API 2 run
  in the kit now, and in GIRAFE once 0.69.0 is out). Nodes for host API 0 and 1 run unchanged.
  - `"limits": { "seconds": n }`: a firing may run up to an hour (a node waiting on a slow service).
  - `ctx.state.get()` / `ctx.state.set(obj)` with `"state": true`: a small object kept per node
    on the canvas, across runs and restarts.
  - `ctx.files.fromUrl(url, { name, mime })`: the host downloads a big result (200 MB) to a file.
  - `ctx.http({ form })`: multipart forms, a file field read by the host from a reference.
  - `"network"` takes `"*.example.com"`.
  - Key service `tripo` (Tripo 3D keys start with `tsk_` and are recognised when pasted).
- 3D model results (`model/gltf-binary`, FBX, OBJ, STL) are kept as files and shown by their
  preview picture, with a download link.

## 0.2.0 (2026-11-07)

- **🐙 GitHub**: keep your nodes in a private repo of yours. A token limited to that repo, pasted
  once in 🔑 Keys; GitHub's API only (no git program), through the network guard. A changed
  node pulses in Your nodes; right-click for Save to GitHub, See my changes, Take GitHub's
  version / Undo my changes, History and Put this one back. Only node folders are uploaded; a
  file holding something that looks like a key is refused before anything is sent; your work is
  backed up in `workspace/.kit/backups/` before GitHub's version replaces it.

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
