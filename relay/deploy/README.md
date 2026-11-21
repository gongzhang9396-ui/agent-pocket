# Relay 生产部署

Relay 必须只监听 `127.0.0.1:8790`，并使用独立 HTTPS 子域名经 Caddy 接入 TCP 443。不要为 8790 添加云防火墙规则，也不要修改现有代理服务、UDP 443 或其他站点。

## 1. 准备系统

生产环境需要 Node.js 24、Caddy、systemd、SQLite 所在磁盘的可靠备份，以及一个无登录权限的 `agent-pocket-relay` 系统用户。建议目录：

```text
/opt/agent-pocket-relay/releases/   版本目录
/opt/agent-pocket-relay/current     当前版本符号链接
/var/lib/agent-pocket-relay/        SQLite WAL 数据
/var/lib/agent-pocket-relay/updates/ 鉴权更新资产
/etc/agent-pocket-relay/relay.env   非仓库配置
/var/backups/agent-pocket-relay/    部署前数据库备份
```

把 `relay.env.example` 安装到 `/etc/agent-pocket-relay/relay.env`，替换示例域名，填入离线更新签名密钥对应的 Ed25519 DER SPKI 公钥 base64，并保持权限 `0600 root:root`。Firebase 服务账号若启用，必须放在发布目录之外。签名私钥不得复制到 Relay。

## 2. 构建并签署发布包

```bash
npm ci
npm test
npm run build
tar -czf agent-pocket-relay-0.3.2.tar.gz \
  dist admin/dist web/dist package.json package-lock.json deploy
sha256sum agent-pocket-relay-0.3.2.tar.gz
openssl pkeyutl -sign -rawin \
  -inkey /offline/path/relay-release-ed25519-private.pem \
  -in agent-pocket-relay-0.3.2.tar.gz \
  -out agent-pocket-relay-0.3.2.tar.gz.sig
```

发布私钥不得进入服务器或 Git。服务器只需要对应的 Ed25519 公钥。

## 3. 升级已有 Relay

发布脚本要求已有可恢复的 Relay 版本；首次部署先完成系统用户、环境和基础服务初始化。必须同时保存 `deploy-release.sh`、`rollback.sh` 和 `release-state.sh`。升级目录不能覆盖已有版本。首轮网页试用可在下面命令最后增加 `--enable-web`，开关变更会一起备份。

```bash
sudo ./deploy/deploy-release.sh \
  ./agent-pocket-relay-0.3.2.tar.gz \
  0.3.2 \
  <sha256> \
  ./agent-pocket-relay-0.3.2.tar.gz.sig \
  ./relay-release-ed25519-public.pem
```

脚本会：

1. 校验 SHA-256 和 Ed25519 签名；
2. 获取部署锁，检查归档路径，在新目录准备依赖，再确认 Relay 停止；
3. 备份 SQLite、WAL、SHM、环境、服务配置和更新包装器，记录不存在的文件并生成校验和；
4. 原子切换 `current`；
5. 启动 systemd 服务并检查 `/health`；
6. 安装受限的 `/usr/local/bin/agent-pocket-register-update` 更新登记包装器；
7. 停服后的任一步失败时恢复旧数据库、配置和可执行版本，再检查旧服务健康；无法确认停服时保持失败状态，禁止混合恢复文件。

数据库迁移不会被静默降级。v2 到 v3 会在事务中创建网页认证、密钥包、设备证明、一次性票据和操作幂等表；迁移前必须同时备份 SQLite、WAL 和 SHM。旧版本 Relay 遇到 v3 数据库会拒绝启动。需要恢复旧数据库时，必须先停止服务，再由管理员显式恢复兼容的 DB/WAL/SHM，随后切换可执行版本。

## 4. 接入 Caddy

先备份现有 Caddyfile，再把 [Caddyfile.example](Caddyfile.example) 的单独站点块替换为真实域名。现有部署若要求 `protocols h1 h2` 以保留 UDP 443 给其他服务，必须继续保留。

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

执行 `caddy validate` 成功后再 reload。Agent Pocket 不要求改 sing-box、其他代理站点或任何 UDP 端口。

## 5. 初始化与验收

