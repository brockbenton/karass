// Karass: Claude Code sessions and shells in real terminals in the browser.
// Usage: node server.js [project-folder]
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const claude = require('./lib/claude');
const createManagers = require('./lib/manager');
const Refusal = require('./lib/refusal');
const store = require('./lib/store');
const terminals = require('./lib/terminals');

// This page can run commands on your computer, so it only listens locally.
const HOST = '127.0.0.1';
const PORT = Number(process.env.KARASS_PORT || 4477);
const TOKEN = process.env.KARASS_TOKEN || crypto.randomBytes(24).toString('hex');
const ADDRESS = `${HOST}:${PORT}`;
const SHELL = process.env.SHELL || '/bin/bash';
const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,39}$/;

const state = store.load();

const isFolder = (dir) => Boolean(fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory());

// With `create`, a folder that doesn't exist yet is made, parents included.
function resolveFolder(input, { create = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Refusal('Enter a folder path.');
  const expanded = input.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(expanded)) throw new Refusal('Use a full path, or one starting with ~.');
  const dir = path.resolve(expanded);
  let created = false;
  if (create) {
    try {
      // mkdirSync returns the first folder it had to make, if any.
      created = fs.mkdirSync(dir, { recursive: true }) !== undefined;
    } catch (error) {
      throw new Refusal(error.code === 'EEXIST' || error.code === 'ENOTDIR'
        ? `A file is in the way: ${dir}`
        : `Could not create ${dir} (${error.code}).`);
    }
  }
  if (!isFolder(dir)) throw new Refusal(`Not a folder: ${dir}`);
  return { dir, created };
}

function addProject(dir) {
  if (!state.projects.includes(dir)) {
    state.projects.push(dir);
    store.save(state);
  }
}

if (process.argv[2]) addProject(resolveFolder(path.resolve(process.argv[2])).dir);

// ---------- What the page shows ----------

const ourPid = (record) =>
  terminals.isRunning(record.id) ? terminals.terminals.get(record.id).proc.pid : null;

// Claude Code can switch conversations (for example with /clear) or rename a
// session. Follow along, matching on the process Karass started.
function followRunningSessions(agents) {
  let changed = false;
  for (const record of state.sessions) {
    const agent = agents.find((a) => a.pid === ourPid(record));
    if (!agent) continue;
    // A starting fork must never be re-pointed at the conversation it copied.
    if (agent.sessionId !== record.sessionId && agent.sessionId !== record.forkOf) {
      Object.assign(record, { sessionId: agent.sessionId, forkOf: null, task: '' });
      changed = true;
    }
    if (agent.name && SESSION_NAME.test(agent.name) && agent.name !== record.name) {
      record.name = agent.name;
      changed = true;
    }
  }
  if (changed) store.save(state);
}

// Sessions running in your own terminals, which Karass can fork but not drive.
function externalAgents(agents) {
  const mine = new Set(state.sessions.map(ourPid).filter(Boolean));
  return agents.filter((a) => !mine.has(a.pid));
}

function statusOf(record, agents) {
  const pid = ourPid(record);
  if (!pid) {
    return agents.some((a) => a.sessionId === record.sessionId) ? 'elsewhere' : 'stopped';
  }
  const status = agents.find((a) => a.pid === pid)?.status;
  if (!status) return 'starting';
  return status === 'busy' || status === 'idle' ? status : 'attention';
}

// A Karass session as the page and managers see it.
const describe = (s, agents) => ({
  id: s.id,
  sessionId: s.sessionId,
  name: s.name,
  role: s.role || null,
  parentId: s.parentId || null,
  autopilot: Boolean(s.autopilot),
  forkedFrom: s.forkedFrom || null,
  status: statusOf(s, agents),
  forkable: claude.hasConversation(s.sessionId),
});

const describeOther = (a) => ({
  sessionId: a.sessionId,
  name: a.name || a.sessionId.slice(0, 8),
  status: a.status === 'busy' || a.status === 'idle' ? a.status : 'attention',
  forkable: claude.hasConversation(a.sessionId),
});

// Karass sessions and terminal sessions in one project.
async function sessionsIn(dir) {
  const { agents } = await claude.listAgents();
  followRunningSessions(agents);
  const saved = new Set(state.sessions.map((s) => s.sessionId));
  return [
    ...state.sessions.filter((s) => s.projectDir === dir).map((s) => describe(s, agents)),
    ...externalAgents(agents).filter((a) => a.cwd === dir && !saved.has(a.sessionId)).map(describeOther),
  ];
}

