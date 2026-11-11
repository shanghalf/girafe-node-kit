# Changelog

The kit simulates a given GIRAFE release and host API. When either changes, it's noted here
with what plugin authors need to do.

## 0.14.0 (2026-11-11)

**The kit says hello.** Its regular check with GIRAFE ("am I still signed in?") now also says
where it runs and how its chain stands: the computer's name and port, the kit's version, the
GitHub repository of nodes and how many of them are not saved yet, whether the market is linked,
and the packs and nodes held here with their versions. GIRAFE shows that in Settings › Node kit,
so from any computer you can see which of your computers is running what - something no web page
can find out by itself. Nothing private is in it: no key, no path, no node contents, and the
GitHub state is read from disk, never over the network.

Nothing to do for plugin authors. A GIRAFE from before this answers 404 and the kit quietly asks
the old way, so an older site keeps working.

## 0.13.1 (2026-11-11)

**GIRAFE's "Open the kit" button stops firing blind.** From a fresh download nothing is running
yet, and the button simply led to "This site can't be reached" with no explanation. Your own GIRAFE
— and only it — may now read `GET /api/info` and `GET /api/compat` across origins, so its button
can say whether the kit answers, which version it is, which folder it runs from, and whether that
is the newest pull from GitHub, before opening anything. Nothing else is shared cross-origin, and
nothing cross-origin may write: the same-origin rule on every POST is untouched.

`/api/info` now also carries `kitFolder`, `signedIn` and the newest kit it has already heard of
(from the cache, so answering stays instant).

**📂 open it, next to the folder path.** A web page cannot open a file manager, so the kit does it
itself: `POST /api/open-folder` (its own page only) opens your workspace or the kit folder with
`explorer.exe` / `open` / `xdg-open`. GIRAFE's dialog reaches it by opening the kit's page with
`?folder=workspace`.

## 0.13.0 (2026-11-11)

**One button: "Align with GIRAFE".** Versions used to drift apart on their own - the kit shipped
with a guess about GIRAFE, GIRAFE moved on, and a node kept the version number it was last sent
with - and the kit then refused things on GIRAFE's behalf, with nothing to do about it. Three
changes, so editing a node stops costing you a version chase:

- **The kit never checks against its own guess any more.** Once GIRAFE has answered
  `/api/kit/compat` once, every local check measures against what GIRAFE really runs
  (`kit/plugins.js` `rules()`, from `kit/compat.js` `known()`), not against `GIRAFE_VERSION` in
  `kit/version.js`. An out-of-date kit no longer invents errors a newer GIRAFE wouldn't have.
- **Only what the kit itself cannot do is an error; the rest is a warning.** A `hostApi` this kit
  can't run still stops the node (nothing here could run it). But a `"girafe": ">=…"` newer than
  yours, a field type, capability or key service the kit has never heard of, and a `hostApi` newer
  than your GIRAFE are now shown under "Worth knowing" and the node still runs and can still be
  sent - GIRAFE itself has the last word. You can build a node before the GIRAFE that will take it
  exists.
- **Sending raises the version for you.** GIRAFE accepts each version once; when it already holds
  the one in your `manifest.json`, the kit raises the number (only the number - your formatting and
  comments stay) and sends again, and says it did.

**The button** sits in Settings, in "Versions and updates", and on a node whose send was refused:
it asks GIRAFE what it runs, re-checks every node against that answer, tells you whether a newer
kit is out, and can send the node you were last editing in the same go. Nothing in a manifest is
ever rewritten to make a check pass: a node that truly needs a newer GIRAFE waits for one, and the
dialog says so plainly.

## 0.12.0 (2026-11-11)

**Tasks fields: pick tasks you already ran at a service.** A new field type, `tasks` (host API 2,
see HOST_API.md › Tasks fields), shows a drop-down of task types and a list of that type's tasks,
loaded from the service's history with the node's key or from the history file the service lets you
export. The node gets the chosen task ids. Built for the 3D (Tripo) pack's 3D Model node, which
fetches your existing Tripo models without paying again. Billing `history` entries can now page with
a cursor (`next`, `cursorParam`), as Tripo's does. The kit now simulates **GIRAFE 0.91.0**: a node
with a tasks field should say `"girafe": ">=0.91.0"`.

