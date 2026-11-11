# CLAUDE.md

This repo is the GIRAFE node kit: a local simulator for building GIRAFE plugin nodes.

- Building or changing a **plugin node**: follow `AI-INSTRUCTIONS.md` and `HOST_API.md`. Nodes live in `workspace/nodes/<id>/`.
- Changing the **kit itself** (`kit/`, `web/`):
  - zero dependencies: Node built-ins only, no build step for the web page (plain ES modules);
  - nothing stored outside the workspace: `~/GIRAFE kit workspace` (`kit/home.js`), outside the kit's own folder so updates and new downloads never lose it. Always go through `store.ROOT`, never `<kit>/workspace` (that holds only the shipped nodes). Users must never lose work, whatever they do: no step may delete or overwrite their nodes, keys or signing key (the one exception is "Sign out and erase", see Signing in below);
  - the server listens on 127.0.0.1 only and refuses other hosts and cross-site writes;
  - core nodes must behave like GIRAFE's real ones (see the engine rules at the top of `kit/engine.js`);
  - a change to what plugins can do = a change to `HOST_API.md`, and to `kit/version.js` + `CHANGELOG.md` when it breaks existing nodes;
  - run `npm test` and check the page in a browser before calling it done.
- Signing in (`kit/session.js`): every `/api/` route but info/compat/update/session answers 401 until the kit is linked to GIRAFE. The regular check is `POST /api/kit/hello` (a 404 falls back to the old `GET /api/kit/me`): it carries `session.chainReport()` - hostname, port, kit version, host API, the GitHub repo and how much of it is unsaved, the market, and every pack/node here with its version and package hash. **Never put a key, a path or a node's contents in it**, and never read the network to build it. Erasing (Leave, or idle on a "not my computer" kit) never removes a node GitHub doesn't hold unless the person forces it by name. Tests that start the server set `GIRAFE_KIT_NO_SIGNIN=1` or sign in against a fake GIRAFE.
- Keys (`kit/keys.js`): a key is in plain text only when pasted and in memory for one call to its own service. Never decrypt to list or show; never log a key; never pass one to a plugin.
- Every request the kit sends to the internet goes through `netguard.send()` (`kit/netguard.js`), never a bare `fetch`. A new service = its official hosts and login header in `OFFICIAL` / `AUTH_HEADER`.
- The page keeps its Content-Security-Policy (`kit/server.js` `CSP`): it loads and contacts only the kit. No CDN, no outside script or font.
- `web/girafe-panel.js` + `web/girafe-panel.css` are the "As in GIRAFE" tab of a plugin node's panel: a faithful copy of GIRAFE's own panel for plugin nodes (GIRAFE `frontend/src/PromptMixerView.jsx` `renderPluginFields` and the node inspector around it, `PhoneModel.jsx`, `viewerLook.js`, the `pm-*` / `phone-*` rules of `App.css`), with GIRAFE's 3D viewer in `web/vendor/`. Same fields, order and words. When GIRAFE's panel changes, change these with it; a kit-only difference is said in a `.kit-note` line, never silently.
- `docs.html` (repo root, also served at `/docs`) is the technical documentation: any change to architecture, routes, engine rules, sandbox, keys or network guard updates it in the same commit, with its date.
- Versions both ways (`kit/compat.js`, `kit/updater.js`, `docs.html#compat`): every call to GIRAFE sends `X-Girafe-Kit-Version`; GIRAFE's `KIT_MIN` (server/plugins/manifest.js in GIRAFE) refuses older kits. `kit.js` stays a small watcher (restart on exit 75, roll back when the new kit stops before `updater.confirm()`); keep `workspace/.kit/update/pending.json`'s shape compatible, since an older watcher reads it. An update never touches `workspace/`, `.runtime/`, `.git/`, `node_modules/` (nor the home workspace).
- `kit/version.js` holds the simulated GIRAFE version and the host API number. When GIRAFE moves on, update them and note it in `CHANGELOG.md`.

## Branches and releases

- `main` is development: commit and push there directly.
- `release` is what users download (the README links its ZIP). Never commit to it directly.
- To ship a version: set `KIT_VERSION` in `kit/version.js` and `version` in `package.json`, add the `CHANGELOG.md` entry, commit on `main`, then fast-forward `release` to that commit and tag it `vX.Y.Z` (both pushed).
- Don't edit `workspace/nodes/example-upper` lightly: people copy it, and edits there conflict with their pulls.
