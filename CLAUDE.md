# CLAUDE.md

This repo is the GIRAFE node kit: a local simulator for building GIRAFE plugin nodes.

- Building or changing a **plugin node**: follow `AI-INSTRUCTIONS.md` and `HOST_API.md`. Nodes live in `workspace/nodes/<id>/`.
- Changing the **kit itself** (`kit/`, `web/`):
  - zero dependencies: Node built-ins only, no build step for the web page (plain ES modules);
  - nothing stored outside `workspace/` (graphs in `workspace/graphs/`, files in `workspace/.kit/files/`);
  - the server listens on 127.0.0.1 only and refuses other hosts and cross-site writes;
  - core nodes must behave like GIRAFE's real ones (see the engine rules at the top of `kit/engine.js`);
  - a change to what plugins can do = a change to `HOST_API.md`, and to `kit/version.js` + `CHANGELOG.md` when it breaks existing nodes;
  - run `npm test` and check the page in a browser before calling it done.
- `kit/version.js` holds the simulated GIRAFE version and the host API number. When GIRAFE moves on, update them and note it in `CHANGELOG.md`.