## 0.11.2 (2026-11-11)

**A pasted key keeps working when it starts with "Bearer ".** A key copied from a code sample
(`Bearer tsk_…`) used to be saved with that word, and the kit then sent `Bearer Bearer tsk_…`, which
the service refused. The word is now dropped when the key is pasted (paste such a key again). Test
runs can also point Tripo's second address, `openapi.tripo3d.com`, at a fake server
(`KIT_TRIPO_COM_URL`). Same host API, same simulated GIRAFE.

## 0.11.1 (2026-11-11)

**Telling a refused key from a wrong key.** When a service answers "no" to a key, the Network list
(🔑 Keys › Network) now shows the status it answered with, so `sent (service said no) · 401` reads
as "the service refused this key" rather than just "no". And in a plugin node's **As in GIRAFE**
panel, a key saved for another service is marked `⚠ not a <service> key` in the key list - the kit's
keys carry a service and the host refuses a key of another one, which GIRAFE's own Key bank doesn't
track. Nothing else changed: same host API, same simulated GIRAFE.

## 0.11.0 (2026-11-11)

**A plugin node's panel now shows what GIRAFE will show.** Select a plugin node: the panel has two
tabs.

- **🦒 As in GIRAFE** (the default): the panel the node will have in GIRAFE's Promptmixer, with
  GIRAFE's own look. Same fields in the same order and the same words: title, Run from here, the
  description with pack and version, the key picker (every saved key, as in GIRAFE's Key bank), the
  fields of your manifest (text, number, select, checkbox, textarea, file), the "It may" line, On
  the phone, then the status and what came out ("📷 2 images in this output", or the text cut at
  2,000 characters, exactly as GIRAFE does), and Delete node.
- A node with `"display": "runs"` shows GIRAFE's result list: Latest on top, earlier runs under a
  dashed line, pictures in a grid, and **3D models in GIRAFE's own 3D viewer**: they turn, their
  animation plays, several moves play one after the other with a chip each, and the Look select
  (Natural, Matte, Clay, Studio, Bright) lights them as GIRAFE does. One live viewer at a time; the
  other runs are tiles with "Show it in 3D".
- **🛠 Kit tools**: the kit's own panel, unchanged (manifest, problems, packaging, sending to GIRAFE
  and the market).

What you set in one tab is set in the other: both work on the same node.

One difference is written in the panel: "Run from here" runs the whole graph in the kit.

The 3D viewer is the file GIRAFE itself serves (model-viewer 4.4.0, Apache 2.0), kept inside the
kit: nothing is loaded from the internet. It needs WebAssembly to unpack compressed models, so the
page's policy now allows that (and nothing else new).

## 0.10.1 (2026-11-11)

