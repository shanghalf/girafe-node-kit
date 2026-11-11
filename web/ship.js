// Ship: one card, one button, "this is ready - put it everywhere".
//
// A node lives in four places (here, your GitHub repository, your GIRAFE account, the market) and
// each used to have its own button, its own version rule and its own idea of "up to date". This
// card shows all four at once, works out the new version number itself, and does the three steps
// in order, turning each column as it goes.
//
// Pure here: the words and the columns. The fetching and the DOM helper come from app.js, like
// web/chain.js - this file holds no state and calls nothing by itself.

// What each target's state says, in plain words. `t` is the matrix entry, `v` what is here.
export function column(key, t = {}, here = '') {
  const label = { github: 'GitHub', girafe: 'GIRAFE', market: 'Market' }[key];
  const s = t.state || 'off';
  const v = t.version;
  if (s === 'off') return { key, label, tone: 'off', word: 'not set up', can: false, hint: key === 'github' ? 'No repository on this computer.' : key === 'girafe' ? 'The kit is not signed in to GIRAFE.' : 'Only needed to publish for other people.' };
  if (s === 'current') return { key, label, tone: 'ok', word: t.unsure ? `has ${v}` : 'up to date', can: false, hint: t.unsure ? `It has ${v} and does not say which files, so it is taken at its word.` : `It already has exactly these files${v ? ` (${v})` : ''}.` };
  if (s === 'missing') return { key, label, tone: 'new', word: 'not there yet', can: true, hint: key === 'github' ? 'Nothing of it is saved yet.' : 'This will be its first version there.' };
  if (s === 'behind') return { key, label, tone: 'todo', word: t.sameNumber ? `has ${v}, other files` : v ? `has ${v}` : `${t.dirty || ''} to save`.trim(), can: true, hint: t.sameNumber ? `It holds a different ${v} - two different things can't both be ${v}, so the number has to rise.` : 'It is behind what is on this computer.' };
  if (s === 'ahead') return { key, label, tone: 'bad', word: `has ${v} - newer`, can: false, hint: `Someone shipped ${v} from another computer. Get it first (the Chain's repository row), or this would undo it.` };
  if (s === 'stuck') return { key, label, tone: 'bad', word: t.why === 'conflict' ? 'conflict' : 'needs a hand', can: false, hint: 'Sort it out in the repository first.' };
  if (s === 'waiting') return { key, label, tone: 'todo', word: `${v} in review`, can: true, hint: 'A version is already waiting for an admin. Sending another replaces it.' };
  return { key, label, tone: 'off', word: s, can: false, hint: '' };
}

export const shipDot = (tone) => ({ ok: '🟢', todo: '🟡', new: '🔵', bad: '🔴', off: '⚪', done: '✅', busy: '⏳', failed: '⚠️' }[tone] || '⚪');

export function shipColumns(matrix = {}) {
  return ['github', 'girafe', 'market'].map((k) => column(k, (matrix.targets || {})[k], matrix.version));
}

// One line above the button: what pressing it will do.
export function shipHeadline(data) {
  const { here = {}, matrix = {}, plan = {} } = data || {};
  const cols = shipColumns(matrix).filter((c) => c.can);
  const what = here.kind === 'pack' ? 'the pack' : 'it';
  if (!cols.length) {
    const any = shipColumns(matrix).some((c) => c.tone === 'bad');
    return any ? 'Something is in the way - see the red one below.' : `Everywhere it can go already has ${what}.`;
  }
  const names = cols.map((c) => c.label);
  const where = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const ver = plan.rise ? `${here.version} → ${plan.version}` : here.version;
  return `${ver} to ${where}.`;
}

