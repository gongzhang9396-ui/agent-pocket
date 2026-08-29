# Security Policy

Agent Pocket controls coding agents and may carry source code, prompts, command output and approval requests. Treat every public endpoint and credential as security-sensitive.

## Reporting a vulnerability

Please do not disclose exploitable vulnerabilities, credentials, endpoints or private task content in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/gongzhang9396-ui/agent-pocket/security/advisories/new) for this repository when available. If it is unavailable, contact the maintainer through the [GitHub profile](https://github.com/gongzhang9396-ui) without including secrets in the first message.

## Deployment rules

- Keep the Bridge bound to `127.0.0.1`.
- Expose it only through an authenticated TLS relay and an outbound SSH tunnel.
- Use a unique high-entropy WebSocket route for every deployment.
- Verify SSH host fingerprints out of band before installing the tunnel.
- Restrict project roots to the smallest required directories.
- Rotate any endpoint, token or key that was committed, logged or shared accidentally.
- Never disable Desktop task ownership checks or delete writer locks to regain access.
- Do not place model-provider API keys in the Android application.

## Sensitive local files

The repository ignores common runtime and credential files, but operators remain responsible for keeping the following outside Git:

- Bridge databases, logs, device tokens and pairing QR images;
- complete WSS endpoints and tunnel configuration;
- SSH private keys and host fingerprints;
- Firebase service accounts and Android Firebase configuration;
- Android signing keys and password exports;
- Codex task transcripts, command output and diffs.

If a secret reaches Git history, removing it from the latest commit is not sufficient. Revoke or rotate it first, then rewrite the affected history before publishing.
