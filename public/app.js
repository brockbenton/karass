// The token arrives in the URL fragment, which the browser never sends in requests.
const fromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromUrl) {
  sessionStorage.setItem('karassToken', fromUrl);
  history.replaceState(null, '', location.pathname);
}
const token = sessionStorage.getItem('karassToken');

const $ = (selector) => document.querySelector(selector);

function element(tag, properties = {}, ...children) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!result) throw new Error('The server does not match this page. Restart Karass and open its new link.');
  if (!response.ok) throw new Error(result.error);
  return result;
}

// ---------- Terminals ----------

const theme = {
  background: '#141414',
  foreground: '#d4d4d4',
  cursor: '#e0896f',
  selectionBackground: '#3a3a3a',
};

// One pane holds many terminals and shows one of them at a time.
function createPane(section, { newlineOnShiftEnter = false } = {}) {
  const screens = section.querySelector('.screens');
  const status = section.querySelector('.status');
  const restart = section.querySelector('.restart');
  const empty = screens.querySelector('.empty');
  const open = new Map(); // key -> terminal
  let active = null;

  function refreshBar() {
    const terminal = open.get(active);
    status.textContent = terminal?.status || '';
    restart.hidden = !terminal?.ended;
    empty.hidden = Boolean(terminal);
  }

  function fitActive() {
    const terminal = open.get(active);
    if (terminal && screens.clientHeight > 20) terminal.fit.fit();
  }

  function create(key) {
    const host = element('div', { className: 'screen' });
    screens.append(host);
    const term = new Terminal({
      theme,
      // A Nerd Font, if installed, draws the icons that many shell prompts use.
      fontFamily: '"MesloLGS Nerd Font Mono", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      cursorBlink: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const query = new URLSearchParams({ term: key, token });
    const socket = new WebSocket(`ws://${location.host}/pty?${query}`);
    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const sendSize = () => send({ type: 'resize', cols: term.cols, rows: term.rows });
    const terminal = { host, term, fit, socket, send, status: '', ended: false };
    const update = (text, ended) => {
      Object.assign(terminal, { status: text, ended });
      refreshBar();
    };

    socket.onopen = sendSize;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'data') term.write(message.data);
      if (message.type === 'exit') update(`ended (code ${message.exitCode})`, true);
      if (message.type === 'failed') update(message.reason, true);
      if (message.type === 'restarted') {
        term.reset();
        update('', false);
        sendSize();
      }
    };
    socket.onclose = () => update('disconnected. Select it again to retry.', false);

    if (newlineOnShiftEnter) {
      // Shift+Enter adds a new line in Claude Code instead of sending the message.
      term.attachCustomKeyEventHandler((event) => {
        if (event.key !== 'Enter' || !event.shiftKey) return true;
        event.preventDefault();
        if (event.type === 'keydown') send({ type: 'input', data: '\x1b\r' });
        return false;
      });
    }
    term.onData((data) => send({ type: 'input', data }));
    term.onResize(sendSize);
    return terminal;
  }

  function close(key) {
    const terminal = open.get(key);
    if (!terminal) return;
    terminal.socket.onclose = null;
    terminal.socket.close();
    terminal.term.dispose();
    terminal.host.remove();
    open.delete(key);
    if (active === key) active = null;
    refreshBar();
  }

  function show(key, { focus = false } = {}) {
    if (key && open.get(key)?.socket.readyState > WebSocket.OPEN) close(key);
    active = key;
    if (key && !open.has(key)) open.set(key, create(key));
    for (const [other, terminal] of open) terminal.host.hidden = other !== key;
    refreshBar();
    fitActive();
    if (focus) open.get(key)?.term.focus();
  }

  restart.onclick = () => open.get(active)?.send({ type: 'restart' });
  new ResizeObserver(fitActive).observe(screens);
  return { show, close, keys: () => [...open.keys()] };
}

// ---------- Resizing the two panes ----------