```bash
sudo systemd-run --wait --pipe --quiet \
  --uid=agent-pocket-relay --gid=agent-pocket-relay \
  --working-directory=/opt/agent-pocket-relay/current \
  --property=EnvironmentFile=/etc/agent-pocket-relay/relay.env \
  /usr/bin/node dist/cli.js bootstrap
```

一次性 unit 继承受控环境文件，不会把变量内容展开进 shell 命令或进程参数。

初始化完成后，在管理页直接创建普通用户并设置初始密码。账号在首次正确登录前显示为 `pending_activation`；Android 会生成账号/设备密钥，Relay 在同一事务中领取预创建账号并批准首台手机。并发领取只允许一个成功。已激活账号的新手机仍需要可信设备批准。

给 iPhone 用户创建账号时勾选“网页首次开通”。该 provision 的 durable `web-only` 标记拒绝旧 Android 首激活接口；API 调用方不传 `webOnly` 仍保留原兼容行为。网页通过 `/api/web/activate/start` 和 `/complete` 在浏览器本地生成账户密钥，以四项私钥持有证明提交密码密文包。原子激活事务只创建账户、密文包和强制 TOTP 策略，不发设备/会话；随后完成 TOTP 绑定和浏览器 device proof 才能访问 Host。密码重置和取消账号会失效旧激活事务，完全相同的完成请求可以读取持久回执恢复未知结果。

已批准浏览器通过现有 WS `host/enroll/inspect` / `approve` 绑定自己的电脑。新版 Windows 配对助手提供 `/app/#pair=<id>.<secret>` 网页二维码、打开/复制链接，以及保留原 Android QR 的切换按钮。secret 只在片段和本机临时文件中，网页立即从地址栏移除并仅保留在内存；先完成开户再扫码，减少五分钟过期。详见 [朋友网页试用说明](../../docs/FRIEND-WEB-QUICKSTART-zh-CN.md)。

新版 Host 在 complete 前把同一 proposed token 和 enrollment 写入 CurrentUser DPAPI 恢复记录，Relay 只保存 token hash；响应丢失后重放相同材料可取回同一个 Host 结果，完成行保留 24 小时。旧 Host 不传 proposed token 时保留原协议。名称在 approve 时检查并预约，冲突时保留未批准状态供网页改名。网页只有看到匹配公钥的 Host 实际在线才显示连接完成。TOTP 首次绑定和 device proof 消费使用事务内版本检查与 CAS，旧并发请求不得覆盖验证码或重复签发会话。

管理页还可取消尚未激活的账号或重置普通用户密码。管理员重置会撤销该用户全部会话，但保留已批准设备、Host 和加密密钥；用户在 Android 设置中修改密码时保留当前会话、撤销其他会话。旧邀请 API 仍在“高级：兼容旧版邀请”中保留。

网页端默认关闭。设置 `AGENT_POCKET_WEB_ENABLED=true` 后，Relay 同源提供 `/app` 和 `/invite`；`/admin` 继续只使用管理员 Cookie，网页 API 只接受 Bearer 会话并要求同源 Origin。网页首次使用需要账号密码、启用时的 FreeOTP+ TOTP、浏览器双密钥持有证明，以及一次性账户密钥包迁移。管理员在线迁移时，密钥包必须在管理员浏览器或离线恢复工具中本地解密并重新用目标账号密码包装，Relay 不得接收恢复私钥。

网页密钥包使用 `Argon2id + XChaCha20-Poly1305`；Relay 只保存密文，但自部署 Relay 进程和 `/app` 静态代码仍属于可信边界。管理员可调用 `/api/admin/users/<id>/web-package` 上传已经由用户密码包装的密钥包，使用 `expectedVersion` 做 CAS；该接口不能替用户解密。

验收至少包括：

- 公网 `https://relay.example.com/health` 返回协议版本；
- 8790 只在 loopback 监听；
- 管理员初始化链接只能领取一次；
- 管理 Cookie 包含 HttpOnly、Secure、SameSite=Strict；
- 两个测试账户无法互相读取 Host、设备、快照或事件；
- 登录失败返回统一错误和 `Retry-After`，且重启 Relay 后限流记录仍有效；
- Caddy 和现有代理服务仍处于原状态。
- `AGENT_POCKET_WEB_ENABLED=false` 时 `/app` 与 `/invite` 不可用，旧 Android/Host API、`/admin` 和 Desktop Attach 不受影响；开启后检查 `/app` 静态壳、WASM MIME、Service Worker 不缓存 API/token/任务正文。
- 用 iOS Safari 和桌面 Chrome/Edge 各完成一次密码/TOTP、锁定/解锁、只读同步、Host 重连和写操作冒烟测试；关闭网页只断开 WebSocket，不中断 Host 任务。

