# karass

A web dashboard for managing Claude Code sessions.

## Prototype

Claude Code sessions and a shell for each project, in real terminals in the browser.

Requires Node.js, the `claude` CLI, and `make`, a C++ compiler and Python to build `node-pty`.

```bash
npm install
npm start -- ~/Projects/some-project   # the folder is optional
```

Open the full link it prints.

- **Projects** are listed on the left. Add one with `+` at the top (a missing
  folder is created), and start a session with `+` next to a project.
- **Fork** (`⑂`) starts a new session with another session's conversation. It works
  on Karass sessions and on ones running in your own terminals, which are tagged
  `terminal`. The original is left as it was.
- **Manager** (`★` next to a project) is a session that hands out work. It asks
  Karass to start workers, and you press Launch, Edit or Decline in the panel on
  the right. With **Autopilot** on, it starts workers itself: at most 3 busy at
  once, Haiku or Sonnet, high effort at most. Use `⇥` to make an existing session
  one of its workers. Fork a session when creating the manager to give it that
  session's context.
- Nothing stops a session from merging pull requests, and all sessions share the
  project folder.
- **Resize** Claude Code and the shell by dragging the line between them.
  Double-click it to reset.
- **Remove** (`×`) stops a session and takes it off the list. The conversation
  stays on disk.

Terminals keep running when you reload the page and stop when you stop the server.
Karass remembers its sessions in `~/.local/state/karass/`, and selecting a stopped
one resumes it.

The server listens only on `127.0.0.1` and requires the token in that link.
Anyone with the link on this computer can run commands as you, so don't share it.
