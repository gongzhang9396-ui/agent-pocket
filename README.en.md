# Agent Pocket

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

Agent Pocket is an Android remote console for Codex. Codex Desktop, your source code, and the execution environment remain on your own Windows computer; your phone connects through a self-hosted Relay to view and continue real Desktop tasks. It does not consume an Android VPN slot, and the phone does not need to sign in to ChatGPT.

The current v2 architecture supports administrator-provisioned accounts, multiple users, and multiple Hosts. It is intended for self-hosting by individuals, families, or small teams. The legacy invitation flow remains available only for compatibility and is no longer the normal installation path. The project is still experimental: Desktop Attach depends on internal local capabilities of Codex Desktop and may require adaptation after Desktop updates.

The current stable release is **v0.3.2**. Its version is generated centrally from the root `VERSION` file and shared by the Android app, Windows Host, Bridge, Relay, and Desktop Attach.

See the [usage guide](docs/USAGE.md) for deployment, pairing, daily use, recovery, updates, and redaction procedures.

## Direct installation for test users

The public repository contains only sanitized source code and example configuration. Installable v0.3.2 binaries are distributed separately by an administrator through a private release repository:

- `Agent-Pocket-0.3.2-release.apk` — install on an Android phone;
- `AgentPocketHost-0.3.2-windows-x64.exe` — install on each Windows computer to be controlled remotely;
- `Agent-Pocket-0.3.2-bundle.zip` — bundle containing Android, Windows Host, checksums, and Chinese documentation.

The administrator first creates a standard user in the Relay admin console and sends the username and initial password privately. A private build can be preconfigured with the administrator's Relay address. The normal flow is: install Windows Host → the Pairing Assistant opens automatically → scan its QR code on Android → enter the account credentials → Relay atomically activates the first phone → the computer is paired automatically → open the task list. No invitation link or second QR scan is required.

The installer does not require administrator privileges. Agent Pocket is not currently Authenticode-signed, so Windows may show a SmartScreen warning on first installation. Verify the package against the accompanying `.sha256` file or `SHA256SUMS.txt`.

For a first installation by a friend or tester, follow the [Chinese quick-start guide](docs/FRIEND-QUICKSTART-zh-CN.md).

## Capabilities

- One Relay account can pair with multiple Windows Hosts and multiple Android phones.
- The home screen aggregates Codex tasks from every computer and can filter tasks and online status by Host.
- Read history, create tasks, continue existing tasks, stream replies with Markdown rendering, and inspect native diffs. The inbox groups tasks by project and displays unread badges.
- New tasks use Bridge mode by default and run through the Host's `codex app-server`. This works with third-party model-provider channels such as cc-switch and supports phone-side approvals, answers to structured questions, interruption, native Plan mode (plan without editing files), persistent task goals, and end-to-end encrypted image or small-file attachments. These tasks also appear in Codex Desktop. You may instead create a native Desktop task, which requires an official model channel and can attach images or small files through temporary paths on the Host.
- The home screen reports the real state of both the Host and Codex Desktop. If Desktop is not running, the phone can ask the Windows Host to launch the configured Codex Desktop application.
- The first phone for a pre-provisioned account is approved automatically after the correct password is verified. Additional phones for an activated account still require approval from a trusted phone. A Host is paired with a five-minute QR code.
- Task bodies, prompts, code, and commands are end-to-end encrypted. Relay stores only routing metadata and ciphertext.
- Android and Windows Host support signed updates. Host replacement is deferred while tasks are active.

Native Desktop tasks do not yet have a stable plugin interface for hard interruption, native approval responses, or structured question answers. Agent Pocket never starts a second writer, deletes a lock, or simulates coordinate clicks to take over a task.

The Android v0.3 interface direction and attachment interactions are shown in the [visual prototype](docs/prototypes/agent-pocket-v03-overview.png). Codex is integrated. The current development code also includes a [Grok CLI integration](docs/GROK-CLI.md): sync computer conversations, continue them on the phone, create tasks, stream progress, handle approvals, and interrupt phone turns. This integration is not yet in the stable release. Kimi Code is not yet integrated.

## Architecture

