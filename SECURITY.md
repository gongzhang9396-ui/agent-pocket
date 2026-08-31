# Security Policy

Agent Pocket controls coding agents and may carry source code, prompts, command output and approval requests. Treat every endpoint, device and release credential as security-sensitive.

## Reporting a vulnerability

Do not disclose exploitable vulnerabilities, credentials, endpoints or private task content in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/gongzhang9396-ui/agent-pocket/security/advisories/new) when available. Otherwise contact the maintainer through the [GitHub profile](https://github.com/gongzhang9396-ui) without including secrets in the first message.

## v2 trust model

- Relay is an authenticated routing and encrypted-cache service, not a Codex execution host.
- Task IDs, prompts, code, commands and output stay inside Android-to-Host encrypted envelopes.
- Routing metadata remains visible to Relay: account, Host, device, channel, counter, event type, timing and ciphertext size.
- The offline administrator recovery private key can recover account keys to a new device. This is administrator-custodied E2EE, not absolute zero knowledge.
- Codex Desktop remains the only writer for Desktop-owned tasks. Never remove writer locks or fall back to a second app-server.

## Deployment rules

- Keep Relay on `127.0.0.1:8790` and Bridge on `127.0.0.1:8787`.
- Put Relay behind a dedicated HTTPS site; do not expose either loopback port publicly.
- Keep every database query scoped by `account_id`; a Host belongs to exactly one account.
- Restrict project roots to the smallest required existing directories.
- Use independent device, Host, refresh and release credentials; revoke them separately when lost.
- Preserve strict channel counters and authenticated associated data. Do not add a permissive replay fallback.
- Keep Host identity secrets under Windows CurrentUser DPAPI protection and preserve accepted-channel replay records across restarts.
- Persist event and snapshot outboxes before upload; an acknowledgement retry must reuse the exact same signed metadata and ciphertext.
- Do not place model-provider API keys, recovery private keys or Host update private keys in Android, Relay or Git.
- Do not modify unrelated proxies, VPNs, firewall rules or UDP listeners as part of Agent Pocket deployment.

## Release rules

- Android updates must retain the Android application signing identity and match the published SHA-256.
- Host updates require a fixed Ed25519 public key, signed canonical declaration, exact filename/size and SHA-256.
- Host installer staging must copy first-party runtime files through an explicit allowlist; never package source directories recursively.
- Relay releases require detached Ed25519 verification, a pre-deploy SQLite backup, health check and executable rollback path.
- Host activity state is fail closed: unknown, stale or nonzero activity prevents replacement.
- Public releases must not include runtime databases, logs, task content, crash dumps, local config, private operational notes or build secrets.

## Sensitive files

Keep these outside Git and release archives:

- Relay and Bridge databases, WAL files, logs, access/refresh/Host tokens and pairing QR codes;
- account/device/Host private keys, administrator recovery file and its passphrase;
- Ed25519 release private keys and Android keystore/password exports;
- Firebase service accounts and Android `google-services.json`;
- real Relay domains when private, server IPs, SSH material and private operations notes;
- Codex transcripts, command output, diffs and crash reports.

If a secret reaches Git history, deleting it from the latest commit is insufficient. Revoke or rotate it first, then rewrite the affected history before publishing.
