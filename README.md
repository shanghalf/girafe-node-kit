# GIRAFE node kit

Build nodes for [GIRAFE](https://girafe.live)'s graph editor on your own machine. The kit
is a small copy of GIRAFE's canvas with its core nodes, so you can wire your node between
real ones, run the graph and see what happens, with nothing sent anywhere.

## Start

1. Download the kit: **[girafe-node-kit (latest release)](https://github.com/shanghalf/girafe-node-kit/archive/refs/heads/release.zip)**, and unzip it anywhere.
2. Double-click the starter for your computer:
   - Windows: **Start GIRAFE kit (Windows).cmd**
   - Mac: **Start GIRAFE kit (Mac).command** (the first time, right-click it and choose **Open**, because it isn't from the App Store)
3. Your browser opens on the kit. **Sign in with your GIRAFE account** (one Allow on girafe.live)
   and say whose computer it is. Then press **Run** on the example graph.

**It only has to be found once.** That first start copies the kit into one place -
`C:\Users\<you>\GIRAFE kit`, `/Users/<you>/GIRAFE kit`, `~/GIRAFE kit` - puts a **GIRAFE kit**
shortcut on your desktop, and runs from there. Start it from the shortcut afterwards; the folder
you unzipped can be deleted. In 🔗 Chain you can also have it **start with the computer**, so it is
simply always there. (A `git clone` is left exactly where it is.)

The first start downloads a private copy of Node.js (about 30 MB) into the kit's folder and
checks it against nodejs.org's published checksum. If your computer already has Node 22 or
newer, it uses that instead. Nothing is installed on the computer. Keep the small window open
while you use the kit; close it to stop. To remove the kit, delete its folder - your nodes and
keys are not in it (see below).

Developers: `node kit.js` does the same with your own Node 22+.

## Signing in, and leaving a computer

The kit runs on any computer, but does nothing until you sign in with your GIRAFE account. The kit
never sees your password: it opens girafe.live, where you click Allow.

- **This is my computer**: you stay signed in, like a browser. Closing the page leaves it ready.
- **Not my computer** (a café, a friend's): when the kit's page has been closed for 5 minutes, your
  nodes are saved to GitHub, the kit signs out and erases everything of yours from that computer. A
  node GitHub doesn't hold is never erased by itself: the kit keeps it and tells you next time.
- **🚪 Leave** in the top bar, at any time: keep it ready, or sign out and erase your work.
- Forgot a kit somewhere? GIRAFE › Settings › Connected kits cuts it; it signs out at its next check.

## Where your work is kept

Your nodes, test graphs, keys, the GitHub link and the key that signs your nodes live in one folder
in your home, **outside the kit's own folder**:

- Windows: `C:\Users\<you>\GIRAFE kit workspace`
- Mac: `/Users/<you>/GIRAFE kit workspace`

Every copy of the kit on your computer opens that same folder, so updating the kit, downloading it
again or unzipping it somewhere else never loses anything. Kits before 0.9.0 kept this inside their
own `workspace/` folder: the first start of 0.9.0 copies it home by itself, and if it finds another
kit folder with work in Downloads, Desktop or Documents it offers to bring it in (nothing is
overwritten, nothing is deleted). Back this folder up like any of your documents.

## Make a node

1. In your workspace, copy `nodes/example-upper` to `nodes/my-node`.
2. In `manifest.json`, set `"id": "my-node"` and a name.
3. Edit `node.js`.
4. Your node appears under **Your nodes**. Wire it, run, read its note and log in the panel.

Working with an AI assistant? Point it at `AI-INSTRUCTIONS.md`; `HOST_API.md` is the full
contract. How the kit works inside, keys included: `docs.html` (open it, or 📖 Docs in the kit).

## Keep your nodes on GitHub

🔗 **Chain** saves your nodes to a private repo of yours: every save is a version you can go back
to, and your other computer can get them. You make an empty private repo and a token for that repo
only (the kit shows you how), and paste the token once in **🔑 Keys**. A node with changes not
saved pulses under **Your nodes**; right-click it to save, see your changes, get GitHub's version
or go back in its history. Only your node folders are uploaded, never your keys.

**Set it up once, for every computer.** In GIRAFE, Settings › Node kit, name your repository, and
in the Key bank tick **give it to my kits** on your GitHub key. Every kit you link afterwards is
handed both when it says hello, connects itself to the repository and shows you the nodes waiting
on GitHub - nothing to paste again. The key is handed to a kit once, the first time it links.

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

## Ship a node

One button puts a node where it belongs. In a plugin node's **🛠 Kit tools** tab - or from
**🔗 Chain → What you have built** - the **🚀 Ship** card shows the three places it lives and
where each one stands:

| | |
|---|---|
| **GitHub** | your own repository of nodes, so they survive this computer |
| **GIRAFE** | your account, where the node works on all your devices and only you see it |
| **Market** | everyone, if you want to publish it |

Tick the ones you want, write what changed, press **🚀 Ship**. The kit works the version number
out for you: nothing rises unless it has to, and a place that already holds this number with
*different* files forces the smallest rise - two different things can't both be 1.2.0. In a pack,
only the members whose files actually changed move. What you write goes into the node's
`CHANGELOG.md`, onto the "new / updated" badge in GIRAFE and into the version history on the
market, so a version always says why it exists. The three steps run in order and stop at the
first failure, with its name. **📦 Just the file** still makes the signed `.gnode`/`.gpack` on
its own.

Nodes made to work together (a 3D chain, say) can form a **pack**: a folder with a `pack.json`
listing them (see HOST_API.md). They show under the pack's title, share one key, and ship as one.

Publishing needs a market account, connected once (**🔗 Chain → The market**; when your GIRAFE
and the market know each other, your GIRAFE vouches for the kit and there is nothing to approve
twice). Pictures, videos and texts are added on the market itself, in the page editor the card
links to after a submission; a new version starts with the page of the one before. The first
version of anything is reviewed by an admin; after that, a publisher the market trusts goes
straight out.

## Updates

The kit and GIRAFE check each other's version. When they don't match, a button at the top says
so (⛔ the kit is too old for GIRAFE, ⚠️ GIRAFE doesn't run this kind of node yet, ⬆ a newer kit).
**🔄 Versions and updates → ⬆ Update the kit** downloads the new version, keeps a copy of the old
one, restarts and goes back by itself if the new one doesn't start. Your workspace (nodes, graphs,
keys) is outside the kit and never touched. A git clone is updated with `git pull`.

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
