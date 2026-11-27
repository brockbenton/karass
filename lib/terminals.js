// Terminals live in the server, so reloading the page doesn't end them.
const pty = require('node-pty');

const HISTORY_LIMIT = 200_000;
const terminals = new Map(); // key -> { proc, history, exitCode }
const watchers = new Map(); // key -> Set of sockets showing that terminal

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function watchersOf(key) {
  if (!watchers.has(key)) watchers.set(key, new Set());
  return watchers.get(key);
}

function broadcast(key, message) {
  for (const socket of watchersOf(key)) send(socket, message);
}

const isRunning = (key) => terminals.get(key)?.exitCode === null;

function start(key, command, args, { cwd, env }) {
  const proc = pty.spawn(command, args, {
    name: 'xterm-256color', cols: 100, rows: 30, cwd, env,
  });
  const terminal = { proc, history: '', exitCode: null };
  terminals.set(key, terminal);
  proc.onData((data) => {
    terminal.history = (terminal.history + data).slice(-HISTORY_LIMIT);
    if (terminals.get(key) === terminal) broadcast(key, { type: 'data', data });
  });
  proc.onExit(({ exitCode }) => {
    terminal.exitCode = exitCode;
    if (terminals.get(key) === terminal) broadcast(key, { type: 'exit', exitCode });
  });
  return terminal;
}

function remove(key) {
  const terminal = terminals.get(key);
  if (terminal?.exitCode === null) terminal.proc.kill();
  terminals.delete(key);
  for (const socket of watchersOf(key)) socket.close();
  watchers.delete(key);
}

function killAll() {
  for (const { proc, exitCode } of terminals.values()) if (exitCode === null) proc.kill();
}

module.exports = { terminals, watchersOf, send, broadcast, isRunning, start, remove, killAll };
