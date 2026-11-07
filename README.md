# GIRAFE node kit

Build nodes for [GIRAFE](https://girafe.live)'s graph editor on your own machine. The kit
is a small copy of GIRAFE's canvas with its core nodes, so you can wire your node between
real ones, run the graph and see what happens, with nothing sent anywhere.

## Start

1. Download the kit: **[girafe-node-kit (latest release)](https://github.com/shanghalf/girafe-node-kit/archive/refs/heads/release.zip)**, and unzip it anywhere.
2. Double-click the starter for your computer:
   - Windows: **Start GIRAFE kit (Windows).cmd**
   - Mac: **Start GIRAFE kit (Mac).command** (the first time, right-click it and choose **Open**, because it isn't from the App Store)
3. Your browser opens on the kit with an example graph. Press **Run**.

The first start downloads a private copy of Node.js (about 30 MB) into the kit's folder and
checks it against nodejs.org's published checksum. If your computer already has Node 22 or
newer, it uses that instead. Nothing is installed on the computer: everything the kit keeps
is in its folder. Keep the small window open while you use the kit; close it to stop. To
remove the kit, delete the folder.

Developers: `node kit.js` does the same with your own Node 22+.

## Make a node

1. Copy `workspace/nodes/example-upper` to `workspace/nodes/my-node`.
2. In `manifest.json`, set `"id": "my-node"` and a name.
3. Edit `node.js`.
4. Your node appears under **Your nodes**. Wire it, run, read its note and log in the panel.

Working with an AI assistant? Point it at `AI-INSTRUCTIONS.md`; `HOST_API.md` is the full
contract. How the kit works inside, keys included: `docs.html` (open it, or 📖 Docs in the kit).

## Keep your nodes on GitHub

**GitHub** at the top saves your nodes to a private repo of yours: every save is a version you
can go back to, and your other computer can get them. You make an empty private repo and a token
for that repo only (the kit shows you how), and paste the token once in **🔑 Keys**. A node with
changes not saved pulses under **Your nodes**; right-click it to save, see your changes, get
GitHub's version or go back in its history. Only your node folders are uploaded, never your keys.

## Keys (Prompt and Generate image)

The **Prompt** node asks Anthropic, OpenAI or Gemini; **Generate image** uses Google Gemini.
They need your own API key: **🔑 Keys** at the top, paste it, save.

- The key goes once from the page to the kit on your computer, and is saved encrypted in
  `workspace/.kit/`. The page shows only a masked form afterwards and can't contact anything
  but the kit (it is locked to it).
- When a node runs, the key is used for that one call, sent only to its own service's address,
  in its login header. The kit's network guard refuses anything else before it leaves.
- **🔑 Keys > Network** lists every request the kit has sent to the internet, which key went
  where, and anything blocked or sent outside the guard (there should be none).
- The same request twice gives the saved answer or picture, with no new call and no cost.
- Nodes you build as plugins never see keys.

## Share a node

In a plugin node's panel:
- **📦 Pack** makes a signed `.gnode` file of it.
- **☁️ Send to my GIRAFE** puts it in your GIRAFE account, where it works on all your devices and
  only you see it. The first time, **Connect to GIRAFE** opens girafe.live: log in (or create an
  account) there and click Allow. The kit never sees your password, and works fine unconnected.

Nodes made to work together (a 3D chain, say) can form a **pack**: a folder with a `pack.json`
listing them (see HOST_API.md). They show under the pack's title, share one key, and are sent to
GIRAFE together with **☁️ Send the pack**.

## Updates

The kit and GIRAFE check each other's version. When they don't match, a button at the top says
so (⛔ the kit is too old for GIRAFE, ⚠️ GIRAFE doesn't run this kind of node yet, ⬆ a newer kit).
**🔄 Versions and updates → ⬆ Update the kit** downloads the new version, keeps a copy of the old
one, restarts and goes back by itself if the new one doesn't start. Your nodes, graphs and keys
(`workspace/`) are never touched. A git clone is updated with `git pull`.

## What's inside

| | |
|---|---|
| Canvas | Drag nodes, drag from an output dot to wire, right-click to add, Delete to remove, Ctrl+Z to undo, wheel to zoom. |
| Core nodes | Input, Image, For each, Yes / No, Collect: they behave like GIRAFE's. |
| Your nodes | Each firing runs in its own sandboxed process: its own folder only, no disk writes, no environment, 128 MB, 60 s. |
| Versions | The badge shows the GIRAFE version the kit simulates and the host API number; click it to compare with your GIRAFE and update the kit. Your manifest names both. |

## Not yet

Asking GIRAFE's own AI from a node (`ctx.ai`), and a 3D viewer in the kit's panel (models show
by their preview picture and download link for now).

## Branches

- `release`: the version people download. Each release is tagged (`v0.1.0`, ...) and listed in `CHANGELOG.md`.
- `main`: work in progress. It may be broken at times; use `release` unless you're testing what's next.
