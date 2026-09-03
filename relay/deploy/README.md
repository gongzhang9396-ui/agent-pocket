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
  dist admin/dist package.json package-lock.json deploy
sha256sum agent-pocket-relay-0.3.2.tar.gz
openssl pkeyutl -sign -rawin \
  -inkey /offline/path/relay-release-ed25519-private.pem \
  -in agent-pocket-relay-0.3.2.tar.gz \
  -out agent-pocket-relay-0.3.2.tar.gz.sig
```

发布私钥不得进入服务器或 Git。服务器只需要对应的 Ed25519 公钥。

## 3. 安装或升级

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
2. 获取部署锁并停止 Relay；
3. 备份 SQLite、WAL 和 SHM 文件；
4. 安装到新版本目录并切换 `current`；
5. 启动 systemd 服务并检查 `/health`；
6. 安装受限的 `/usr/local/bin/agent-pocket-register-update` 更新登记包装器；
7. 健康检查失败时恢复旧的可执行版本链接。

数据库迁移不会被静默降级。需要恢复旧数据库时，必须由管理员从输出的备份目录显式操作。

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

管理页还可取消尚未激活的账号或重置普通用户密码。管理员重置会撤销该用户全部会话，但保留已批准设备、Host 和加密密钥；用户在 Android 设置中修改密码时保留当前会话、撤销其他会话。旧邀请 API 仍在“高级：兼容旧版邀请”中保留。

验收至少包括：

- 公网 `https://relay.example.com/health` 返回协议版本；
- 8790 只在 loopback 监听；
- 管理员初始化链接只能领取一次；
- 管理 Cookie 包含 HttpOnly、Secure、SameSite=Strict；
- 两个测试账户无法互相读取 Host、设备、快照或事件；
- 登录失败返回统一错误和 `Retry-After`，且重启 Relay 后限流记录仍有效；
- Caddy 和现有代理服务仍处于原状态。

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

`rollback.sh <version>` 只切换可执行版本链接并重启 Relay，不自动恢复数据库。部署前备份保留在 `/var/backups/agent-pocket-relay`，恢复数据库前应停止服务并确认 schema 兼容。
