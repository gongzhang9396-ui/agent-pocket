# Agent Pocket 架构图

本目录使用 [Archify](https://github.com/tt-a1i/archify) 2.17，根据 Agent Pocket v0.3.1（提交 `175beb7e503eb33c24fa69ba5690e2b7f7e677d4`）的代码与部署文档生成。

| 图 | 类型 | 交互版 | 源规范 | 预览 |
|---|---|---|---|---|
| 系统架构 | Architecture | [HTML](agent-pocket-system.architecture.html) | [JSON](agent-pocket-system.architecture.json) | [PNG](agent-pocket-system.architecture.visual-check.1440x900.light.png) |
| Desktop / app-server 写入边界 | Architecture | [HTML](agent-pocket-writer-ownership.architecture.html) | [JSON](agent-pocket-writer-ownership.architecture.json) | [PNG](agent-pocket-writer-ownership.architecture.visual-check.1440x900.light.png) |
| 新建、续写与 writer 冲突 | Sequence | [HTML](agent-pocket-task-roundtrip.sequence.html) | [JSON](agent-pocket-task-roundtrip.sequence.json) | [PNG](agent-pocket-task-roundtrip.sequence.visual-check.1440x900.light.png) |
| 附件端到端流转 | Data flow | [HTML](agent-pocket-attachments.dataflow.html) | [JSON](agent-pocket-attachments.dataflow.json) | [PNG](agent-pocket-attachments.dataflow.visual-check.1440x900.light.png) |
| 同步与失败恢复 | Lifecycle | [HTML](agent-pocket-sync-recovery.lifecycle.html) | [JSON](agent-pocket-sync-recovery.lifecycle.json) | [PNG](agent-pocket-sync-recovery.lifecycle.visual-check.1440x900.light.png) |

`.visual-check.*` 文件是与对应 HTML SHA-256 绑定的浏览器检查收据、明暗主题截图和联系表，不是另一套图源。

## 生成与校验

在已安装 Archify 的目录执行，`<repo>` 替换为本仓库绝对路径：

```powershell
node bin/archify.mjs validate architecture <repo>\docs\diagrams\agent-pocket-system.architecture.json --quality showcase --repo-root <repo> --json
node bin/archify.mjs deliver architecture <repo>\docs\diagrams\agent-pocket-system.architecture.json <repo>\docs\diagrams\agent-pocket-system.architecture.html --quality showcase --repo-root <repo> --json
node bin/archify.mjs visual-check <repo>\docs\diagrams\agent-pocket-system.architecture.html --json
```

另一张 Architecture 图同样保留 `--repo-root <repo>`。Sequence、Data flow、Lifecycle 分别改用 `sequence`、`dataflow`、`lifecycle`，并去掉仅由 Architecture 支持的 `--repo-root <repo>`。更新 JSON 后必须重新执行 `validate`、`deliver` 与 `visual-check`，不能继续使用旧 HTML 或旧截图。

## 当前收据

| 类型 | Specification SHA-256 | HTML SHA-256 | Showcase | 浏览器证据 |
|---|---|---|---:|---|
| System architecture | `c6d2626a51a47d02c0501f6f0694ece5f2096318554b4d6e8e007d445b6a78d8` | `b016545422c3041c7655754cf7c2d6387dcb2802e57492f766ca2bdff4f8aef0` | 9/9 | passed |
| Writer ownership | `65d83eda3c0e5d1fcbf808922fde6deeaef190c2ed8cd3b04d2be9cf31a59eb0` | `586029fe59ca1673d2ed3c97e0aa80978dfb6b8862edab9fc4e7297c6c1813c3` | 9/9 | passed |
| Sequence | `d1f94a804a7672cf7ad2d2b980c357736b256f2630f9bc804eb793b6e4cdb123` | `45588062ee90990b8ed041bd4ed8ea3a78d295de3451cb3eb962a8924fb326ff` | 9/9 | passed |
| Data flow | `4eb13283d58bf3e76e8c369d648808f2430b722d92bfbbecb7f75ffe3e84dbe2` | `528ab33c7696a8dfb56c6f848a19fda35e6ac359e116ceaef8776e921559ec47` | 9/9 | passed |
| Lifecycle | `4d453942512b72b6af3e7f00dc59b6450854172d193742704da0626cc3ff5e1d` | `8fe83217c6ce0497e277b90c8ebae409d1501f178434ded13527777f5abee5a8` | 9/9 | passed |

浏览器证据覆盖浅色主题的 1440×900、1600×1000、1920×1080、2048×1320，以及 1440×900 和 2048×1320 的深色截图。五张图均无横向或纵向溢出。人工视觉复核覆盖同一组明暗端点截图，状态为 `passed`；本轮更新中 Sequence 因首屏溢出进行 1 轮视觉修正，另两张更新图为 0 轮。
