# Host API 0

The contract between GIRAFE and a plugin node. The kit implements the same contract
as GIRAFE, so a node that works here works there. The plugin never touches GIRAFE's
database, files or keys; everything goes through `ctx`.

> **Status: draft.** Host API 0 is what the kit offers today. It will grow (AI calls,
> HTTP with key slots). Additions keep the number; a change that breaks existing nodes
> bumps it, and GIRAFE keeps running nodes written for the previous number for a while.

## A plugin is a folder

```
workspace/nodes/my-node/
  manifest.json   what the node is and what it needs
  node.js         the code
```

The folder name is the node's id: lowercase letters, digits and dashes.

## manifest.json

```json
{
  "id": "my-node",
  "name": "My node",
  "version": "0.1.0",
  "description": "One sentence a user reads in the palette.",
  "hostApi": 0,
  "girafe": ">=0.67.0",
  "icon": "🔠",
  "color": "#7bd389",
  "inputs": { "min": 1, "max": 2 },
  "outputs": ["out"],
  "fields": [
    { "key": "suffix", "type": "text", "label": "Add at the end", "default": "" }
  ],
  "capabilities": {}
}
```

| Key | Meaning |
|---|---|
| `id` | Same as the folder name. |
| `version` | Your node's version, `major.minor.patch`. |
| `hostApi` | The host API your code is written for. Must equal the GIRAFE's. |
| `girafe` | The oldest GIRAFE you need, as `>=x.y.z`. |
| `inputs` | `min` / `max` input sockets. With `min: 1` the node is skipped when nothing arrives. `max: 0` = a starting node. |
| `outputs` | Output socket names. `["out"]` for one; `["yes", "no"]` for named exits. |
| `fields` | The panel. Types: `text`, `textarea`, `number`, `select` (with `options`: `["a","b"]` or `[["value","Label"]]`), `checkbox`. Optional `default`, `placeholder`. |
| `capabilities` | What the node may do beyond pure computing. Anything not declared is refused. |

### Capabilities (host API 0)

| Capability | Gives |
|---|---|
| `"files": "read"` | `ctx.files.read(ref)`: the bytes of a picture or file that arrived on an input. |
| `"files": "readwrite"` | Also `ctx.files.write(bytes, mime, name)`: make a new file and send its reference on. |

Coming in later versions, declared the same way: `"network": ["api.example.com"]`,
`"keys": [{ "slot": "tripo", "label": "Tripo API key" }]`, `"ai": true`.

## node.js

```js
module.exports = {
  async run(ctx) {
    const text = String(ctx.inputs.A ?? '');
    return text.toUpperCase();
  },
};
```

`run` is called once per firing (see *When a node fires*). Return:

- a value: it goes out of the first output;
- `{ out: value }` / `{ yes: value }`: by output name; a missing or `null` name sends nothing there, and that branch is skipped;
- nothing, if you sent everything with `ctx.emit`.

## ctx

| | |
|---|---|
| `ctx.inputs` | Values by socket letter: `{ A, B, ... }`. Numbers, `true`/`false`, JSON lists and objects come back typed. Files arrive as references. |
| `ctx.raw` | The same values exactly as they travelled (text). |
| `ctx.settings` | The panel fields, with your defaults filled in. |
| `ctx.title` | The node's title on the canvas. |
| `ctx.girafe` | `{ version, hostApi }` of the GIRAFE running you. |
| `await ctx.emit(port, value)` | Send one packet now. Call it several times and the node becomes a stream: everything after it runs once per packet (like For each). |
| `await ctx.progress(text)` | A short status line under the node while it runs. |
| `await ctx.log(...)` | A line in the node's log (panel › Last run › Log). `console.log` also lands there. |
| `ctx.isFile(v)` | `true` when `v` is a file reference. |
| `await ctx.files.read(ref)` | `{ bytes: Buffer, mime }`. Needs `files: "read"`. |
| `await ctx.files.write(bytes, mime, name)` | Returns a reference to send on. Needs `files: "readwrite"`. 25 MB max. |

### Values and files

Between nodes, values are **text** or **file references**:

```json
{ "imageUrl": "/files/3f9a…c1.png", "key": "3f9a…c1.png", "mime": "image/png", "name": "photo.png" }
```

Return objects and lists freely; they travel as JSON text and arrive typed at the next
plugin. Never put file bytes in a value; write a file and send its reference.

## When a node fires

- Input sockets are lettered **A, B, C…** in the order the wires were drawn.
- If an input comes from a **stream** (For each, or any node after one), the node fires
  **once per item**; inputs that are not streams give the same value every time.
- **Collect** waits for the whole stream and sends one JSON list.
- A node whose wired inputs all stayed empty is **skipped**, and so is what comes after it.
- An error stops that node only; its branch is skipped, the rest of the graph goes on.

## The sandbox

Each firing runs in its own process, with:

- read access to **its own folder only**; no writing to disk; no starting processes;
- **no environment variables** (no keys, no paths);
- 128 MB of memory and 60 seconds per firing;
- `require` of Node's built-in modules works, as long as they stay inside these limits.
  Bundle any npm package you need into your folder (GIRAFE installs nothing for you).

Network access is not blocked by the kit yet; on GIRAFE it is limited to the hosts your
manifest declares. Don't rely on anything you didn't declare.
