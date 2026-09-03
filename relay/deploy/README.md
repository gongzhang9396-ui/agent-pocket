# Relay 生产部署

Relay 必须只监听 `127.0.0.1:8790`，并使用独立 HTTPS 子域名经 Caddy 接入 TCP 443。不要为 8790 添加云防火墙规则，也不要修改现有代理服务、UDP 443 或其他站点。

## 1. 准备系统

生产环境需要 Node.js 24、Caddy、systemd、SQLite 所在磁盘的可靠备份，以及一个无登录权限的 `agent-pocket-relay` 系统用户。建议目录：

```text
/opt/agent-pocket-relay/releases/   版本目录
/opt/agent-pocket-relay/current     当前版本符号链接
/var/lib/agent-pocket-relay/        SQLite WAL 数据
/etc/agent-pocket-relay/relay.env   非仓库配置
/var/backups/agent-pocket-relay/    部署前数据库备份
```

把 `relay.env.example` 安装到 `/etc/agent-pocket-relay/relay.env`，替换示例域名，并保持权限 `0600 root:root`。Firebase 服务账号若启用，必须放在发布目录之外。

## 2. 构建并签署发布包

```bash
npm ci
npm test
npm run build
tar -czf agent-pocket-relay-0.3.1.tar.gz \
  dist admin/dist package.json package-lock.json deploy
sha256sum agent-pocket-relay-0.3.1.tar.gz
openssl pkeyutl -sign -rawin \
  -inkey /offline/path/relay-release-ed25519-private.pem \
  -in agent-pocket-relay-0.3.1.tar.gz \
  -out agent-pocket-relay-0.3.1.tar.gz.sig
```

发布私钥不得进入服务器或 Git。服务器只需要对应的 Ed25519 公钥。

## 3. 安装或升级

```bash
sudo ./deploy/deploy-release.sh \
  ./agent-pocket-relay-0.3.1.tar.gz \
  0.3.1 \
  <sha256> \
  ./agent-pocket-relay-0.3.1.tar.gz.sig \
  ./relay-release-ed25519-public.pem
```

脚本会：

1. 校验 SHA-256 和 Ed25519 签名；
2. 获取部署锁并停止 Relay；
3. 备份 SQLite、WAL 和 SHM 文件；
4. 安装到新版本目录并切换 `current`；
5. 启动 systemd 服务并检查 `/health`；
6. 健康检查失败时恢复旧的可执行版本链接。

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

验收至少包括：

- 公网 `https://relay.example.com/health` 返回协议版本；
- 8790 只在 loopback 监听；
- 管理员初始化链接只能领取一次；
- 管理 Cookie 包含 HttpOnly、Secure、SameSite=Strict；
- 两个测试账户无法互相读取 Host、设备、快照或事件；
- Caddy 和现有代理服务仍处于原状态。

## 回滚

`rollback.sh <version>` 只切换可执行版本链接并重启 Relay，不自动恢复数据库。部署前备份保留在 `/var/backups/agent-pocket-relay`，恢复数据库前应停止服务并确认 schema 兼容。
