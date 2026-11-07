# Instructions for an AI building a GIRAFE node

These are the rules your AI assistant follows when it writes a node in this kit. They are
plain text on purpose: read them, change them if you disagree.

## What you are building

A plugin node for GIRAFE's graph editor: a folder in `workspace/nodes/<id>/` with
`manifest.json` and `node.js`, following `HOST_API.md` exactly. Read `HOST_API.md` first.
Start from a copy of `workspace/nodes/example-upper/`.

## Rules

1. **Only `ctx`.** Everything the node needs from outside goes through `ctx`. Don't read
   or write files with `fs`, don't read `process.env`, don't start processes, don't use
   `fetch` or `https`: the sandbox refuses it, and GIRAFE will too. The internet is `ctx.http`.
2. **Declare what you use.** Every capability in `manifest.json` › `capabilities`, nothing
   more. Ask before adding one; say why it's needed.
3. **No secrets in code.** Never write an API key, token or password in any file. A node
   that needs a service declares a key slot and calls it with `ctx.http({ slot, ... })`; the
   user picks their key in the panel and the host adds it. See `workspace/nodes/gemini-image/`.
4. **No dependencies to install.** Use Node's built-in modules. If a library is
   unavoidable, copy a single-file build into the node's folder and say so.
5. **Plain values.** Return text, numbers, lists or objects; files only as references from
   `ctx.files.write`. Never put file bytes or data URLs in a value.
6. **Clear errors.** Throw `new Error('…')` with a sentence a user understands
   ("Add a picture on A first.", not "undefined is not a function").
7. **Small firings.** One firing should finish in seconds. For lists, either take the
   whole list at once or `ctx.emit` one packet per item; say which in the description.
8. **Versions.** Use the `hostApi` that `/api/info` reports (2 today; use 1 if the node needs none of what 2 added, so older GIRAFE versions can run it). Bump the node's own
   `version` when its behaviour changes: patch for fixes, minor for new settings, major
   when old graphs would behave differently.
9. **The panel is the manifest.** Settings are `fields`; keep labels short and plain.
   Give every field a sensible `default`.
10. **Test it in the kit** before saying it works: build a small graph (Input → your node →
    Collect), run it, read the node's note and log. If the node takes a list, test it after
    a For each too. Add or update a test in `test/` when you change the kit itself.

## Running the kit

```
node kit.js          # opens http://localhost:4747
npm test             # the kit's own tests
```

Changes to `node.js` and `manifest.json` are picked up on the next run (the palette
refreshes when the page regains focus, or with ↻).