function setUpDivider() {
  const main = $('#main');
  const divider = $('#divider');
  const DEFAULT = 72;
  let split = Number(localStorage.getItem('karassSplit')) || DEFAULT;

  function apply(value) {
    split = Math.min(90, Math.max(12, value));
    main.style.setProperty('--split', `${split}%`);
    divider.setAttribute('aria-valuenow', Math.round(split));
    localStorage.setItem('karassSplit', split);
  }

  divider.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing');
  });
  divider.addEventListener('pointermove', (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const box = main.getBoundingClientRect();
    apply(((event.clientY - box.top) / box.height) * 100);
  });
  divider.addEventListener('lostpointercapture', () => {
    divider.classList.remove('dragging');
    document.body.classList.remove('resizing');
  });
  divider.addEventListener('dblclick', () => apply(DEFAULT));
  divider.addEventListener('keydown', (event) => {
    const step = { ArrowUp: -3, ArrowDown: 3 }[event.key];
    if (!step) return;
    event.preventDefault();
    apply(split + step);
  });
  apply(split);
}

// ---------- Sidebar and selection ----------

const claudePane = createPane($('.pane.claude'), { newlineOnShiftEnter: true });
const shellPane = createPane($('.pane.shell'));

let state = null;
let selected = JSON.parse(localStorage.getItem('karassSelected') || '{}'); // { dir, id }
let drawn = '';

const shortPath = (dir) => (dir === state.home ? '~' : dir.split('/').pop() || dir);
const findProject = (dir) => state.projects.find((p) => p.dir === dir);
const findSession = (id) => state.projects.flatMap((p) => p.sessions).find((s) => s.id === id);

const managerOf = (dir) => findProject(dir)?.sessions.find((s) => s.role === 'manager');

const STATUS = {
  busy: ['●', 'working'],
  idle: ['○', 'idle'],
  attention: ['▲', 'needs you'],
  starting: ['◌', 'starting'],
  stopped: ['·', 'stopped. Select to resume.'],
  elsewhere: ['·', 'open in another terminal'],
};

const dot = (status) =>
  element('span', { className: `dot ${status}`, title: STATUS[status][1] }, STATUS[status][0]);

function tool(text, label, onclick, extra = '') {
  const button = element('button', { className: `tool ${extra}`, title: label, onclick }, text);
  button.setAttribute('aria-label', label);
  return button;
}

function row(kind, isSelected, onPick, content, tools) {
  const pick = element('button', { className: 'pick', onclick: onPick }, ...content);
  return element('div', { className: `row-item ${kind}${isSelected ? ' selected' : ''}` }, pick, ...tools);
}

// A manager first, then its workers, then everything else.
function ordered(sessions) {
  const rank = (s) => (s.role === 'manager' ? 0 : s.parentId ? 1 : 2);
  return [...sessions].sort((a, b) => rank(a) - rank(b));
}

function sessionRow(project, session, manager) {
  const isManager = session.role === 'manager';
  const from = session.forkedFrom ? ` (forked from ${session.forkedFrom})` : '';
  const tools = [];
  if (session.forkable) tools.push(tool('⑂', 'Fork', () => openSessionDialog(project.dir, session.sessionId)));
  if (manager && !isManager) {
    tools.push(session.parentId
      ? tool('⇤', 'Detach from manager', () => setManager(session, null))
      : tool('⇥', `Make a worker of ${manager.name}`, () => setManager(session, manager.id)));
  }
  tools.push(tool('×', 'Remove session', () => removeSession(session)));
  const status = session.requests?.length ? 'attention' : session.status;
  return row(
    session.parentId ? 'session worker' : 'session',
    selected.id === session.id,
    () => select(project.dir, session.id, true),
    [
      dot(status),
      ...(isManager ? [element('span', { className: 'star' }, '★')] : []),
      element('span', { className: 'label', title: `${session.name}${from}` }, session.name),
    ],
    tools,
  );
}