async function snapshot() {
  const { agents, error } = await claude.listAgents();
  followRunningSessions(agents);
  const external = externalAgents(agents);
  const saved = new Set(state.sessions.map((s) => s.sessionId));
  const others = external.filter((a) => !saved.has(a.sessionId));
  const dirs = [...new Set([
    ...state.projects,
    ...state.sessions.map((s) => s.projectDir),
    ...others.map((a) => a.cwd).sort(),
  ])];
  return {
    home: os.homedir(),
    models: claude.MODELS,
    efforts: claude.EFFORTS,
    limits: managers.LIMITS,
    warning: error,
    projects: dirs.map((dir) => ({
      dir,
      saved: state.projects.includes(dir),
      sessions: state.sessions.filter((s) => s.projectDir === dir).map((s) => ({
        ...describe(s, agents),
        ...(s.role === 'manager' && { requests: managers.requestsFor(s.id) }),
      })),
      external: others.filter((a) => a.cwd === dir).map(describeOther),
    })),
  };
}

async function knownFolder(dir) {
  if (state.projects.includes(dir) || state.sessions.some((s) => s.projectDir === dir)) return true;
  const { agents } = await claude.listAgents();
  return agents.some((a) => a.cwd === dir);
}

// ---------- Sessions ----------

const starting = new Map();

function startSession(record) {
  if (terminals.isRunning(record.id)) return Promise.resolve();
  if (!starting.has(record.id)) {
    const job = (async () => {
      // Only one program should drive a conversation at a time.
      const { agents } = await claude.listAgents({ fresh: true });
      if (agents.some((a) => a.sessionId === record.sessionId)) {
        throw new Refusal('This conversation is open in another terminal. Close it there, or fork it.');
      }
      if (!state.sessions.includes(record)) return; // removed while we were checking
      if (!isFolder(record.projectDir)) throw new Refusal(`Folder is gone: ${record.projectDir}`);
      const extra = record.role === 'manager' ? managers.launchArgs(record, ADDRESS) : [];
      terminals.start(record.id, claude.CLAUDE, claude.sessionArgs(record, extra), {
        cwd: record.projectDir, env: claude.childEnv,
      });
    })().finally(() => starting.delete(record.id));
    starting.set(record.id, job);
  }
  return starting.get(record.id);
}

function checkSettings({ name, model, effort, task }) {
  if (typeof name !== 'string' || !SESSION_NAME.test(name.trim())) {
    throw new Refusal('Names use letters, numbers, spaces, dots, dashes or underscores (40 at most).');
  }
  if (model && !claude.MODELS.includes(model)) throw new Refusal('Unknown model.');
  if (effort && !claude.EFFORTS.includes(effort)) throw new Refusal('Unknown effort level.');
  if (typeof task !== 'string' || task.length > 20_000) throw new Refusal('The task is missing or too long.');
}

async function createSession(body, { parentId = null } = {}) {
  const { name, model = '', effort = '', task = '', forkOf = null, role = null } = body;
  checkSettings({ name, model, effort, task });
  if (role && role !== 'manager') throw new Refusal('Unknown role.');

  let projectDir;
  let forkedFrom = null;
  if (forkOf) {
    const { agents } = await claude.listAgents();
    const mine = state.sessions.find((s) => s.sessionId === forkOf);
    const other = agents.find((a) => a.sessionId === forkOf);
    if (!mine && !other) throw new Refusal('That session is no longer available to fork.');
    if (!claude.hasConversation(forkOf)) throw new Refusal('Nothing to fork yet. Send that session a message first.');
    // A fork has to run in the folder its conversation came from.
    projectDir = mine ? mine.projectDir : other.cwd;
    forkedFrom = mine?.name || other.name || forkOf.slice(0, 8);
  } else {
    projectDir = body.projectDir;
    if (!(await knownFolder(projectDir))) throw new Refusal('Add that project first.');
  }
  if (!isFolder(projectDir)) throw new Refusal(`Not a folder: ${projectDir}`);

  if (role && state.sessions.some((s) => s.role === 'manager' && s.projectDir === projectDir)) {
    throw new Refusal('This project already has a manager.');
  }

  const record = {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    projectDir, name: name.trim(), model, effort, task: task.trim(), forkOf, forkedFrom,
    role, parentId, autopilot: Boolean(role && body.autopilot === true),
  };
  state.sessions.push(record);
  addProject(projectDir);
  store.save(state);
  await startSession(record); // start now, so a task begins even if nobody is watching
  return { id: record.id };
}

