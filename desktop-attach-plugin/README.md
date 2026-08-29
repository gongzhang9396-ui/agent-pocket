# Agent Pocket Desktop Attach

Local adapter for attaching Agent Pocket to the task host owned by the currently running Codex Desktop app.

This directory is the public source distribution. Runtime registration files, pipe names and authentication tokens are generated locally and must never be committed.

## Development installation

This experimental plugin is currently distributed as source rather than as a public one-click Marketplace package. Open the cloned Agent Pocket repository in Codex Desktop and ask Codex to use its built-in `plugin-creator` to install this directory as `agent-pocket-desktop-attach` in the local personal marketplace. Do not edit `marketplace.json` by hand. Verify the result with `codex plugin list`, then start a new task so Codex Desktop loads the installed version. See the [official Codex plugin commands](https://developers.openai.com/codex/developer-commands#plugins).

The plugin intentionally exposes only three MCP tools:

- `desktop_attach_probe`
- `desktop_attach_list_tasks`
- `desktop_attach_read_task`

These user-facing MCP tools remain read-only. They do not send prompts, interrupt turns, answer questions, approve commands, navigate the Desktop UI, or expose a network listener.

The manifest's `Interactive` capability describes the authenticated local Bridge IPC path documented below; it does not make the three user-facing MCP tools writable.

For the Agent Pocket Bridge, the plugin also creates a random Windows named pipe and writes a short-lived local registration file to `%LOCALAPPDATA%\AgentPocket\desktop-attach.json`. The registration contains a random 32-byte token and is inherited from the current Windows profile ACL. The pipe accepts only:

- `attach/probe`
- `thread/list`
- `thread/read`
- `thread/send`
- `thread/wait`

`thread/send` accepts only `{threadId, text}` and only for a Codex task returned by a recent `thread/list` call. It maps to Desktop's own `send_message_to_thread`; it does not delete locks, invoke a second app-server, interrupt tasks, or answer approvals. The pipe does not listen on TCP, LAN, OCI, or the public internet. The registration is removed when the owning plugin process exits, unless another plugin instance has already replaced it.

`thread/wait` accepts only a recently confirmed `threadId`, an optional opaque cursor, and a timeout capped at eight seconds. It maps to Desktop's `wait_threads` and returns only status/cursor metadata; assistant text, prompts, commands, and output are never copied into the IPC response or logs.

The Bridge pipe and registration file are created only when Codex Desktop provides `CODEX_APP_TOOLS_PIPE_PATH`. If an independent app-server loads the plugin, `desktop_attach_probe` reports `not-desktop-host` and that process is not allowed to publish or replace the Desktop registration.

The implementation relies on the internal `CODEX_APP_TOOLS_PIPE_PATH` environment variable supplied by Codex Desktop. This is not a public compatibility contract. If the pipe or required task tools are unavailable, write calls fail closed and Agent Pocket must not fall back to another writer for a Desktop-owned task.
