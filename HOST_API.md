# Host API 2

The contract between GIRAFE and a plugin node. The kit implements the same contract
as GIRAFE, so a node that works here works there. The plugin never touches GIRAFE's
database, files or keys; everything goes through `ctx`.

> **Status: live in GIRAFE 0.69.0.** Host API 2 added long runs (`limits`), `ctx.state`,
> `ctx.files.fromUrl`, `ctx.http` forms, `"*.host"` network entries, the `tripo` key service,
> `file` fields, nodes with no outputs, `"display": "runs"` and `"streams"`; GIRAFE 0.73.0 added
> `"billing"` and `ctx.usage` (see *Billing*).
> Host API 1 added key slots and `ctx.http`. Nodes written for 0 and 1 still run
> (`SUPPORTED_HOST_APIS` in `kit/version.js`). Additions keep the number; a change
> that breaks existing nodes bumps it, and GIRAFE keeps the previous number running for a while.

## A plugin is a folder

```
workspace/nodes/my-node/
  manifest.json   what the node is and what it needs
  node.js         the code
```

The folder name is the node's id: lowercase letters, digits and dashes.

### Packs (nodes made for one use)

Nodes made to work together for one kind of job (the Tripo 3D chain, say) go in a **pack**: a
folder next to them holding only `pack.json`.

```
workspace/nodes/tripo-pack/pack.json
{ "id": "tripo-pack", "name": "3D (Tripo)", "version": "0.1.0", "description": "Text or a picture to an animated 3D model.",
  "nodes": ["tripo-3d", "tripo-rig", "tripo-animate"],
  "keys": [{ "slot": "tripo", "service": "tripo", "label": "Tripo API key" }] }
```

- `id` = the folder name; `name` (40 characters at most) is the title the nodes are shown under;
  `version` is the pack's own, raised for every send.
