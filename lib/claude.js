// Everything Karass knows about the Claude Code CLI.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE = process.env.KARASS_CLAUDE || 'claude';
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// If Karass is started from inside a Claude session, don't pass that session's
// identity on to the new ones.
const SESSION_VARS = [
  'AI_AGENT', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID',
];
const childEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
for (const name of SESSION_VARS) delete childEnv[name];

// A session can only be resumed or forked once its transcript exists.
function hasConversation(sessionId) {
  const root = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  try {
    return fs.readdirSync(root).some((folder) =>
      fs.existsSync(path.join(root, folder, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

// Arguments that start a session record for the first time, or bring it back.
function sessionArgs(record, extra = []) {
  const started = hasConversation(record.sessionId);
  const args = [];
  if (started) {
    args.push('--resume', record.sessionId);
  } else if (record.forkOf) {
    args.push('--resume', record.forkOf, '--fork-session', '--session-id', record.sessionId);
  } else {
    args.push('--session-id', record.sessionId);
  }
  args.push(`--name=${record.name}`);
  if (record.model) args.push('--model', record.model);
  if (record.effort) args.push('--effort', record.effort);
  args.push(...extra);
  // `--` stops a task that begins with a dash from being read as an option.
  if (!started && record.task) args.push('--', record.task);
  return args;
}

let cache = { at: 0, agents: [], error: null };
let pending = null;

// Every running Claude session on this computer, refreshed at most every 2s.
function listAgents({ fresh = false } = {}) {
  if (pending) return pending;
  if (!fresh && Date.now() - cache.at < 2000) return Promise.resolve(cache);
  pending = new Promise((resolve) => {
    execFile(CLAUDE, ['agents', '--json'], { env: childEnv, timeout: 10_000 }, (error, stdout) => {
      let { agents } = cache;
      let problem = null;
      try {
        if (error) throw error;
        agents = JSON.parse(stdout).filter((a) => a.sessionId && a.cwd);
      } catch {
        problem = 'Could not read the session list from Claude Code.';
      }
      cache = { at: Date.now(), agents, error: problem };
      pending = null;
      resolve(cache);
    });
  });
  return pending;
}

module.exports = {
  CLAUDE, MODELS, EFFORTS, childEnv, hasConversation, sessionArgs, listAgents,
};