Security fixes for the sandbox plugin nodes run in (same changes on GIRAFE's server).

- **`import()` no longer gets around the network block.** `require('net')` was refused but
  `await import('node:net')` was not: a node could reach the network, and the kit's own local
  page, without `ctx.http`. Now the network functions themselves are unusable inside a node
  (connections, servers, UDP, DNS), however the module is reached, and `import()` of a blocked
  module is refused where Node allows hooking it (22.15+).
- **No `eval` / `new Function` in a node** (`--disallow-code-generation-from-strings`).
  **For plugin authors:** if your node used them, write the code out instead.
- **Limits on what a node sends back:** one value 5 MB at most (send big results as files with
  `ctx.files.write`), 40 MB per firing. On Linux a node using more than 768 MB of real memory
  (Buffers included) is stopped.
- Host calls are only the real ones (a made-up call name no longer reaches an inherited method).

## 0.10.0 (2026-11-10)

- **The kit asks you to sign in with your GIRAFE account** before it does anything. One Allow on
  girafe.live, and you say whose computer it is:
  - **This is my computer**: you stay signed in; closing the page leaves the kit ready.
  - **Not my computer** (a café, a friend's): when the kit's page is closed for 5 minutes, your
    nodes are saved to GitHub, the kit signs out and erases everything of yours from that computer.
    A node GitHub doesn't hold is never erased by itself: the kit keeps it and tells you.
- **🚪 Leave** in the top bar: keep the kit ready, or sign out and erase your work (saved to GitHub first).
- A link cut from GIRAFE › Settings › Connected kits signs the kit out at its next check.
- An already linked kit stays signed in, as "my computer".

## 0.9.0 (2026-11-10)

- **Your work now lives outside the kit**, in `GIRAFE kit workspace` in your home folder: nodes, test
  graphs, keys, the GitHub link and the key that signs your nodes. Every copy of the kit uses it, so
  an update, a new download or a second copy never loses anything again.
- The first start moves the kit's old `workspace/` folder there by itself (the old folder is left
  as it was, with a note). If another kit folder in Downloads, Desktop or Documents still holds work,
  the kit offers to **bring it here** in one click; nothing is overwritten or deleted.
- The palette shows where your nodes are.
- **🛒 Market is now where you publish**: it lists your nodes and packs, where each stands on the
  market and the next step (Submit, Edit its market page, See it). Disconnecting is a small "Use another
  market account" link with a confirmation, no longer the only button.
- **No more `market/` folder to prepare**: pictures, videos, texts and the tile background are set in
  the market's page editor, which opens after you submit. An existing `market/` folder still works.

## 0.8.0 (2026-11-10)

- **Publish on the GIRAFE Market**: 🛒 Market in the top bar links the kit to a market account (same
  one-click device link as GIRAFE), and "Submit to the market" under a node or a pack sends it for
  review. Every version is reviewed by a market admin before anyone can install it.
- **A market page for your node**: put pictures, up to two short videos, a `cover.png` (the tile's
  background) and a `listing.json` (one line, description, tags, captions, French/Vietnamese texts)
  in a `market/` folder inside the node's or the pack's folder. `market/` is never packed: GIRAFE
  only gets the node. Nothing changes for nodes without it.
- The GIRAFE giraffe logo replaces the 🦒 in the top bar.

## 0.7.0 (2026-11-07)

- **Billing**: a node or pack that pays an outside service declares it in `"billing"` (unit, default
  price, and optionally how to read the credits left, the usage history and its CSV export), and
  reports each run's spend with `ctx.usage({ service, units, taskId })`. GIRAFE 0.73.0 files it in AI
  reports and Settings › Usage. The kit checks the declaration and each report (💲 line in the log),
  and refuses to send `billing` to an older GIRAFE. See HOST_API.md, *Billing*.
- The kit simulates GIRAFE 0.73.0.

## 0.6.0 (2026-11-07)

- **Packs**: nodes made for one use go in a pack (a folder with only `pack.json`, see HOST_API.md).
  The palette shows them under the pack's title, the pack has one key for all its nodes, and it is
  packed (`.gpack`) and sent to GIRAFE as one. A node in a pack can't be sent alone. Needs GIRAFE
  0.70.0. Nothing changes for nodes that are not in a pack.
- The kit simulates GIRAFE 0.70.0.

## 0.5.5 (2026-11-07)

- Host API 2 is live: GIRAFE 0.69.0 runs it, so nodes written for it can be sent.

## 0.5.4 (2026-11-07)

- Host API 2 (draft) gains `"streams": true`: a node that may send several packets per firing
  with `ctx.emit` says so in its manifest. GIRAFE plans a run before it starts and needs it to send
  every packet on; the kit accepts it. Add it to any node of yours that emits more than once.

## 0.5.3 (2026-11-07)

- The GitHub button, menus and dialogs show GitHub's own mark instead of the octopus emoji.

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
