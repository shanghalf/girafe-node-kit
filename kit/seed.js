// First start: a small example graph, so the canvas isn't empty.
const store = require('./store');

function ensureExample() {
  if (store.listGraphs().length) return;
  store.writeGraph('g-example', {
    title: 'Example: shout every word, keep the ones you like',
    nodes: [
      { id: 'n1', type: 'input', x: 60, y: 120, title: 'Words', value: '["giraffe","plugin","sandbox"]' },
      { id: 'n2', type: 'forEach', x: 340, y: 120, title: 'For each word' },
      { id: 'n3', type: 'plugin:example-upper', x: 620, y: 120, title: 'Upper case', settings: { suffix: '!' } },
      { id: 'n5', type: 'ask', x: 900, y: 120, title: 'Keep it?', prompt: 'Keep "{{A}}"?' },
      { id: 'n6', type: 'collect', x: 1180, y: 40, title: 'Kept' },
      { id: 'n7', type: 'collect', x: 1180, y: 260, title: 'Thrown away' },
    ],
    wires: [
      { id: 'w1', from: 'n1', port: 'out', to: 'n2' },
      { id: 'w2', from: 'n2', port: 'out', to: 'n3' },
      { id: 'w3', from: 'n3', port: 'out', to: 'n5' },
      { id: 'w5', from: 'n5', port: 'yes', to: 'n6' },
      { id: 'w6', from: 'n5', port: 'no', to: 'n7' },
    ],
  });
}

module.exports = { ensureExample };