- `nodes`: 1 to 32 node ids, each an ordinary node folder; a node is in one pack at most.
- `keys`: the pack's key slots. Every key slot a member declares must be listed here, with the
  same service. The user picks **one key for the whole pack** and every member runs with it (a
  member's own key choice is not used).
- A pack is packed and sent as one (`<id>-<version>.gpack`); its nodes can't be sent alone.
  GIRAFE installs it all at once, keeps its versions together (a rollback moves every node back),
  turns it on and off as one, and shows its nodes under its name. A member whose version didn't
  change is kept as it is; a changed member needs a higher version too.
- Needs GIRAFE 0.70.0 or newer.
- `billing` (optional): what the pack's service costs, see *Billing*. Written once here, it
  applies to every member.

### Billing (what your service costs)

A node that pays an outside service (Tripo bills in credits, an image service per picture...)
declares it, and reports what each run spent. GIRAFE then files the cost in the user's AI reports
and Settings › Usage, with no knowledge of the service of its own. Host API 2, GIRAFE 0.73.0 or
newer (the kit refuses to send it to an older GIRAFE).

`"billing"` goes in `pack.json` (for every member) or in a node's `manifest.json`, one entry per
key service the node pays with (the service must be one of its key slots):

```
"billing": [{
  "service": "tripo", "unit": "credit", "units": "credits", "usdPerUnit": 0.01,
  "balance": { "url": "https://openapi.tripo3d.ai/v3/account/balance", "left": "data.balance", "held": "data.frozen" },
  "history": { "url": "https://openapi.tripo3d.ai/v3/account/usage/history?start_time={start}&end_time={end}&page_size=100&page_num={page}",
               "items": "data.items", "ok": ["success"], "maxDays": 31,
               "fields": { "taskId": "task_id", "units": "credits_consumed", "type": "type", "model": "model_version",
                           "status": "status", "createdAt": "created_at", "completedAt": "completed_at" } },
  "csv": { "taskId": "task_id", "units": "credits", "type": "type", "model": "model_version",
           "status": "status", "createdAt": "create_time", "completedAt": "end_time" }
}]
```

- `unit` / `units`: what the service counts in (singular, plural). `usdPerUnit`: your default price,
  0 to 1000 dollars; each user can type their own in Settings › Usage.
- `balance` (optional): a GET GIRAFE makes with the user's key to show the units left. `left` and
  `held` are dot paths into the JSON answer.
- `history` (optional): a GET listing past tasks, so earlier costs can be added to AI reports.
  `{start}` / `{end}` (ISO dates) and `{page}` (1, 2...; GIRAFE stops at an empty page) are filled
  in. `items` is the dot path to the list; `fields` says where each task's id, units, type, model,
  status and dates are (`taskId` and `units` required). A status not in `ok` (default `success`,
  `done`, `completed`) with no units counts as failed. `maxDays`: how far back the service goes.
- `csv` (optional): the column names of the history file the service lets you export, for the
  same import by file.
- `balance` and `history` addresses must be https and on the service's own hosts: the user's key
  is sent there, the same way as `ctx.http` with that key slot.

In `node.js`, once you know what a task cost (usually when it finishes):

```
await ctx.usage({ service: 'tripo', units: task.credits_consumed, taskId, type: 'animate_rig' });
```

`taskId` (4 to 100 of `A-Z a-z 0-9 . _ : -`) makes it one row per task: report the same task twice
and the row is updated, and the history import recognises it. `type` (the service's own name for
the kind of task, as in its history), `label`, `model` and `failed: true` are optional. It returns
`{ recorded, usd }`. Report nothing for a task served from your own cache (no new spend). A GIRAFE
older than 0.73.0 has no `ctx.usage`: write `if (ctx.usage) await ctx.usage(...)` if your node may
run there. The kit checks each report and shows it in the node's log (💲 line).

## manifest.json

```json
{
  "id": "my-node",
  "name": "My node",
  "version": "0.1.0",
  "description": "One sentence a user reads in the palette.",
  "category": "Text tools",
  "hostApi": 1,
  "girafe": ">=0.67.0",
  "icon": "🔠",
  "color": "#7bd389",
  "inputs": { "min": 1, "max": 2 },
  "outputs": ["out"],
  "limits": { "seconds": 600 },
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
| `hostApi` | The host API your code is written for: 2 (1 and 0 still run, without what came later). |
| `girafe` | The oldest GIRAFE you need, as `>=x.y.z`. |
| `category` | Optional. The section the node is listed under in GIRAFE's palette ("Your plugin nodes" › this name), 40 characters at most. Nodes with the same category sit together. |
| `inputs` | `min` / `max` input sockets. With `min: 1` the node is skipped when nothing arrives. `max: 0` = a starting node. |
| `outputs` | Output socket names. `["out"]` for one; `["yes", "no"]` for named exits. Host API 2: `[]` = a node that sends nothing on (it keeps or shows what reaches it); what `run` returns is shown on the node. |
| `fields` | The panel. Types: `text`, `textarea`, `number`, `select` (with `options`: `["a","b"]` or `[["value","Label"]]`), `checkbox`, and (host API 2) `file` (with optional `accept`, like `".glb,.fbx"`, and `multiple: true`). Optional `default`, `placeholder`. A `file` field's value is a file reference (a list with `multiple`), readable with `ctx.files.read` like a file that arrived on an input. Files: pictures (PNG, JPEG, WebP, GIF, 25 MB) and 3D models (GLB, FBX, OBJ, STL, 150 MB). |
| `streams` | Host API 2. `true` when one firing may send several packets with `ctx.emit` (one per item). GIRAFE plans a run before it starts, so it must know: without it, the next node gets only the last packet when it also takes a single value. Leave it out for a node that sends one value per firing. |
| `display` | Host API 2. `"runs"`: the host keeps what the node sent (or, with `"outputs": []`, returned) over its last 10 runs and shows them in its panel, newest first, pictures and 3D models included. In GIRAFE this is the Result stack's view (also on the phone). |
| `limits` | Host API 2. `{ "seconds": n }`: how long one firing may run, 1 to 3600 (default 60). For a node that waits on a slow service; Stop still ends it at once. |
| `capabilities` | What the node may do beyond pure computing. Anything not declared is refused. |

### Capabilities (host API 0)

| Capability | Gives |
|---|---|
| `"files": "read"` | `ctx.files.read(ref)`: the bytes of a picture or file that arrived on an input. |
| `"files": "readwrite"` | Also `ctx.files.write(bytes, mime, name)`: make a new file and send its reference on. |

| `"network": ["api.example.com"]` | `ctx.http` and `ctx.files.fromUrl` to these hosts (https only). Nothing else on the internet. Host API 2: `"*.example.com"` = any host under example.com (for a service's download servers). |
| `"state": true` | Host API 2. `ctx.state`: a small object kept for this node on the canvas, across runs. |
| `"keys": [{ "slot": "gemini", "service": "gemini", "label": "Gemini API key" }]` | A key slot. The user picks which of their keys fills it in the node's panel; `ctx.http({ slot: "gemini", ... })` sends with that key added by the host. **Your code never sees the key.** Services: `anthropic`, `openai`, `gemini`, and (host API 2) `tripo`; the service's API host must be in `network`. |

Coming later, declared the same way: `"ai": true` (`ctx.ai.ask`), and more key services.

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
| `await ctx.emit(port, value)` | Send one packet now. Call it several times and the node becomes a stream: everything after it runs once per packet (like For each). Say so with `"streams": true` in the manifest (host API 2). |
| `await ctx.progress(text)` | A short status line under the node while it runs. |
| `await ctx.log(...)` | A line in the node's log (panel › Last run › Log). `console.log` also lands there. |
| `ctx.isFile(v)` | `true` when `v` is a file reference. |
| `await ctx.files.read(ref)` | `{ bytes: Buffer, mime }`. Needs `files: "read"`. |
| `await ctx.files.write(bytes, mime, name)` | Returns a reference to send on. Needs `files: "readwrite"`. 25 MB max. |
| `await ctx.files.fromUrl(url, { name?, mime? })` | Host API 2. The host downloads the file (https, a host in `network`, no key sent, 200 MB, 20 min) and gives you its reference. For results too big to pass through your node's memory. Needs `files: "readwrite"`. |
| `await ctx.state.get()` / `await ctx.state.set(obj)` | Host API 2. An object kept for this node on the canvas, across runs and restarts (256 KB). `set` saves at once: write down what you're waiting on (a task id) *before* waiting, so a Stop or a restart doesn't lose it. Keep file references there, never file contents. Needs `"state": true`. |
| `await ctx.usage({ service, units, taskId?, type?, label?, model?, failed? })` | What this run spent at a service your package's `billing` describes. GIRAFE files it in AI reports and Settings › Usage. Returns `{ recorded, usd }`. See *Billing*. |
| `await ctx.http({ slot?, method, url, headers?, json?, body?, form? })` | `{ status, ok, json, text }` (`json` when the answer is JSON, else `text`). https only, to a host in `network`. With `slot`, the host adds that key's login header. Login headers (`authorization`, `x-api-key`, `x-goog-api-key`…) can't be set by the node. 40 MB each way, 120 s. Sent through the kit's network guard and listed in 🔑 Keys > Network. Host API 2: `form: { field: "text", file: { file: ref, name? } }` sends a multipart form; a file is read by the host from a reference that arrived on an input. |

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
- Output sockets: a node with one output shows one lettered socket per wire (A, B…) plus an
  empty one; they all carry the same output. Named outputs (`["yes", "no"]`) each have their own.
- The square **flow socket** (on every node): when something is wired into it, the node runs only
  if a packet arrives there (typically from a Yes / No exit). Left empty, it is ignored.
- **Collect** waits for the whole stream and sends one JSON list.
- A node whose wired inputs all stayed empty is **skipped**, and so is what comes after it.
- An error stops that node only; its branch is skipped, the rest of the graph goes on.

## The sandbox

Each firing runs in its own process, with:

- read access to **its own folder only**; no writing to disk; no starting processes;
- **no environment variables** (no keys, no paths);
- 128 MB of memory and 60 seconds per firing (host API 2: up to an hour with `limits`);
- `require` of Node's built-in modules works, as long as they stay inside these limits.
  Bundle any npm package you need into your folder (GIRAFE installs nothing for you).

**The network:** `ctx.http` is the only way out. Inside the node's process, `fetch` is gone and
`http`, `https`, `net`, `tls`, `dns`, `child_process`, `worker_threads`, `module`, `vm` and the
like can't be loaded. Native add-ons and bindings are refused by Node's permission flags.

A full example using a key slot: `workspace/nodes/gemini-image/`.

### Files your node makes

A file reference can carry extra fields: they travel with it. A 3D model is a reference with a
`model/…` mime (`model/gltf-binary` for GLB) and, by convention, `preview`: the reference of a
picture of it, which GIRAFE and the kit show in place of the model.

## Sandbox limits (kit 0.10.1, GIRAFE 0.90.5)

- No `eval` and no `new Function` in a node: the process runs with code generation from strings off.
- No network module by any route (`require`, `import()`, `process.getBuiltinModule`): `ctx.http`
  and `ctx.files.fromUrl` are the only ways out, to the hosts the manifest declares.
- One value sent on (`ctx.emit` or a returned value) is 5 MB at most, 40 MB per firing. Send big
  results as files (`ctx.files.write`, 25 MB each, or `ctx.files.fromUrl`).
- Real memory, Buffers included, is watched on Linux: a node past 768 MB is stopped.