function renderTree() {
  const rows = [];
  for (const project of state.projects) {
    const empty = !project.sessions.length && !project.external.length;
    const manager = managerOf(project.dir);
    rows.push(row(
      'project',
      selected.dir === project.dir && !selected.id,
      () => select(project.dir),
      [element('span', { className: 'label', title: project.dir }, shortPath(project.dir))],
      [
        ...(manager ? [] : [tool('★', 'Add a manager', () => openSessionDialog(project.dir, '', { role: 'manager' }), 'always star')]),
        tool('+', 'New session', () => openSessionDialog(project.dir)),
        ...(project.saved && empty ? [tool('×', 'Remove project', () => removeProject(project.dir))] : []),
      ],
    ));
    for (const session of ordered(project.sessions)) rows.push(sessionRow(project, session, manager));
    for (const other of project.external) {
      const fork = () => openSessionDialog(project.dir, other.sessionId);
      rows.push(row(
        'session',
        false,
        other.forkable ? fork : () => notify('Nothing to fork yet: that session has no messages.'),
        [
          dot(other.status),
          element('span', { className: 'label muted', title: `${other.name}: running in your terminal. Fork it to continue here.` }, other.name),
          element('span', { className: 'tag' }, 'terminal'),
        ],
        other.forkable ? [tool('⑂', 'Fork into Karass', fork)] : [],
      ));
    }
  }
  if (!rows.length) rows.push(element('p', { className: 'empty' }, 'Press + to add a project folder.'));
  $('#tree').replaceChildren(...rows);
}

// ---------- Workers panel ----------

const settingsText = (r) => [r.model || 'default model', r.effort && `${r.effort} effort`].filter(Boolean).join(', ');

function requestCard(project, request) {
  const act = (text, run, className = '') => element('button', {
    className,
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        await run();
      } catch (error) {
        notify(error.message);
      } finally {
        event.target.disabled = false;
      }
    },
  }, text);
  return element(
    'div', { className: 'card' },
    element('h3', {}, `Start "${request.name}"?`),
    element('p', { className: 'muted' },
      `${request.forkedFrom ? `Fork of ${request.forkedFrom}` : 'Starts fresh'} · ${settingsText(request)}`),
    element('p', { className: 'task' }, request.task),
    element('p', { className: 'muted' }, request.reason || ''),
    element(
      'div', { className: 'actions' },
      act('Decline', async () => {
        await api(`/api/requests/${request.id}/decline`, { method: 'POST' });
        await refreshAfterChange();
      }),
      act('Edit', async () => openSessionDialog(project.dir, request.forkOf || '', { request })),
      act('Launch', async () => {
        await api(`/api/requests/${request.id}/approve`, { method: 'POST', body: {} });
        await refreshAfterChange();
      }, 'primary'),
    ),
  );
}

function renderPanel() {
  const project = findProject(selected.dir);
  const manager = project && managerOf(project.dir);
  $('#panel').hidden = !manager;
  if (!manager) return;

  for (const button of document.querySelectorAll('.freedom button')) {
    const on = button.dataset.autopilot === String(manager.autopilot);
    button.setAttribute('aria-pressed', on);
    button.onclick = () => change(`/api/sessions/${manager.id}/autopilot`, { on: button.dataset.autopilot === 'true' });
  }
  const { models, efforts, busyWorkers } = state.limits;
  $('#freedom-hint').textContent = manager.autopilot
    ? `Starts workers on its own: up to ${busyWorkers} busy at once, ${models.join(' or ')}, ${efforts.at(-1)} effort at most. Anything bigger still asks.`
    : 'Nothing starts until you press Launch.';

  $('#requests').replaceChildren(...manager.requests.map((r) => requestCard(project, r)));
  const workers = project.sessions.filter((s) => s.parentId === manager.id);
  $('#workers').replaceChildren(...(workers.length ? workers.map((worker) => row(
    'session-card',
    selected.id === worker.id,
    () => select(project.dir, worker.id, true),
    [dot(worker.status), element('span', { className: 'label' }, worker.name,
      element('small', {}, STATUS[worker.status][1]))],
    [],
  )) : [element('p', { className: 'muted' }, 'No workers yet. Ask the manager to start one.')]));
}