const findRecord = (id) => state.sessions.find((s) => s.id === id);

const managers = createManagers({
  findRecord,
  sessionsIn,
  createSession,
  checkSettings,
  allNames: async () => {
    const { agents } = await claude.listAgents();
    return [...state.sessions.map((s) => s.name), ...agents.map((a) => a.name)];
  },
});

// ---------- HTTP ----------

const parseUrl = (value) => URL.parse(value, `http://${ADDRESS}`);

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};
// Read once at startup, so the page always matches the running server.
for (const entry of Object.values(STATIC)) entry[0] = fs.readFileSync(path.join(__dirname, entry[0]));

function tokenMatches(given) {
  const a = Buffer.from(given || '');
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Refusal('Expected JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Refusal('Request is too large.', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new Refusal('Invalid JSON.'); }
  if (!body || typeof body !== 'object') throw new Refusal('Invalid JSON.');
  return body;
}

async function api(req, url) {
  if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, ''))) {
    throw new Refusal('Wrong or missing token. Open the link printed by the server.', 401);
  }
  if (req.method !== 'GET' && req.headers.origin !== `http://${ADDRESS}`) {
    throw new Refusal('Request came from another site.', 403);
  }
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/state') return snapshot();
  if (route === 'POST /api/sessions') return createSession(await readJson(req));

  const answer = route.match(/^POST \/api\/requests\/([0-9a-f-]+)\/(approve|decline)$/);
  if (answer) {
    const request = managers.find(answer[1]);
    if (answer[2] === 'decline') {
      managers.decline(request);
      return {};
    }
    // Anything you edited on the card replaces what the manager asked for.
    const body = await readJson(req);
    const changes = {};
    for (const field of ['name', 'task', 'model', 'effort', 'forkOf']) {
      if (Object.hasOwn(body, field)) changes[field] = body[field];
    }
    return managers.launch(request, changes);
  }

  const setting = route.match(/^POST \/api\/sessions\/([0-9a-f-]+)\/(autopilot|manager)$/);
  if (setting) {
    const record = findRecord(setting[1]);
    if (!record) throw new Refusal('That session was removed.', 404);
    const body = await readJson(req);
    if (setting[2] === 'autopilot') {
      if (record.role !== 'manager') throw new Refusal('Only a manager has Autopilot.');
      record.autopilot = body.on === true;
    } else {
      const manager = body.managerId && findRecord(body.managerId);
      const fits = manager?.role === 'manager' && manager.projectDir === record.projectDir;
      if (record.role === 'manager' || (body.managerId && !fits)) {
        throw new Refusal('That session cannot be placed under this manager.');
      }
      record.parentId = body.managerId || null;
    }
    store.save(state);
    return {};
  }
  if (route === 'POST /api/projects') {
    const { dir, created } = resolveFolder((await readJson(req)).path, { create: true });
    addProject(dir);
    return { dir, created };
  }
  if (route === 'DELETE /api/projects') {
    const dir = url.searchParams.get('dir');
    if (state.sessions.some((s) => s.projectDir === dir)) throw new Refusal('Remove its sessions first.');
    state.projects = state.projects.filter((p) => p !== dir);
    terminals.remove(`shell:${dir}`);
    store.save(state);
    return {};
  }
  const match = route.match(/^DELETE \/api\/sessions\/([0-9a-f-]+)$/);
  if (match) {
    // The conversation stays on disk; Karass only stops and forgets the session.
    state.sessions = state.sessions.filter((s) => s.id !== match[1]);
    for (const s of state.sessions) if (s.parentId === match[1]) s.parentId = null;
    managers.remove(match[1]);
    terminals.remove(match[1]);
    store.save(state);
    return {};
  }
  throw new Refusal('Not found', 404);
}