## 6. 私有更新目录与登记

更新目录来自 `AGENT_POCKET_RELAY_UPDATES_DIR`，生产建议固定为 `/var/lib/agent-pocket-relay/updates`。服务账号必须只对这个目录拥有读权限以及登记所需的 SQLite 权限；不要把它映射成 Caddy 静态目录。Relay 的两个下载接口都需要身份：Android 使用 approved device token，Host 使用 Host token。

目录结构和文件名是固定白名单：

```text
/var/lib/agent-pocket-relay/updates/
  android/0.3.2/Agent-Pocket-0.3.2-release.apk
  android/0.3.2/android-manifest.json
  android/0.3.2/android-manifest.json.sig
  host/0.3.2/AgentPocketHost-0.3.2-windows-x64.exe
  host/0.3.2/host-manifest.json
  host/0.3.2/host-manifest.json.sig
```

根目录 `scripts/publish-private-release.ps1` 会在本地生成签名 manifest，并可在固定 SSH Ed25519 指纹校验后上传。远端登记调用由 root-owned 包装器收口：它只接受 updates 根目录下的 `<manifest>` 和紧邻的 `<manifest>.sig`，随后用 `agent-pocket-relay` 身份加载受控环境执行 `dist/register-update.js`。发布用 SSH 账号只应获得 updates 子树写权限和执行该包装器的最小 sudo 权限，不能读取 Relay 数据库、环境文件或签名私钥。

手工登记示例：

```bash
sudo /usr/local/bin/agent-pocket-register-update \
  --manifest /var/lib/agent-pocket-relay/updates/android/0.3.2/android-manifest.json \
  --signature /var/lib/agent-pocket-relay/updates/android/0.3.2/android-manifest.json.sig
```

登记前会验证 Ed25519 签名、版本、平台、文件名、大小、SHA-256 和解析后的目录边界；旧版本不能覆盖 latest。登记成功后 Relay 通知在线 Android/Host，服务也每 30 秒检查一次外部 CLI 新登记版本。下载时会核对文件 inode、ctime、mtime 和大小；首次下载或任一元数据变化都会重新计算 SHA-256，防止登记后同尺寸替换，同时避免每个 HEAD 请求重复读取整个大文件。

首次 0.3.2 APK/EXE 仍需手工发送和安装；从 0.3.2 开始，Android 登录后检查更新，Host 通过通知和每日兜底检查更新。

## 回滚

执行 `rollback.sh <version> <匹配的备份目录>`。脚本获取同一部署锁，校验备份及对应旧版本，停服后另存当前状态，再精确恢复 DB/WAL/SHM、配置和旧程序。原备份没有 WAL/SHM 时必须删除升级后产生的文件，不能混用。回滚失败会尝试恢复回滚前状态；无法验证安全停服时不继续覆盖。

程序切换与数据库恢复是两个独立步骤，必须在停服期间按此顺序完成数据库恢复再启动旧程序。恢复发布前快照会回退发布后的写入，因此试用失败应立即停止写入；当前状态的 rescue 备份留作数据恢复，不能直接合并 WAL。

发版前在 Linux 执行 `sudo python3 deploy/test-release.py`，它只操作临时目录，模拟 systemd 故障，不会调用真实服务。对生产库的在线 SQLite 一致性备份（不是直接复制活动 DB），使用 `rehearse-schema.mjs <v2快照> <新建临时库> <旧dist/store.js> <新dist/store.js>` 验证全部旧表、完整性检查、重复迁移及旧版恢复。实际发布仍须停服后另做 DB/WAL/SHM 备份。

首次网页迁移：Android 的“设置 → 账号设备”刷新并批准新浏览器；网页使用独立登录事务领取只封装给本设备的密钥，密码重新包装后才完成迁移。无需向 Relay 上传恢复私钥。
