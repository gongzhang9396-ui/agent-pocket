# Agent Pocket Desktop Attach

Local adapter for attaching Agent Pocket to the task host owned by the currently running Codex Desktop app.

This directory is the public source distribution. Runtime registration files, pipe names and authentication tokens are generated locally and must never be committed.

## Development installation

This experimental plugin is currently distributed as source rather than as a public one-click Marketplace package. Open the cloned Agent Pocket repository in Codex Desktop and ask Codex to use its built-in `plugin-creator` to install this directory as `agent-pocket-desktop-attach` in the local personal marketplace. Do not edit `marketplace.json` by hand. Verify the result with `codex plugin list`, then start a new task so Codex Desktop loads the installed version. Review and trust the bundled hook once in the Codex hook browser when prompted. See the [official Codex plugin commands](https://developers.openai.com/codex/developer-commands#plugins).

The plugin intentionally exposes only three MCP tools:

- `desktop_attach_probe`
- `desktop_attach_list_tasks`
- `desktop_attach_read_task`

These user-facing MCP tools remain read-only. They do not send prompts, interrupt turns, answer questions, approve commands, navigate the Desktop UI, or expose a network listener.

The manifest's `Interactive` capability describes the authenticated local Bridge IPC path documented below; it does not make the three user-facing MCP tools writable.

For the Agent Pocket Bridge, Codex Desktop initialization now makes a best-effort attempt to start a hidden, detached local host as soon as a task supplies both the Desktop tools pipe and a real task ID. The bundled `SessionStart` hook repeats the read-only `desktop_attach_probe` on task startup, resume, or clear. Codex may emit `SessionStart` before its MCP server is ready, so an explicit probe remains the observable retry path. The detached host keeps its own connection to the same Codex Desktop task channel, listens on the fixed local Windows named pipe `\\.\pipe\agent-pocket-desktop-attach-host`, and writes its registration to `%LOCALAPPDATA%\AgentPocket\desktop-attach.json`. The registration contains a fresh random 32-byte token and is inherited from the current Windows profile ACL. The pipe accepts only:

- `attach/probe`
- `project/list`
- `thread/list`
- `thread/read`
- `thread/create`
- `thread/send`
- `thread/wait`

`project/list` maps to Desktop's `list_projects`. The Bridge exposes only valid local projects whose canonical paths remain inside its configured project roots.

`thread/create` accepts a canonical `cwd`, prompt, model and reasoning effort. The path must match a local project already saved in Codex Desktop, and creation maps to Desktop's own `create_thread`.

`thread/read`, `thread/send` and `thread/wait` delegate the supplied task ID to Desktop's own task tools. `thread/read` accepts Desktop's opaque cursor so Android can restore every history page after a reinstall instead of relying on in-memory state. They do not maintain a time-based authorization cache or require a prior list call. Before a remote read or write, the Bridge asks Desktop for the current task and verifies its canonical `cwd` against the configured project roots. Persistent `desktop | bridge` ownership prevents the independent app-server from touching Desktop-owned tasks.

`thread/send` normally queues a standard user turn with `codex queue --thread <threadId> --message <text>`. The older Desktop `send_message_to_thread` path is retained only when `AGENT_POCKET_CODEX_QUEUE_DISABLED=1` is explicitly set for compatibility testing. Neither path deletes locks, invokes a second app-server, interrupts tasks, or answers approvals. `thread/wait` caps timeouts at eight seconds and returns status/cursor metadata plus at most 20,000 characters from Desktop's latest assistant message. It never returns the user prompt, command output, approval details, or tokens, and the content is not written to plugin logs. When the controlled task is also the host task, the plugin borrows another idle Codex task only as the caller context for `wait_threads`; it never sends content to that task. The pipe does not listen on TCP, LAN, OCI, or the public internet.

The detached host is not a watchdog: it does not monitor, restart, or take ownership of any Codex task. It exists only to keep the authenticated local IPC adapter available after the short-lived MCP process that performed the probe exits. When the underlying Codex Desktop task channel closes, the host exits and removes its registration. A later Desktop probe may start a new host with a new token.

The Bridge pipe and registration file are created only when Codex Desktop provides `CODEX_APP_TOOLS_PIPE_PATH`. If an independent app-server loads the plugin, `desktop_attach_probe` reports `not-desktop-host` and that process is not allowed to publish or replace the Desktop registration. A new plugin process also needs a real Desktop caller task id from the host environment or an initial `desktop_attach_probe`; it never fabricates a caller id for background Bridge requests.

The implementation relies on the internal `CODEX_APP_TOOLS_PIPE_PATH` environment variable supplied by Codex Desktop. This is not a public compatibility contract. If the pipe or required task tools are unavailable, write calls fail closed and Agent Pocket must not fall back to another writer for a Desktop-owned task.