// Managers reach their tools here, with a secret that opens nothing else.
async function serveManagerTools(req, res) {
  const managerId = managers.managerFor(req.headers.authorization?.replace(/^Bearer /, ''));
  const origin = req.headers.origin;
  if (!managerId || (origin && origin !== `http://${ADDRESS}`)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  try {
    const answer = await managers.handle(managerId, await readJson(req));
    if (!answer) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
  } catch (error) {
    if (!(error instanceof Refusal)) console.error(error);
    res.writeHead(error.status || 500).end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req.url);
  // Checking the Host header blocks DNS rebinding from other websites.
  if (req.headers.host !== ADDRESS || !url) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (url.pathname === '/mcp') {
    await serveManagerTools(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    let status = 200;
    let body;
    try {
      body = await api(req, url);
    } catch (error) {
      if (!(error instanceof Refusal)) console.error(error);
      status = error.status || 500;
      body = { error: error instanceof Refusal ? error.message : 'Something went wrong. See the server log.' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  const file = req.method === 'GET' && Object.hasOwn(STATIC, url.pathname) && STATIC[url.pathname];
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': `${file[1]}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      `default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${ADDRESS}; frame-ancestors 'none'`,
  });
  res.end(file[0]);
});

// ---------- Terminal sockets ----------

const isSize = (n) => Number.isInteger(n) && n > 0 && n <= 500;

// `key` is a session's id, or "shell:<project folder>".
async function attach(socket, key) {
  const watching = terminals.watchersOf(key);
  let size = null;
  let needsRedraw = false;

  const applySize = () => {
    const terminal = terminals.terminals.get(key);
    if (!size || terminal?.exitCode !== null) return;
    // After a reload, a size change makes full-screen programs repaint cleanly.
    if (needsRedraw && size.rows > 1) terminal.proc.resize(size.cols, size.rows - 1);
    needsRedraw = false;
    terminal.proc.resize(size.cols, size.rows);
  };

  const launch = async () => {
    if (key.startsWith('shell:')) {
      const dir = key.slice('shell:'.length);
      if (!(await knownFolder(dir)) || !isFolder(dir)) throw new Refusal('Unknown project folder.');
      if (!terminals.isRunning(key)) {
        terminals.start(key, SHELL, [], { cwd: dir, env: claude.childEnv });
      }
    } else {
      const record = state.sessions.find((s) => s.id === key);
      if (!record) throw new Refusal('That session was removed.');
      await startSession(record);
    }
  };

  const fail = (error) => {
    if (!(error instanceof Refusal)) console.error(error);
    terminals.send(socket, {
      type: 'failed',
      reason: error instanceof Refusal ? error.message : 'Could not start. See the server log.',
    });
  };

  // Listen before doing anything slow, so no early message is lost.
  socket.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    const terminal = terminals.terminals.get(key);
    const running = terminal?.exitCode === null;

    if (message?.type === 'input' && running && typeof message.data === 'string') {
      terminal.proc.write(message.data);
    } else if (message?.type === 'resize' && isSize(message.cols) && isSize(message.rows)) {
      size = { cols: message.cols, rows: message.rows };
      applySize();
    } else if (message?.type === 'restart' && !running) {
      terminals.terminals.delete(key);
      try {
        await launch();
        terminals.broadcast(key, { type: 'restarted' });
        const next = terminals.terminals.get(key);
        if (next?.history) terminals.broadcast(key, { type: 'data', data: next.history });
        applySize();
      } catch (error) {
        fail(error);
      }
    }
  });
  socket.on('close', () => watching.delete(socket));

  try {
    // A finished terminal is shown as it ended; only Restart starts it again.
    if (!terminals.terminals.has(key)) await launch();
    if (socket.readyState !== socket.OPEN) return;
    const terminal = terminals.terminals.get(key);
    if (!terminal) return;
    // Register and replay in one step so no output is missed or repeated.
    terminals.watchersOf(key).add(socket);
    if (terminal.history) terminals.send(socket, { type: 'data', data: terminal.history });
    if (terminal.exitCode !== null) {
      terminals.send(socket, { type: 'exit', exitCode: terminal.exitCode });
    }
    needsRedraw = Boolean(terminal.history);
    applySize();
  } catch (error) {
    terminals.watchersOf(key).add(socket);
    fail(error);
  }
}

const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = parseUrl(req.url);
  const key = url?.searchParams.get('term') || '';
  const allowed = req.headers.host === ADDRESS
    && req.headers.origin === `http://${ADDRESS}`
    && url?.pathname === '/pty'
    && (key.startsWith('shell:') || state.sessions.some((s) => s.id === key))
    && tokenMatches(url.searchParams.get('token'));
  if (!allowed) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => attach(ws, key));
});

function shutdown() {
  terminals.killAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(`Port ${PORT} is in use. Is Karass already running? Stop it, or set KARASS_PORT.`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('Karass is running.');
  console.log(`Open http://${ADDRESS}/#token=${TOKEN}`);
});