async function change(path, body) {
  try {
    await api(path, { method: 'POST', body });
    await refreshAfterChange();
  } catch (error) {
    notify(error.message);
  }
}

const setManager = (session, managerId) => change(`/api/sessions/${session.id}/manager`, { managerId });

// Point out new requests, even while you are looking somewhere else.
const announced = new Set();
function announceRequests() {
  const waiting = state.projects.flatMap((p) => p.sessions.flatMap(
    (s) => (s.requests || []).map((r) => ({ ...r, manager: s.name }))));
  for (const request of waiting) {
    if (announced.has(request.id)) continue;
    announced.add(request.id);
    notify(`★ ${request.manager} wants to start "${request.name}"`);
  }
  document.title = waiting.length ? `(${waiting.length}) Karass` : 'Karass';
}

function renderHeader() {
  const session = selected.id && findSession(selected.id);
  $('#crumb-project').textContent = selected.dir ? shortPath(selected.dir) : 'karass';
  $('#crumb-session').textContent = session ? session.name : 'no session';
  $('#fork').hidden = !session?.forkable;
}

function select(dir, id = null, focus = false) {
  selected = { dir, id };
  localStorage.setItem('karassSelected', JSON.stringify(selected));
  claudePane.show(id, { focus });
  shellPane.show(dir ? `shell:${dir}` : null);
  renderTree();
  renderHeader();
  renderPanel();
}

let noticeTimer;
function notify(text) {
  $('#notice').textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('#notice').textContent = ''; }, 6000);
}

