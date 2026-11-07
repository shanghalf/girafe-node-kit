# Changelog

The kit simulates a given GIRAFE release and host API. When either changes, it's noted here
with what plugin authors need to do.

## Unreleased (on main)

- Nodes now look and behave like GIRAFE's Promptmixer nodes: 220 px cards with the state
  animation, kind label, ⏻ toggle, lettered sockets on both sides, wires coloured by their source
  (green when something went through, grey dashes when nothing did).
- The square flow socket on every node (run only when something reaches it).
- Grab any wired socket to move that wire; drop it on empty canvas to remove it.

## 0.1.0 · simulates GIRAFE 0.67.3 · host API 0 (draft)

- Canvas with the core nodes Input, Image, For each, Yes / No and Collect.
- Plugin nodes from `workspace/nodes/`, run one firing per process in Node's permission sandbox.
- Host API 0: inputs, settings, emit, progress, log, file read/write.
- Not yet: AI calls, HTTP with key slots, network limits.
