// The chain, in one place: kit → GIRAFE account → your nodes repository → the market.
//
// These four used to be four buttons in the top bar, each opening its own dialog, each telling a
// quarter of the story. On a second computer that meant hunting for which of them still had to be
// done. The chain shows all four at once, each with its state and at most one action, and the old
// dialogs stay one click away from the row they belong to.
//
// It draws from what app.js already loaded (S.compat, S.link, S.gh, S.market, S.settings); every
// action is a callback app.js passes in, so this file holds no fetching and no state of its own.
// Row 5 (packs, with the Ship button) comes with phase 5 of the redesign.

export const chainDot = (tone) => ({ ok: '🟢', warn: '🟡', bad: '🔴', off: '⚪' }[tone] || '⚪');

// What each row says, from what the page already knows. Pure: no DOM, no fetching - so the words
// can be checked on their own.
export function chainRows(S) {
  const c = S.compat || {};
  const u = c.update || {};
  const set = S.settings || {};
  const rows = [];

  // 1. The kit itself.
  const latest = c.latest?.version;
  const newer = !!c.updateAvailable;
  const kitLines = [];
  if (c.girafe?.version) kitLines.push(`girafe.live runs ${c.girafe.version}; this kit builds for host API ${c.kit?.hostApi}.`);
  if (u.mode === 'git') kitLines.push(`A git clone in ${set.kitDir || 'its own folder'}: it updates with git pull, and never by itself.`);
  else if (set.kitDir) kitLines.push(set.kitDir === set.installedAt ? `Running from its home folder, ${set.kitDir}.` : `Running from ${set.kitDir}; its home is ${set.installedAt}.`);
  // Red only when GIRAFE refuses this kit; yellow when there is something to do about it.
  const blocked = (c.problems || []).some((x) => x.level === 'block');
  rows.push({
    id: 'kit',
    icon: '🧩',
    title: `Kit ${c.kit?.version || ''}`.trim(),
    tone: blocked ? 'bad' : newer ? 'warn' : 'ok',
    state: blocked ? 'Too old for this GIRAFE' : newer ? `Kit ${latest} is out` : u.mode === 'git' ? 'Up to date (git clone)' : 'Up to date',
    lines: kitLines,
    actions: [
      newer && { key: 'update', label: `⬆ Update to ${latest}`, primary: true },
      { key: 'versions', label: '🔄 Versions and updates' },
      { key: 'align', label: '✨ Align with GIRAFE' },
    ].filter(Boolean),
    toggles: u.mode === 'git' ? [] : [
      { key: 'autoUpdate', label: 'Update the kit by itself', on: set.autoUpdate !== false, hint: 'When a newer kit is out, it is installed the next time the kit starts.' },
      { key: 'autostart', label: 'Start with the computer', on: !!set.autostart, hint: 'The kit runs from login, so GIRAFE\'s "Open the kit" always finds it.' },
    ],
  });

  // 2. The GIRAFE account.
  const link = S.link || {};
  rows.push({
    id: 'girafe',
    icon: '☁️',
    title: 'GIRAFE account',
    tone: link.connected ? 'ok' : 'off',
    state: link.connected ? `Signed in as ${link.account?.name || link.account?.email || 'you'}` : 'Not signed in',
    lines: link.connected
      ? [`In your GIRAFE this kit is "${link.kitName || 'this computer'}"; Settings › Node kit lists every computer you work on.`]
      : ['Sign in once; the kit then sends the nodes you build straight to your own palette.'],
    actions: [link.connected ? { key: 'leave', label: '🚪 Leave this computer' } : { key: 'signin', label: '☁️ Connect to GIRAFE', primary: true }],
  });

  // 3. Your nodes on GitHub.
  const gh = S.gh || {};
  const states = gh.connected ? Object.values(gh.nodes || {}) : [];
  const dirty = states.filter((x) => ['changed', 'new', 'conflict', 'deleted'].includes(x.state)).length;
  const behind = states.filter((x) => x.state === 'behind').length;
  rows.push({
    id: 'repo',
    icon: '📁',
    title: 'Your nodes repository',
    tone: !gh.connected ? 'off' : dirty ? 'warn' : 'ok',
    state: gh.connected ? `${gh.owner}/${gh.repo}` : 'Not set up',
    lines: gh.connected
      ? [`${states.length} node${states.length === 1 ? '' : 's'}${dirty ? `, ${dirty} not saved yet` : ', all saved'}${behind ? `, ${behind} newer on GitHub` : ''}.`,
        'This is where your nodes live between computers - the kit itself is replaced by every update.']
      : ['Without it, the nodes you build are only on this computer. A private repository and a token are enough.'],
    actions: [{ key: 'github', label: gh.connected ? '📁 Open GitHub' : '📁 Set it up', primary: !gh.connected }],
  });

  // 4. The market (optional).
  const mk = S.market || {};
  rows.push({
    id: 'market',
    icon: '🛒',
    title: 'The market',
    tone: mk.connected ? 'ok' : 'off',
    state: mk.connected ? `Publishing as ${mk.account?.name || mk.account?.email || 'you'}` : 'Not connected',
    lines: mk.connected ? [] : ['Only needed to publish a node for other people. Your own nodes work in GIRAFE without it.'],
    actions: [{ key: 'market', label: mk.connected ? '🛒 Open the market' : '🛒 Connect' }],
  });

  return rows;
}

// The dialog's body. `el` and the callbacks come from app.js.
export function renderChain({ el, S, act, toggle }) {
  return chainRows(S).map((r) => el('div', { class: `chain-row chain-${r.tone}` },
    el('div', { class: 'chain-head' },
      el('span', { class: 'chain-icon', text: r.icon }),
      el('b', { text: r.title }),
      el('span', { class: 'chain-state', text: `${chainDot(r.tone)} ${r.state}` })),
    ...r.lines.map((t) => el('div', { class: 'chain-line', text: t })),
    r.toggles && r.toggles.length
      ? el('div', { class: 'chain-toggles' }, ...r.toggles.map((t) => el('label', { class: 'chain-toggle', title: t.hint },
        el('input', { type: 'checkbox', checked: t.on, onchange: (e) => toggle(t.key, e.target.checked) }), t.label)))
      : null,
    el('div', { class: 'chain-actions' }, ...r.actions.map((a) => el('button', { class: a.primary ? 'primary' : '', text: a.label, onclick: () => act(a.key) })))));
}