let refreshing = null;
let offline = false;
function refresh() {
  refreshing ||= (async () => {
    try {
      const next = await api('/api/state');
      const first = !state;
      state = next;
      if (offline) notify('');
      offline = false;
      if (next.warning) notify(next.warning);

      // Drop terminals whose session or project has gone away.
      for (const id of claudePane.keys()) if (!findSession(id)) claudePane.close(id);
      for (const key of shellPane.keys()) if (!findProject(key.slice(6))) shellPane.close(key);

      const stale = (selected.id && !findSession(selected.id))
        || (selected.dir && !findProject(selected.dir));
      if (first || stale || !selected.dir) {
        const dir = findProject(selected.dir)?.dir || state.projects[0]?.dir || null;
        const id = findSession(selected.id)?.id || null;
        if (first || dir !== selected.dir || id !== selected.id) select(dir, id, Boolean(id));
      }
      const signature = JSON.stringify(state.projects);
      if (signature !== drawn) {
        drawn = signature;
        renderTree();
        renderHeader();
        renderPanel();
      }
      announceRequests();
    } catch (error) {
      offline = true;
      notify(error instanceof TypeError ? 'Cannot reach the server.' : error.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function refreshAfterChange() {
  await refreshing; // a request already in flight may predate the change
  await refresh();
}

async function removeSession(session) {
  if (!confirm(`Remove "${session.name}"? This stops it in Karass. The conversation stays on disk.`)) return;
  try {
    await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
    claudePane.close(session.id);
    await refreshAfterChange();
  } catch (error) {
    notify(error.message);
  }
}

async function removeProject(dir) {
  try {
    await api(`/api/projects?${new URLSearchParams({ dir })}`, { method: 'DELETE' });
    await refreshAfterChange();
  } catch (error) {
    notify(error.message);
  }
}

// ---------- Dialogs ----------

const options = (select, list, chosen = '') => {
  select.replaceChildren(...list.map(([value, text]) => new Option(text, value)));
  select.value = chosen;
};

// Also used for adding a manager, and for editing a manager's request.
function openSessionDialog(dir, forkOf = '', { role = null, request = null } = {}) {
  const dialog = $('#session-dialog');
  const form = dialog.querySelector('form');
  const project = findProject(dir);
  const sources = [...project.sessions, ...project.external].filter((s) => s.forkable);
  const taken = new Set([...project.sessions, ...project.external].map((s) => s.name));
  const suggest = (raw) => {
    const base = raw.replace(/[^A-Za-z0-9 _.-]/g, '-').replace(/^[^A-Za-z0-9_]+/, '') || 'session';
    let name = base.slice(0, 40);
    for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 36)} ${n}`;
    return name;
  };
  const suggestion = () => {
    if (role) return suggest(`${shortPath(dir)}-manager`);
    const source = sources.find((s) => s.sessionId === form.elements.forkOf.value);
    return suggest(source ? `${source.name.slice(0, 35)}-fork` : 'session');
  };

  form.reset();
  form.dataset.dir = dir;
  form.dataset.role = role || '';
  form.dataset.request = request?.id || '';
  $('#session-title').textContent = role ? 'New manager' : request ? 'New worker' : 'New session';
  $('#freedom-field').hidden = !role;
  $('#session-folder').textContent = dir;
  dialog.querySelector('.error').textContent = '';
  options(form.elements.forkOf, [
    ['', 'Start fresh'],
    ...sources.map((s) => [s.sessionId, `Fork of ${s.name}`]),
  ], forkOf);
  options(form.elements.model, [['', 'Default'], ...state.models.map((m) => [m, m])]);
  options(form.elements.effort, [['', 'Default'], ...state.efforts.map((e) => [e, e])]);

  let suggested = request ? request.name : suggestion();
  form.elements.name.value = suggested;
  if (request) {
    for (const field of ['model', 'effort', 'task']) form.elements[field].value = request[field];
  }
  form.elements.forkOf.onchange = () => {
    // Keep a name you typed yourself.
    if (form.elements.name.value !== suggested) return;
    suggested = suggestion();
    form.elements.name.value = suggested;
  };
  dialog.showModal();
  form.elements.name.select();
}

function wireDialog(dialog, submit) {
  const form = dialog.querySelector('form');
  const button = form.querySelector('[type=submit]');
  dialog.querySelector('.cancel').onclick = () => dialog.close();
  form.onsubmit = async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
      await submit(Object.fromEntries(new FormData(form)), form);
    } catch (error) {
      dialog.querySelector('.error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

wireDialog($('#session-dialog'), async (values, form) => {
  const { dir: projectDir, role, request } = form.dataset;
  const { freedom, ...fields } = values;
  const body = { ...fields, forkOf: values.forkOf || null };
  const { id } = await api(request ? `/api/requests/${request}/approve` : '/api/sessions', {
    method: 'POST',
    body: request ? body : { ...body, projectDir, role: role || null, autopilot: freedom === 'autopilot' },
  });
  $('#session-dialog').close();
  await refreshAfterChange();
  select(projectDir, id, true);
});

wireDialog($('#project-dialog'), async (values) => {
  const { dir, created } = await api('/api/projects', { method: 'POST', body: values });
  $('#project-dialog').close();
  await refreshAfterChange();
  select(dir);
  if (created) notify(`Created ${dir}`);
});

$('#add-project').onclick = () => {
  const dialog = $('#project-dialog');
  dialog.querySelector('form').reset();
  dialog.querySelector('.error').textContent = '';
  dialog.showModal();
};
$('#fork').onclick = () => openSessionDialog(selected.dir, findSession(selected.id).sessionId);

setUpDivider();
if (token) {
  const poll = async () => {
    await refresh();
    setTimeout(poll, 2500);
  };
  poll();
} else {
  $('#notice').textContent = 'Open the full link printed by the server.';
}
