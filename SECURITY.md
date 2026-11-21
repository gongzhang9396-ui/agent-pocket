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
- Experimental Desktop approval forwarding is limited to live command/file requests on the local native owner. Native request identity includes the thread, owner client and typed request ID; the full request fingerprint and canonical project directory are checked again before forwarding. Persistent request reservations prohibit repeat submissions after unknown outcomes, even with a new operation ID or a Host restart. No persistent approval scope, identity-verification challenge or generic native RPC is exposed.

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

## Web client trust boundary (v3)

- `/app` is same-origin with Relay and is disabled unless `AGENT_POCKET_WEB_ENABLED=true`; `/admin` remains a separate administrator-cookie surface and `/invite` remains an activation surface.
- Web login sends the account password over the configured HTTPS origin. Relay checks the password and, when enabled, standard SHA-1/6-digit/30-second TOTP. TOTP authenticates the online session; it is deliberately not part of the static key-package KDF.
- Relay stores only the password-encrypted web key package (`Argon2id + XChaCha20-Poly1305`) and routing metadata. The browser derives the package key locally, unlocks the account signing/encryption keys and `contentKey`, and keeps access tokens in memory.
- A self-hosted Relay process, HTTPS terminator and `/app` JavaScript are trusted components. A malicious Relay can record the password and TOTP or replace the JavaScript and therefore can decrypt the package. TOTP, CSP and ciphertext-at-rest do not defend against a malicious Relay.
- Web devices use independent Ed25519/X25519 keys. Automatic approval requires both a signature challenge and an X25519 sealed-challenge response; password or TOTP alone never approves a device. Device revocation closes its WebSockets and all tabs clear in-memory keys.
- First-time iPhone accounts are explicitly provisioned with a durable web-only activation policy. Legacy Android activation cannot claim them. Browser-generated account/device keys prove both Ed25519 and X25519 possession; the challenge binds the configured origin, provision, credential verifier, operation and encrypted material. Activation commits the account and encrypted package atomically, forces TOTP enrollment, and issues no device or session. Exact completed-request receipts support uncertain-result recovery; credential reset and cancellation invalidate pending transactions.
- Host web pairing uses the same five-minute enrollment capability as Android. The browser rejects foreign Relay origins, shows the Host name/key fingerprint for confirmation, and seals the unchanged account content key to that Host. The link secret stays in the URL fragment until consumed, then only in page memory; it is never placed in server access-log queries or installed release files. The local assistant QR/link files remain sensitive until expiration.
- Lock clears plaintext keys, task contents and channels while retaining only the encrypted IndexedDB record. Logout revokes the web session. “Forget device” clears IndexedDB first and reports server revocation separately if the network is unavailable. Closing a tab only closes its browser connection; it never interrupts a Host task.
- Browser WebSockets use a single-use, 60-second ticket in `Sec-WebSocket-Protocol`; long-lived access and refresh tokens are never placed in a URL. Service Worker caching is limited to the public static shell and never includes API responses, tokens, key packages, task ciphertext or attachments.
- Browser Markdown is escaped and rendered through a small URL allowlist; the web client does not inject arbitrary HTML or executable attachment content. Attachment names/MIME types are validated before upload and unknown types are not rendered. Attachments remain capped at three total, 450 KiB per image, 512 KiB per file and 800 KiB aggregate, with the final encrypted envelope measured before send.

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