// Why the number has to move, when it does. Empty when the person simply chose to raise it.
export function riseReason(data) {
  const { plan = {}, matrix = {} } = data || {};
  if (!plan.forced) return '';
  const names = (plan.forcedBy || []).map((k) => column(k, (matrix.targets || {})[k]).label);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} already hold` : `${names[0]} already holds`;
  return `${who} this number with other files, so the version has to rise.`;
}

const BUMPS = [['patch', 'small fix'], ['minor', 'new thing'], ['major', 'breaking'], ['none', 'keep the number']];

// The card. `el` is app.js's element helper; `data` is GET /api/ship/<id>; `run` ships and
// resolves with the answer; `pack` makes the file; `page` opens the market page editor.
export function renderShip({ el, data, run, pack, page, reload, titled = true }) {
  const { here = {}, matrix = {}, plan = {} } = data || {};
  const cols = shipColumns(matrix);
  const state = { bump: plan.suggest || (plan.forced ? 'patch' : 'none'), notes: '', off: new Set(), busy: false };
  const cells = {};
  const notes = el('textarea', { rows: 2, placeholder: here.kind === 'pack' ? 'What changed in this version of the pack' : 'What changed in this version', oninput: (e) => { state.notes = e.target.value; } });
  const msg = el('div', { class: 'muted ship-msg' });
  const after = el('div', { class: 'row' });
  const head = el('div', { class: 'ship-head', text: shipHeadline(data) });

  const grid = el('div', { class: 'ship-grid' }, ...cols.map((c) => {
    const dot = el('span', { class: 'ship-dot', text: shipDot(c.tone) });
    const word = el('span', { class: 'ship-word', text: c.word });
    const box = el('label', { class: `ship-cell ship-${c.tone}${c.can ? '' : ' ship-cant'}`, title: c.hint },
      el('div', { class: 'ship-cell-hd' },
        c.can ? el('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) state.off.delete(c.key); else state.off.add(c.key); drawHead(); } }) : dot,
        el('b', { text: c.label })),
      el('div', { class: 'ship-cell-state' }, c.can ? dot : null, word));
    cells[c.key] = { dot, word, box, col: c };
    return box;
  }));

  const drawHead = () => {
    const picked = cols.filter((c) => c.can && !state.off.has(c.key));
    if (!picked.length) { head.textContent = 'Nothing picked.'; return; }
    const names = picked.map((c) => c.label);
    const where = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const rise = state.bump !== 'none' || plan.forced;
    head.textContent = `${rise ? `${here.version} → ${bumpTo(here.version, plan, state.bump)}` : here.version} to ${where}.`;
  };

  const bumps = el('div', { class: 'ship-bumps' }, ...BUMPS.map(([k, label]) => {
    const b = el('button', { class: `chip${state.bump === k ? ' on' : ''}`, text: label, title: k === 'none' ? (plan.forced ? "Can't: a target already holds this number with other files." : 'Send it under the number it already has.') : `${k}: ${bumpTo(here.version, plan, k)}`, disabled: k === 'none' && plan.forced, onclick: () => {
      state.bump = k;
      for (const n of bumps.querySelectorAll('button')) n.classList.toggle('on', n.textContent === label);
      drawHead();
    } });
    return b;
  }));

  const go = el('button', { class: 'primary ship-go', text: here.kind === 'pack' ? '🚀 Ship the pack' : '🚀 Ship it', onclick: async () => {
    if (state.busy) return;
    const targets = cols.filter((c) => c.can && !state.off.has(c.key)).map((c) => c.key);
    if (!targets.length) { msg.textContent = 'Pick at least one place to send it.'; return; }
    state.busy = true; go.disabled = true; go.classList.add('busy');
    msg.textContent = '';
    for (const k of targets) { cells[k].dot.textContent = shipDot('busy'); cells[k].word.textContent = 'waiting its turn'; }
    cells[targets[0]].word.textContent = 'sending…';
    try {
      const r = await run({ bump: state.bump, notes: state.notes, targets });
      for (const st of r.steps || []) {
        const c = cells[st.target];
        if (!c) continue;
        c.dot.textContent = shipDot(st.ok ? 'done' : 'failed');
        c.box.className = `ship-cell ship-${st.ok ? 'ok' : 'bad'}`;
        c.word.textContent = st.ok ? (st.status === 'pending' ? `${r.plan.version} in review` : st.saved && !st.saved.length ? 'already saved' : `${r.plan.version} sent`) : st.error;
        c.dot.classList.add('ship-pop');
      }
      for (const k of targets) if (!(r.steps || []).some((s) => s.target === k)) { cells[k].dot.textContent = shipDot('off'); cells[k].word.textContent = 'not reached'; }
      msg.textContent = r.stoppedAt ? `⚠️ Stopped at ${cells[r.stoppedAt]?.col.label || r.stoppedAt}. Nothing after it ran; the version on disk is ${r.plan.version}.` : `✓ ${here.name || here.id} ${r.plan.version} is everywhere you picked.${(r.plan.members || []).length ? ` Members raised: ${r.plan.members.map((m) => `${m.id} ${m.to}`).join(', ')}.` : ''}`;
      const sub = (r.steps || []).find((s) => s.target === 'market' && s.ok);
      if (sub && page) after.replaceChildren(el('button', { class: 'primary', text: '✏️ Dress up its market page', onclick: () => page() }));
      if (reload) reload();
    } catch (e) {
      msg.textContent = '⚠️ ' + e.message;
      for (const k of targets) { cells[k].dot.textContent = shipDot(cells[k].col.tone); cells[k].word.textContent = cells[k].col.word; cells[k].box.className = `ship-cell ship-${cells[k].col.tone}`; }
    }
    state.busy = false; go.disabled = false; go.classList.remove('busy');
  } });

  const why = riseReason(data);
  return el('div', { class: 'box ship-box' },
    titled ? el('div', { class: 'box-title', text: here.kind === 'pack' ? `🚀 Ship the pack "${here.name || here.id}"` : '🚀 Ship' }) : null,
    grid,
    el('div', { class: 'ship-version' }, el('span', { class: 'caps', text: 'Version' }), bumps),
    why ? el('div', { class: 'caps ship-why', text: why }) : null,
    el('div', { class: 'field' }, notes),
    el('div', { class: 'caps', text: 'What you write here goes in the node\'s CHANGELOG.md, in GIRAFE\'s "what\'s new" badge and on its market page.' }),
    head,
    el('div', { class: 'row' }, go, pack ? el('button', { class: 'link muted', text: '📦 Just the file', title: 'Make a signed package and download it, without sending it anywhere', onclick: () => pack() }) : null),
    msg, after);
}

// The number a bump would give, using the same rule as the server (above every target's).
export function bumpTo(version, plan, how) {
  if (how === 'none') return plan.forced ? plan.version : version;
  const base = plan.highest || plan.from || version;
  const [a, b, c] = String(base).split('.').map((n) => parseInt(n, 10) || 0);
  if (how === 'major') return `${a + 1}.0.0`;
  if (how === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}
