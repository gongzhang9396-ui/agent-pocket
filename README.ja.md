# Agent Pocket

[简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

Agent Pocket は、Android から遠隔で Codex を操作するためのコンソールです。Codex Desktop、ソースコード、実行環境は自分の Windows PC に置いたまま、スマートフォンからセルフホストした Relay 経由で実際の Desktop タスクを閲覧・継続できます。Android 側の VPN 接続枠を消費せず、スマートフォンで ChatGPT にログインする必要もありません。

現在の v2 は、管理者が事前作成するアカウント、マルチユーザー、マルチ Host に対応し、個人、家庭、小規模チームによるセルフホスティングを想定しています。従来の招待フローは互換性のためだけに残され、通常のインストール手順では使用しません。プロジェクトはまだ実験段階です。Desktop Attach は Codex Desktop の内部ローカル機能に依存するため、Desktop の更新後に対応が必要になる場合があります。

現在の安定版は **v0.3.2** です。バージョン番号はルートの `VERSION` から一元的に生成され、Android アプリ、Windows Host、Bridge、Relay、Desktop Attach で共通です。

導入、ペアリング、日常利用、復旧、更新、機密情報の除去については [利用ガイド](docs/USAGE.md) を参照してください。

## テストユーザー向けの直接インストール

公開リポジトリには、機密情報を除去したソースコードとサンプル設定だけを保存します。インストール可能な v0.3.2 バイナリは、管理者が非公開リリースリポジトリを通じて個別に配布します。

- `Agent-Pocket-0.3.2-release.apk` — Android スマートフォンにインストールします。
- `AgentPocketHost-0.3.2-windows-x64.exe` — 遠隔操作する各 Windows PC にインストールします。
- `Agent-Pocket-0.3.2-bundle.zip` — Android、Windows Host、チェックサム、中国語ドキュメントをまとめた bundle です。

管理者は Relay の管理画面で一般ユーザーを作成し、ユーザー名と初期パスワードを安全な方法で本人に伝えます。非公開ビルドには、管理者が指定した Relay アドレスをあらかじめ設定できます。通常の流れは、Windows Host をインストール → ペアリングアシスタントが自動起動 → Android で QR コードをスキャン → アカウント情報を入力 → Relay が最初のスマートフォンを原子的に有効化 → PC を自動ペアリング → タスク一覧を開く、となります。招待リンクも、2 回目の QR スキャンも必要ありません。

インストーラーは管理者権限を要求しません。現時点では Authenticode 署名がないため、Windows の初回インストール時に SmartScreen の警告が表示される場合があります。配布パッケージに含まれる `.sha256` または `SHA256SUMS.txt` と照合してください。

友人やテストユーザーが初めて導入する場合は、[中国語クイックスタート](docs/FRIEND-QUICKSTART-zh-CN.md) に従ってください。

## 主な機能

- 1 つの Relay アカウントに、複数の Windows Host と複数の Android スマートフォンをペアリングできます。
- ホーム画面にはすべての PC の Codex タスクが集約され、Host ごとにオンライン状態やタスクを絞り込めます。
- 履歴の閲覧、タスクの作成・継続、Markdown 形式の応答のリアルタイム同期、ネイティブ diff の確認に対応します。受信トレイはプロジェクト単位でまとめられ、未読バッジも表示されます。
- 新規タスクは既定で Bridge モードを使用し、Host の `codex app-server` で実行されます。cc-switch などのサードパーティ製モデルチャンネルと互換性があり、スマートフォンからの承認、構造化された質問への回答、中断、ネイティブ Plan モード（ファイルを変更せずに先に計画）、永続的なタスク目標、エンドツーエンド暗号化された画像・小容量ファイルの添付に対応します。タスクは Codex Desktop の一覧にも表示されます。公式モデルチャンネルを必要とするネイティブ Desktop タスクを作成し、Host 上の一時ファイルパスを介して画像や小容量ファイルを添付することもできます。
- ホーム画面には Host と Codex Desktop の実際の稼働状態が表示されます。Desktop が起動していない場合は、スマートフォンから Windows Host に、設定済みの Codex Desktop アプリを起動するよう要求できます。
- 事前作成アカウントの最初のスマートフォンは、正しいパスワードの確認後に自動承認されます。有効化済みアカウントへ追加するスマートフォンは、引き続き信頼済みスマートフォンからの承認が必要です。Host のペアリングには 5 分間有効な QR コードを使用します。
- タスク本文、プロンプト、コード、コマンドはエンドツーエンドで暗号化されます。Relay が保存するのはルーティング用メタデータと暗号文だけです。
- Android と Windows Host は署名付き更新に対応します。Host に実行中のタスクがある場合、置き換えは延期されます。

ネイティブ Desktop タスクの強制中断、ネイティブ承認への応答、構造化された質問への回答には、まだ安定したプラグインインターフェースがありません。Agent Pocket が 2 つ目の writer を起動したり、ロックを削除したり、座標クリックを模擬してタスクを強制的に奪ったりすることはありません。

Android v0.3 の UI 方針と添付操作は [ビジュアルプロトタイプ](docs/prototypes/agent-pocket-v03-overview.png) を参照してください。Codex は統合済みです。現在の開発コードには [Grok CLI 連携](docs/GROK-CLI.md) も含まれ、PC の会話の同期とスマートフォンからの継続、新規タスク、進捗のストリーミング、承認、スマートフォンから送信した処理の中断に対応しています。この連携は安定版にはまだ含まれていません。Kimi Code は未対応です。

## アーキテクチャ

以下の図は、実際のコードを根拠として [Archify](https://github.com/tt-a1i/archify) で生成しました。PNG はそのままプレビューできます。インタラクティブ HTML をダウンロードしてローカルブラウザーで開くと、検索、ズーム、テーマ切り替え、ソース根拠へのリンクを利用できます。v0.3.2 で追加されたアカウント有効化と非公開更新の経路は、後述の導入セクションで説明します。

[![Agent Pocket システムアーキテクチャ](docs/diagrams/agent-pocket-system.architecture.visual-check.1440x900.light.png)](docs/diagrams/agent-pocket-system.architecture.html)

### Desktop、app-server、writer lock

Codex Desktop と、Host が起動する `codex app-server --stdio` は、独立した 2 つの task host / writer です。両方のタスクが同じ Codex Desktop の一覧に表示されることはありますが、同じ thread を同時に書き込むことはできません。

| task owner | 唯一の writer | スマートフォンからの書き込み経路 | 機能上の境界 |
|---|---|---|---|
| `desktop` | Codex Desktop | Host → Desktop Attach → Desktop 自身の task tools / queue | 継続と待機に対応。強制中断、承認、構造化された質問は Desktop 側で処理する必要があります |
| `bridge` | 独立した `codex app-server` | Host → JSON-RPC stdio | 継続、steer、中断、承認、質問、Plan に対応。Desktop から閲覧できますが、Desktop 側から継続しないでください |

書き込み保護には、別々の 2 層があります。

1. Host SQLite の `thread_owners(thread_id, owner)` は Agent Pocket 固有の永続的なルーティングガードであり、Codex のロックではありません。最初に `desktop` または `bridge` として owner が確定すると、スマートフォンからの書き込みは常に同じ経路へ送られ、owner が自動的に切り替わることはありません。
2. Codex の active turn / writer lock は、実行時の相互排他です。別の writer がタスクを実行中の場合、Host は `THREAD_BUSY_EXTERNAL` を返します。Desktop Attach が未準備の場合や `not-desktop-host` を検出した場合も、安全側に倒して処理を失敗させます。

Desktop Attach プラグインがユーザーに公開する 3 つの MCP ツールは、引き続き読み取り専用です。Host からのリモート書き込みは、ランダム token で保護された別のローカル named pipe を通り、Desktop 自身の task tools に委譲されます。失敗時にロックを削除したり、2 つ目の writer を起動したり、Desktop 所有タスクを app-server へ切り替えたりすることはありません。

[![Desktop、app-server、writer lock](docs/diagrams/agent-pocket-writer-ownership.architecture.visual-check.1440x900.light.png)](docs/diagrams/agent-pocket-writer-ownership.architecture.html)

[インタラクティブ版](docs/diagrams/agent-pocket-writer-ownership.architecture.html) · [PNG プレビュー](docs/diagrams/agent-pocket-writer-ownership.architecture.visual-check.1440x900.light.png) · [JSON ソース仕様](docs/diagrams/agent-pocket-writer-ownership.architecture.json)

その他の図：

- [作成・継続・writer 競合のシーケンス](docs/diagrams/agent-pocket-task-roundtrip.sequence.html) · [PNG プレビュー](docs/diagrams/agent-pocket-task-roundtrip.sequence.visual-check.1440x900.light.png) · [JSON ソース仕様](docs/diagrams/agent-pocket-task-roundtrip.sequence.json)
- [添付ファイルのエンドツーエンド・データフロー](docs/diagrams/agent-pocket-attachments.dataflow.html) · [PNG プレビュー](docs/diagrams/agent-pocket-attachments.dataflow.visual-check.1440x900.light.png) · [JSON ソース仕様](docs/diagrams/agent-pocket-attachments.dataflow.json)
- [同期と障害復旧のライフサイクル](docs/diagrams/agent-pocket-sync-recovery.lifecycle.html) · [PNG プレビュー](docs/diagrams/agent-pocket-sync-recovery.lifecycle.visual-check.1440x900.light.png) · [JSON ソース仕様](docs/diagrams/agent-pocket-sync-recovery.lifecycle.json)
- [図の索引、生成方法、検証結果](docs/diagrams/README.md)

以前の [v0.2.9 アーキテクチャと情報フロー](docs/ARCHITECTURE-v0.2.9.md) は、過去の基準として残しています。同文書の既定パス、同期方針、バージョン状態の一部は v0.3.2 で置き換えられています。

Relay は `127.0.0.1:8790` だけで待ち受け、専用サブドメインの Caddy サイトから公開します。Windows Host は Relay へ外向きに接続するため、SSH リバーストンネル、Windows の受信ポート、公開ファイアウォール規則は不要です。

## 暗号化と ID

- ユーザー名は大文字・小文字を区別しません。パスワードは個別の salt を用いた scrypt ダイジェストとして保存されます。
- アクセストークンの有効期間は 15 分、リフレッシュトークンは 30 日です。データベースにはトークンのハッシュだけを保存し、デバイス、Host、リフレッシュトークンは個別に失効できます。
- アカウントは Ed25519 署名 ID と X25519 暗号化 ID を持ち、各デバイスと Host も独立した鍵を持ちます。
- スマートフォンと Host は、双方が署名した一時 X25519 チャンネルで通信します。外側の envelope は AEAD associated data として扱われ、厳密な counter によって replay や順序外の注入を拒否します。
- Windows Host の秘密鍵、Host token、コンテンツ鍵は、現在の Windows ユーザーの DPAPI で暗号化して保存されます。チャンネルの handshake ID は永続化され、有効期間内に Relay が再起動をまたいで replay することを防ぎます。
- Host のイベントと snapshot には永続 outbox を使用します。確認応答が失われた場合は同一の暗号文を再送し、Relay は完全に同一の重複 envelope にだけ冪等な成功を返します。
- Relay は Host ごとに直近 24 時間または 20,000 件までの暗号化イベントと、最新の暗号化タスク snapshot を保持します。完全な履歴とすべての書き込みには、引き続き Host のオンライン接続が必要です。
- FCM に含めるのは `hostId/eventId/type` だけです。通知を開いた後、Relay から内容を取得して復号します。

これは「管理者が管理するエンドツーエンド暗号化」であり、完全なゼロ知識構成ではありません。初回の管理者設定時、ブラウザーがオフライン復旧秘密鍵を生成し、Relay は復旧公開鍵と封印済みデータだけを保存します。ただし、復旧秘密鍵とパスフレーズを持つ管理者は明示的にデバイスを復旧でき、最終的にはそのユーザーのデータを読み取れる可能性があります。復旧操作は毎回、監査ログに記録されます。

## コンポーネントと技術

| コンポーネント | バージョン | 技術 |
|---|---:|---|
| Android | 0.3.2 | Kotlin、Jetpack Compose Material 3、OkHttp、kotlinx.serialization、CameraX / ML Kit、Firebase Messaging、libsodium |
| Windows Host / Bridge | 0.3.2 | Node.js 24、TypeScript、`ws`、Node 組み込み SQLite、libsodium、PowerShell、Task Scheduler、Inno Setup |
| Desktop Attach | 0.3.2 | Codex プラグイン、Windows named pipe、ランダムなローカル token、Codex Desktop task tools |
| Relay | 0.3.2 | Node.js 24、TypeScript、`ws`、Node 組み込み SQLite WAL、firebase-admin、libsodium |
| 管理画面 | 0.3.2 | React、TypeScript、Vite、Lucide、HttpOnly/Secure/SameSite=Strict Cookie、CSRF 対策 |

Android 8.0 以降が必要です（`minSdk 26`、`compileSdk/targetSdk 36`）。Windows Host は Windows ユーザー単位でインストールされ、同じ PC 上の別ユーザーは別々の Host として表示されます。

## クイックスタート

### 1. Relay

```bash
cd relay
npm ci
npm test
npm run build
```

本番設定と systemd/Caddy の手順は [Relay 導入ガイド](relay/deploy/README.md) を参照してください。Relay は専用の HTTPS サブドメインの背後に置き、loopback ポートをインターネットへ直接公開しないでください。初回起動後、次を実行します。

```bash
node dist/cli.js bootstrap
```

15 分以内に一度限りのリンクを開き、管理者アカウントを作成して、ブラウザーからダウンロードした暗号化復旧ファイルをオフラインで保管します。復旧ファイルやパスフレーズを Relay へアップロードしたり、Git にコミットしたりしないでください。その後、管理画面の「ユーザーを作成」でユーザー名、表示名、初期パスワードを設定します。アカウントは「初回ログイン待ち」と表示され、ユーザーが Android から初めてログインしたときに有効化されます。従来の招待 API との互換性は維持しますが、UI は「詳細：旧版招待との互換性」の下にだけ表示されます。

### 2. Windows Host

Windows ユーザー単位の Inno Setup インストーラーを推奨します。初回インストール時に Relay の HTTPS アドレス、プロジェクト許可リスト、添付ファイル用一時ディレクトリを確認します。インストールが完了すると「Agent Pocket ペアリングアシスタント」が自動的に開き、5 分間有効な QR コードを表示します。Android はログイン前に QR コードをスキャンでき、Relay アドレスが自動入力されます。管理者から受け取ったユーザー名とパスワードを入力すると、最初のスマートフォンの有効化と Host のペアリングが一連の流れで完了します。期限切れの QR コードはアシスタントで再生成でき、アシスタントはスタートメニューからいつでも開き直せます。

添付ファイル用ディレクトリは、空き容量の十分な別のローカルディスクへ配置できます。この設定を持たない旧インストールは `%LOCALAPPDATA%\AgentPocket\attachments` を使用します。Codex Desktop は同じ Windows ユーザーでログインし、実行する必要があります。

インストーラーは Host のログオン時起動タスクと Desktop Attach プラグインを登録します。Codex Desktop でタスクを作成または再開すると、プラグインの `SessionStart` hook が Attach チャンネルを自動検出して確立します。Codex Desktop は同じ Windows ユーザーで起動済みでなければならず、Desktop の writer 所有権を迂回することはありません。

Windows の「インストールされているアプリ」とスタートメニューからアンインストールできます。既定では、プログラム本体、スケジュールタスク、Desktop Attach の登録だけを削除し、この PC のローカルアカウントとペアリング情報は再インストールに備えて保持します。アンインストール確認画面で `%LOCALAPPDATA%\AgentPocket` の削除を選ぶと、この PC をアカウントから切り離し、次回インストール時に再ペアリングできます。この操作で Relay 上のアカウント、スマートフォン、ほかの PC、別ドライブに設定した添付ファイル用ディレクトリが削除されることはありません。

ソースから開発する場合：

```powershell
cd bridge
npm ci
npm test
npm run relay-enroll -- https://relay.example.com
npm start
```

インストーラーのビルド、Ed25519 リリース署名、上書きアップグレードについては [Windows Host インストールガイド](installer/windows/README.md) を参照してください。インストーラーはシステムプロキシ、Windows ファイアウォール、ほかのプロキシサービスを変更しません。

### 3. Android

```powershell
cd android
.\gradlew.bat --no-daemon --no-configuration-cache :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
```

正式 APK は、リポジトリ外に保管した keystore でビルドします。スマートフォンがログインするのは Relay アカウントだけで、モデルへのリクエストは引き続き Windows 上でログイン済みの Codex から送信されます。

固定 Relay のテストユーザーへ配布する場合は、実際の値を公開ソースへコミットせず、非公開ビルド時に HTTPS アドレスを設定できます。

```powershell
.\android\scripts\build-release.ps1 -DefaultRelayUrl https://relay.example.com
```

既存ユーザーが Android Keystore / 暗号化 preferences に保存した Relay アドレスが優先され、ビルド時の既定値で上書きされることはありません。新版の通常 UI には招待登録を表示せず、旧版の招待 deep link だけを互換性のために残します。

Windows Host インストーラーも `-DefaultRelayUrl` または `AGENT_POCKET_DEFAULT_RELAY_URL` による、編集可能な初期値の設定に対応します。上書きアップグレードで既存の `host-config.json` が変更されることはありません。

## 非公開リリースと認証付き更新

`scripts/publish-private-release.ps1` は、現在の公開ソースの commit から Android と Windows の成果物をビルドします。非公開 Relay アドレスとオフライン Ed25519 秘密鍵を明示的に指定する必要があります。スクリプトは、両プラットフォームの署名付き manifest、SHA-256、インストーラー、中国語ドキュメント、bundle を生成します。`-Publish` モードでは非公開 GitHub リポジトリだけを受け入れ、固定済み SSH Ed25519 fingerprint を検証してから Relay の許可ディレクトリへ更新資産をアップロードし、リリースを登録します。

Android は approved device token、Host は Host token を使って `/api/updates/{platform}/latest` と対応する資産へアクセスします。Relay は匿名ダウンロードを提供しません。manifest、バージョン、サイズ、SHA-256、署名、サーバー相対パスは、すべてデータベースの許可リストと一致する必要があります。v0.3.2 自体は手動配布が必要ですが、v0.3.2 以降の更新は Relay から配信されます。

## v0.3.2 の変更点と検証

このリリースでは、最近の実機テストで特に使い勝手に影響した経路を修正しました。

- 過去に同期に失敗したタスクは再取得待ちキューに入り、Host の復旧後に自動的に再取得されます。
- モデル選択後、Bridge タスクと Plan タスクを正しく作成できます。
- Android のタスク一覧からアーカイブ済みタスクを除外します。
- タスク詳細をページ単位で取得してリアルタイムイベントと統合し、古い結果が新しいメッセージを上書きすることを防ぎます。
- Host の同期は single-flight で重複トリガーをまとめ、重い JSON 解析をメインスレッド外へ移して引っ掛かりを減らします。
- Desktop Attach は Host と同時にインストールされ、Codex Desktop のタスク開始・再開時に自動検出されます。
- Windows Host は独立した添付ファイル用一時ディレクトリに対応し、Android と Host のビルドには編集可能な Relay アドレスをあらかじめ設定できます。
- Relay schema v2 は事前作成アカウント、永続的なログイン rate limit、非公開更新の登録を追加します。初回有効化、パスワード変更・リセット、session 失効にはサーバー側テストがあります。
- Windows のインストール後にペアリングアシスタントが自動起動します。Android はアカウント有効化前に QR コードを読み取り、そのまま Host のペアリングを完了できます。
- 以後の Android / Host 更新は Relay の認証付きダウンロードと Ed25519 署名済み manifest を使用します。Host はタスク実行中のインストールを延期し、失敗時には検証済み backup を復元します。

現在のソース検証結果は、Android JVM 31/31、Bridge 67/67、Relay 27/27 です。正式リリースには、オフライン署名材料を持つビルドマシンでの Release/R8/APK 署名と、実機によるエンドツーエンド受け入れテストが引き続き必要です。Windows でリポジトリパスに非 ASCII 文字が含まれ、すべての Gradle test worker が `ClassNotFoundException` を報告する場合は、一時的な ASCII ドライブマッピングからテストを実行してください。これは Gradle 8.14.3 の argfile パス問題であり、テストクラスの欠落ではありません。

## v1 からの移行

1. 以前の Bridge データと Relay/Caddy 設定をバックアップします。
2. 既存の proxy サイトを変更せず、新しい Relay サブドメインと `127.0.0.1:8790` サービスを導入します。
3. 各 Windows PC に Host v2 をインストールして QR コードでペアリングし、タスク一覧、Desktop Attach、リアルタイムイベントを確認します。
4. Android v2 をインストールして Relay にログインします。v2 は旧来の直接接続 credentials を読み取りません。
5. すべての Host を確認した後、旧 SSH tunnel を停止し、旧 Bridge device token を失効させ、旧 Caddy route を削除します。

ローカルの Bridge DB や Codex 履歴は削除しないでください。v1 と v2 のスマートフォン credentials に互換性はなく、これは明示的な移行です。

## セキュリティ境界

- Relay と Bridge は loopback だけで待ち受け、Host は外向き接続だけを開始します。
- すべてのデータベースクエリに `account_id` が必要で、各 Host は 1 人のユーザーだけに属します。
- すべての `cwd` は、許可リスト内に実在する正規化済み絶対パスでなければなりません。
- スマートフォンからの承認は恒久的な許可ではなく、Desktop owner や writer lock を迂回することもできません。
- Host 更新では、固定 Ed25519 公開鍵、署名済み manifest、ファイルサイズ、SHA-256 のすべてを検証する必要があります。
- 完全な Relay credentials、token、秘密鍵、復旧ファイル、Firebase 設定、署名材料、タスク本文、運用引き継ぎ情報をコミットしないでください。

公開環境へ導入する前に [SECURITY.md](SECURITY.md) を確認してください。

## プロジェクト構成

```text
android/                 Android ネイティブクライアント
bridge/                  Windows Bridge と Relay Connector
desktop-attach-plugin/   実験的な Codex Desktop Attach プラグイン
installer/windows/       Windows ユーザー単位の Host インストーラーと署名付き更新
protocol/                クロスプラットフォーム暗号化テストベクトル
relay/                   マルチユーザー Relay、管理画面、導入スクリプト
```

## ライセンス

Apache License 2.0。詳細は [LICENSE](LICENSE) を参照してください。

## コミュニティ

- [LINUX DO](https://linux.do/)