The diagrams below were generated with [Archify](https://github.com/tt-a1i/archify) from evidence in the actual codebase. The PNG can be previewed directly. Download the interactive HTML and open it in a local browser for search, zoom, theme switching, and links to source evidence. Account activation and private-update paths added in v0.3.2 are described in the deployment sections below.

[![Agent Pocket system architecture](docs/diagrams/agent-pocket-system.architecture.visual-check.1440x900.light.png)](docs/diagrams/agent-pocket-system.architecture.html)

### Desktop, app-server, and writer lock

Codex Desktop and the `codex app-server --stdio` started by Host are two independent task hosts and writers. Their tasks may appear in the same Codex Desktop list, but they must never write to the same thread concurrently:

| Task owner | Sole writer | Phone write path | Capability boundary |
|---|---|---|---|
| `desktop` | Codex Desktop | Host → Desktop Attach → Desktop's own task tools / queue | Can continue and wait; hard interruption, approvals, and structured questions must still be handled in Desktop |
| `bridge` | Independent `codex app-server` | Host → JSON-RPC stdio | Supports continuation, steer, interruption, approvals, questions, and Plan; it can be viewed in Desktop, but must not be continued from Desktop |

Write protection has two separate layers:

1. Host SQLite's `thread_owners(thread_id, owner)` is Agent Pocket's persistent routing guard, not a Codex lock. After a task is first claimed as `desktop` or `bridge`, every phone write stays on that path; ownership is never switched automatically.
2. Codex's active-turn / writer lock is runtime mutual exclusion. If another writer is executing the task, Host returns `THREAD_BUSY_EXTERNAL`. Desktop Attach also fails closed when it is not ready or detects `not-desktop-host`.

The three MCP tools exposed to users by the Desktop Attach plugin remain read-only. Remote writes from Host travel through a separate local named pipe protected by a random token, then delegate to Desktop's own task tools. A failure never deletes locks, starts a second writer, or falls back from a Desktop-owned task to app-server.

[![Desktop, app-server, and writer lock](docs/diagrams/agent-pocket-writer-ownership.architecture.visual-check.1440x900.light.png)](docs/diagrams/agent-pocket-writer-ownership.architecture.html)

[Interactive version](docs/diagrams/agent-pocket-writer-ownership.architecture.html) · [PNG preview](docs/diagrams/agent-pocket-writer-ownership.architecture.visual-check.1440x900.light.png) · [JSON source specification](docs/diagrams/agent-pocket-writer-ownership.architecture.json)

More diagrams:

- [Create, continue, and writer-conflict sequence](docs/diagrams/agent-pocket-task-roundtrip.sequence.html) · [PNG preview](docs/diagrams/agent-pocket-task-roundtrip.sequence.visual-check.1440x900.light.png) · [JSON source specification](docs/diagrams/agent-pocket-task-roundtrip.sequence.json)
- [End-to-end attachment data flow](docs/diagrams/agent-pocket-attachments.dataflow.html) · [PNG preview](docs/diagrams/agent-pocket-attachments.dataflow.visual-check.1440x900.light.png) · [JSON source specification](docs/diagrams/agent-pocket-attachments.dataflow.json)
- [Synchronization and failure-recovery lifecycle](docs/diagrams/agent-pocket-sync-recovery.lifecycle.html) · [PNG preview](docs/diagrams/agent-pocket-sync-recovery.lifecycle.visual-check.1440x900.light.png) · [JSON source specification](docs/diagrams/agent-pocket-sync-recovery.lifecycle.json)
- [Diagram index, generation, and validation receipts](docs/diagrams/README.md)

The older [v0.2.9 architecture and information flow](docs/ARCHITECTURE-v0.2.9.md) remains as a historical baseline. Some default paths, synchronization behavior, and release status in that document have been superseded by v0.3.2.

Relay listens only on `127.0.0.1:8790` and is exposed through a dedicated Caddy HTTPS subdomain. Windows Host connects outbound to Relay; no SSH reverse tunnel, inbound Windows port, or public firewall rule is required.

## Encryption and identity

- Usernames are case-insensitive. Passwords are stored as scrypt digests with independent salts.
- Access tokens last 15 minutes and refresh tokens last 30 days. The database stores token hashes only, and devices, Hosts, and refresh tokens can be revoked independently.
- Each account has an Ed25519 signing identity and X25519 encryption identity. Every device and Host also has independent keys.
- Phone and Host communicate through an ephemeral X25519 channel signed by both parties. The outer envelope is AEAD associated data, and strict counters reject replayed or out-of-order injection.
- Windows Host encrypts its private key, Host token, and content keys at rest with DPAPI for the current Windows user. Channel-handshake IDs are persisted to prevent Relay from replaying them across restarts during their validity period.
- Host events and snapshots use a persistent outbox. If an acknowledgement is lost, Host retransmits the exact same ciphertext; Relay returns an idempotent success only for an identical duplicate envelope.
- Relay retains at most the latest 24 hours or 20,000 encrypted events per Host, plus the latest encrypted task snapshot. Full history and all writes still require Host to be online.
- FCM contains only `hostId/eventId/type`; the app fetches and decrypts content from Relay after a notification is opened.

This is administrator-managed end-to-end encryption, not absolute zero knowledge. During initial administrator setup, the browser generates an offline recovery private key. Relay stores only the recovery public key and sealed data. An administrator holding the recovery private key and passphrase can explicitly recover devices and may ultimately gain the ability to read that user's data. Every recovery is recorded in the audit log.

## Components and technology

| Component | Version | Technology |
|---|---:|---|
| Android | 0.3.2 | Kotlin, Jetpack Compose Material 3, OkHttp, kotlinx.serialization, CameraX / ML Kit, Firebase Messaging, libsodium |
| Windows Host / Bridge | 0.3.2 | Node.js 24, TypeScript, `ws`, built-in Node SQLite, libsodium, PowerShell, Task Scheduler, Inno Setup |
| Desktop Attach | 0.3.2 | Codex plugin, Windows named pipe, random local token, Codex Desktop task tools |
| Relay | 0.3.2 | Node.js 24, TypeScript, `ws`, built-in Node SQLite WAL, firebase-admin, libsodium |
| Admin console | 0.3.2 | React, TypeScript, Vite, Lucide; HttpOnly/Secure/SameSite=Strict cookies and CSRF protection |

Android 8.0 or newer is required (`minSdk 26`, `compileSdk/targetSdk 36`). Windows Host is installed per Windows user; separate users on the same computer appear as separate Hosts.

## Quick start

### 1. Relay

```bash
cd relay
npm ci
npm test
npm run build
```

See the [Relay deployment guide](relay/deploy/README.md) for production configuration and systemd/Caddy steps. Relay must be placed behind a dedicated HTTPS subdomain; its loopback port must never be exposed publicly. After the first start, run:

```bash
node dist/cli.js bootstrap
```

Open the one-time link within 15 minutes, create the administrator account, and store the encrypted recovery file downloaded by the browser offline. Never upload the recovery file or its passphrase to Relay or commit them to Git. Then use **Create user** in the admin console to set a username, display name, and initial password. The account appears as **Pending first login** and is activated when the user first signs in from Android. Legacy invitation APIs remain compatible, but their UI is available only under **Advanced: legacy invitation compatibility**.

### 2. Windows Host

The per-user Inno Setup installer is recommended. During first installation, confirm the Relay HTTPS address, project allowlist, and attachment temporary directory. When installation finishes, the **Agent Pocket Pairing Assistant** opens automatically and displays a QR code valid for five minutes. Android can scan it before login and fills the Relay address automatically. Entering the administrator-provided username and password completes first-phone activation and Host pairing in one flow. Expired QR codes can be refreshed in the assistant, which can also be reopened from the Start menu.

The attachment directory may be placed on another local disk with sufficient free space. Older installations without the setting fall back to `%LOCALAPPDATA%\AgentPocket\attachments`. Codex Desktop must be signed in and run by the same Windows user.

The installer registers the Host logon-start task and the Desktop Attach plugin. When Codex Desktop creates or resumes a task, the plugin's `SessionStart` hook automatically discovers and establishes the Attach channel. Codex Desktop must already be open under the same Windows user; this never bypasses Desktop writer ownership.

Uninstall is available from Windows **Installed apps** and the Start menu. By default it removes only the program, scheduled task, and Desktop Attach registration, preserving this computer's local account and pairing data for reinstallation. The uninstall confirmation can optionally remove `%LOCALAPPDATA%\AgentPocket`, causing this computer to leave the account and require pairing after the next installation. This does not delete the Relay account, phones, other computers, or attachment directories configured on other disks.

For source development:

```powershell
cd bridge
npm ci
npm test
npm run relay-enroll -- https://relay.example.com
npm start
```

See the [Windows Host installation guide](installer/windows/README.md) for building the installer, Ed25519 release signing, and in-place upgrades. The installer does not change system proxy settings, Windows Firewall, or other proxy services.

### 3. Android

```powershell
cd android
.\gradlew.bat --no-daemon --no-configuration-cache :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
```

Release APKs are built with a keystore stored outside the repository. The phone signs in only to the Relay account; model requests are still made by Codex signed in on Windows.

For test users on a fixed Relay, inject the HTTPS address during the private build without committing the real value to public source:

```powershell
.\android\scripts\build-release.ps1 -DefaultRelayUrl https://relay.example.com
```

An existing user's Relay address in Android Keystore/encrypted preferences takes precedence and is never replaced by the build default. The standard UI no longer displays invitation registration; legacy invitation deep links remain compatible.

The Windows Host installer likewise accepts `-DefaultRelayUrl` or `AGENT_POCKET_DEFAULT_RELAY_URL` to inject an editable initial value. An in-place upgrade never overwrites an existing `host-config.json`.

## Private releases and authenticated updates

`scripts/publish-private-release.ps1` builds Android and Windows artifacts from the current public-source commit. It requires the private Relay address and offline Ed25519 private key to be supplied explicitly. The script produces signed manifests for both platforms, SHA-256 checksums, installers, Chinese documentation, and a bundle. In `-Publish` mode it accepts only a private GitHub repository, uploads assets to the Relay allowlisted directory only after verifying the pinned SSH Ed25519 fingerprint, and registers the release.

Android uses an approved device token and Host uses a Host token to access `/api/updates/{platform}/latest` and its corresponding asset. Relay provides no anonymous download. The manifest, version, size, SHA-256, signature, and server-relative path must all match the database allowlist. Version 0.3.2 itself must be distributed manually; starting with 0.3.2, subsequent updates are delivered through Relay.

## v0.3.2 changes and verification

This release addresses the paths that caused the most friction in recent real-device testing:

- Tasks that previously failed to synchronize enter a pending-refresh queue and are read again automatically after Host recovers.
- Bridge and Plan tasks can be created correctly after selecting a model.
- Archived tasks are filtered from the Android task list.
- Task details are read in pages and merged with real-time events so older results cannot overwrite newer messages.
- Host synchronization coalesces repeated triggers with single-flight logic, and heavy JSON parsing moves off the main thread to reduce stutter.
- Desktop Attach is installed with Host and automatically discovered when a Codex Desktop task starts or resumes.
- Windows Host supports a separate attachment temporary directory. Android and Host builds can both preconfigure an editable Relay address.
- Relay schema v2 adds pre-provisioned accounts, persistent login rate limits, and private update registration. First activation, password changes/resets, and session revocation have server-side test coverage.
- The Pairing Assistant opens after Windows installation. Android can scan before account activation and then continue Host pairing automatically.
- Subsequent Android and Host updates use authenticated Relay downloads and Ed25519-signed manifests. Host defers installation during active tasks and restores its verified backup on failure.

Current source verification: Android JVM 31/31, Bridge 67/67, Relay 27/27. Final release still requires Release/R8/APK signing and end-to-end real-device acceptance testing on a build machine holding the offline signing material. On Windows, if the repository path contains non-ASCII characters and every Gradle test worker reports `ClassNotFoundException`, run the tests through a temporary ASCII drive mapping. This is a Gradle 8.14.3 argfile path issue, not missing test classes.

## Migrating from v1

1. Back up the old Bridge data and Relay/Caddy configuration.
2. Deploy the new Relay subdomain and `127.0.0.1:8790` service without changing existing proxy sites.
3. Install Host v2 on each Windows computer and pair it by QR code. Verify the task list, Desktop Attach, and real-time events.
4. Install Android v2 and sign in to Relay. v2 does not read old direct-connection credentials.
5. After every Host is verified, retire the old SSH tunnel, revoke the old Bridge device token, and remove the old Caddy route.

Do not delete the local Bridge database or Codex history. Phone credentials are intentionally incompatible between v1 and v2; this is an explicit migration.

## Security boundaries

- Relay and Bridge listen only on loopback; Host initiates outbound connections only.
- Every database query must include `account_id`; each Host belongs exclusively to one user.
- Every `cwd` must be an existing absolute canonical path inside the allowlist.
- Phone approvals do not provide permanent permission; Desktop ownership and writer locks cannot be bypassed.
- Host updates must pass fixed Ed25519 public-key, signed-manifest, file-size, and SHA-256 verification.
- Never commit complete Relay credentials, tokens, private keys, recovery files, Firebase configuration, signing material, task contents, or operational handover documents.

Read [SECURITY.md](SECURITY.md) before a public deployment.

## Project structure

```text
android/                 Native Android client
bridge/                  Windows Bridge and Relay Connector
desktop-attach-plugin/   Experimental Codex Desktop Attach plugin
installer/windows/       Per-user Host installer and signed updates
protocol/                Cross-platform cryptographic test vectors
relay/                   Multi-user Relay, admin console, and deployment scripts
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Community

- [LINUX DO](https://linux.do/)
