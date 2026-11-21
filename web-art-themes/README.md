# Agent Pocket Web 艺术主题改造

这是独立的 Web 视觉改造目录。原有 `relay/web` 文件没有被覆盖，当前 Git 分支也没有被切换。按约定，先在独立目录完成设计和预览，确认效果后再迁移到正式工程的新分支。

## 打开预览

直接用浏览器打开本目录的 `preview.html`。预览使用模拟任务数据，不连接 Relay，不会向电脑发送任务。可以切换三套皮肤、浅色/深色/跟随系统，搜索任务，并在窄屏下体验任务列表与对话之间的切换。

预览页会读取原工程的 `../relay/web/src/styles.css` 作为基础样式，再加载本目录的新 `skins.css`，因此请保留当前目录相对位置。

## 设计方向

| 皮肤 | 视觉语言 | 使用方式 |
|---|---|---|
| 澄明 | 冷灰蓝、清晰层级、克制阴影 | 默认主题，适合日常长时间使用 |
| 像素 | 复古掌机、少量硬阴影、像素山景 | 正文仍用易读字体，等宽字体只用于品牌与辅助信息 |
| 油画 | 纸张色、森林绿、编辑式标题、小幅山野场景 | 对话与控件保持平静，不在正文叠加复杂纹理 |

每套皮肤都提供独立的浅色和深色令牌。“跟随系统”会监听系统明暗变化，主题和明暗偏好分别保存在当前浏览器。手机使用列表/对话切换和底部弹窗；平板与 PC 使用双栏工作台，并针对窄平板缩短侧栏。

## 文件对应关系

| 独立目录中的文件 | 正式工程中的目标位置 |
|---|---|
| `relay/web/src/skins.css` | `relay/web/src/skins.css` |
| `relay/web/src/skin.ts` | `relay/web/src/skin.ts` |
| `relay/web/src/skin-picker.tsx` | `relay/web/src/skin-picker.tsx` |
| `relay/web/index.html` | `relay/web/index.html` |
| `relay/web/public/assets/theme-init.js` | `relay/web/public/assets/theme-init.js` |

正式迁移只需替换前四个文件并新增最后一个文件，不需要修改 React 工作台业务逻辑。原工程已经引入 `skins.css`、`SkinPicker` 和 `.theme-scene`，入口也已经调用 `applySkin`。

`theme-init.js` 是外部经典脚本，符合现有 `script-src 'self'` CSP，用于在 React 加载前恢复主题并同步浏览器主题色。它位于 `/app/assets/`，沿用现有 Service Worker 的静态资源缓存路径，不需要增加 `unsafe-inline`。

## 迁移后验证

确认视觉方案后，先在正式工程创建分支，再按上表迁移。随后在 `relay` 目录运行 `npm run build`，并检查 360px 手机、768px 平板和 1440px PC 三种视口。每套皮肤分别检查浅色、深色、系统主题切换、设置弹窗、登录页、任务对话和代码块。

当前隔离命令环境无法启动，因此这里完成的是独立预览与代码复查，没有声称已经执行正式工程构建。预览中的新建任务、刷新和设备操作只是视觉演示。
