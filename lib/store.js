// The projects and sessions Karass remembers between restarts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = process.env.KARASS_STATE_DIR || path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'karass');
const FILE = path.join(DIR, 'state.json');

function load() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { projects: [], sessions: [] };
    throw error;
  }
  // A damaged file stops startup here, so it is never silently overwritten.
  const { projects = [], sessions = [] } = JSON.parse(text);
  return { projects, sessions };
}

function save(state) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const temporary = `${FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, FILE);
}

module.exports = { load, save, DIR, FILE };
