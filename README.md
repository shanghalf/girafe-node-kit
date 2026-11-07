# GIRAFE node kit

Build nodes for [GIRAFE](https://girafe.live)'s graph editor on your own machine. The kit
is a small copy of GIRAFE's canvas with its core nodes, so you can wire your node between
real ones, run the graph and see what happens, with nothing sent anywhere.

## Start

1. Download the kit as a ZIP (on GitHub: **Code › Download ZIP**) and unzip it anywhere.
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
contract.

## What's inside

| | |
|---|---|
| Canvas | Drag nodes, drag from an output dot to wire, right-click to add, Delete to remove, Ctrl+Z to undo, wheel to zoom. |
| Core nodes | Input, Image, For each, Yes / No, Collect: they behave like GIRAFE's. |
| Your nodes | Each firing runs in its own sandboxed process: its own folder only, no disk writes, no environment, 128 MB, 60 s. |
| Versions | The badge shows the GIRAFE version the kit simulates and the host API number. Your manifest names both. |

## Not yet

AI calls, HTTP with key slots, and network limits come in later host API versions
(see `CHANGELOG.md`).
