# AGENTS.md

面向本仓库开发者（含 AI agent）的架构、硬性约束与开发约定。

## 文件结构

```
package.json        dsh.bundle.patch + dsh.client 声明；files 仅列运行时文件；零 dependencies
index.js            Host 插件（零 npm import）：NewsNowService + Fetch 路由 + webServer 前缀 + newsnow_news 工具
client.js           Client 模块（纯 JS，无构建）：window.__ModuleLoader__.load，只 require('react')
cordis.patch.yml    - insert: - id: dsh-newsnow / name: dsh-plugin-newsnow
locale/*.json       八语言（zh/en/ja/es/fr/de/ru/pt），结构 { meta:{title,description}, text:{77 键} }
icon.svg            侧边栏图标（currentColor）
docs/screenshots/   README 展示截图
tools/              本地探针与 asar 解包（.gitignore 排除，不随仓库分发；见 tools/README.md）
```

## 数据流

```
面板 / newsnow_news 工具 ──▶ connection.fetch 路由 /api/dsh-newsnow/feed ──▶ NewsNowService ──▶ NewsNow /api/s
                                                   │
                                       内存缓存 + 并发去重 + 失败回退旧数据(stale)
```

- Feed：`/api/dsh-newsnow/feed`（POST + buffered），返回 `{ok:true, sources}`（目录）或 `{ok:true, value:feed}`（单源）。
- 文案：`/api/dsh-newsnow/text`（POST + buffered），Host 用 `node:fs` 读包内 locale 文件下发；client 注册进 `newsnow` locale 命名空间。
- 控制 action：`enable` / `disable` / `add-custom` / `remove-custom` / `set-prefs`；错误统一 `{ok:false, error:{code,message}}`。
- 兜底：webServer 前缀 `/dsh-newsnow/api`（免鉴权），含诊断路由 `/dsh-newsnow/api/status`。
- 持久化：`<DSH_HOME|~/.dsh>/storages/dsh-newsnow.json`（250ms 防抖 tmp+rename 原子写，卸载 flush；启动时存在即覆盖 patch 值）。形状 `{version:1, enabled:[], custom:[], prefs:{autoRefresh?, sidebarBrowser?}}`。

## 硬性约束（违反即坏）

1. **Host 零 npm import**：路径安装（`link:`）的包解析不到 profile 依赖。`Config` 校验用手写 `Config['~standard'].validate`，非法配置收敛到默认值。
2. **Client 只 `require('react')`**：loader 的 require 只解析 bundle graph 条目，无 subpath 加载；模块 factory 必须无副作用，副作用放 `apply(ctx)` 内 `ctx.effect`。
3. **样式只用 `--dsw-alias-*` 主题 token**（bg-base、bg-layer-1/2、border-l1/2、brand-primary、label-primary/secondary、state-*）；禁止 import 任何 `@deepseek-ai/dsh-client-ui-*` 包；不碰 document.body / app root；不用 iframe。
4. **`/api` 桥只支持 POST + buffered**：`dsh-client-connection` 的 `bridge()` 对非 buffered 模式构造流式 body 的 Request，而 GET Request 不能带 body → GET 路由死在桥内（客户端 `.catch` 静默，务必 console.warn）。
5. **运行时无同步加载包内 JSON 的通道**：`/plugins/*/assets/` 只发图片（svg/png/webp/jpg/jpeg）。故 locale 经 text 路由异步下发；到达前面板渲染骨架（`textReady` 门）。
6. **locale.register(ns, pairs) 重复注册同一 locale 会 throw "already has locale"**：每次页面加载只注册一次。Harness 八语言，fallback 链末尾恒为 `en`——字典必须覆盖全部 8 语言。
7. **模块缓存 immutable**（`max-age=31536000`）：rev 只由文件 mtime/ctime/size 生成，改文件即换 URL；客户端改完必须硬刷新才能看到。
8. **上游要求浏览器 UA**，否则 403；`/api/sources` 被 Cloudflare 拦，来源列表实测固化（38 个有效；`36kr` 系与 `github-trending` 无效）。
9. `main` 槽位无 keep-alive：切面板即卸载 React 子树；webview guest 随 DOM 卸载销毁且 lease 一次性。跨面板状态走模块级 `remembered` / store（scrollTop、embedWidth、managing、cardOpen、embed tabs localStorage `dsh-newsnow:embed-tabs`、卡片顺序 localStorage `dsh-newsnow:card-order`，经 `readCardOrder`/`writeCardOrder`/`applyCardOrder`；卡片墙与 hero 头条同序）。卡片墙滚动用**读者锚点**恢复（`captureWallAnchor`/`restoreWall`：最上方可见卡 `data-source` + 视口内偏移；开合内嵌分栏、拖宽、点击链接都会先 `captureWallAnchor()` 再恢复）——裸 scrollTop 会被布局翻转自身触发的 scroll 事件重置为 0。

## UI 结构（slot 注册）

- `sidebar.panellist`：id `dsh-newsnow`，order 30，label 走 locale。
- `main`：key `dsh-newsnow`，卡片墙 + 来源管理弹窗。
- `conversation.hero.options`：id `dsh-newsnow-hot`，会话页头条胶囊。
- 链接打开：内嵌（Desktop 壳 `globalThis.dshDesktop.browser` 桥租约）→ 侧边栏（`ctx.sidebarRight.openTab('browser',{params:{url}})`，需先 `layout.selectPanel(null)` + `openRightbar` 等会话面挂载，重试 4×150ms）→ 系统（`globalThis.open(url,'_blank','noopener')`）。

## 验证

```bash
node --check index.js && node --check client.js
node tools/probe-host.mjs   # Host：真实 Cordis + 真实上游，55 项（依赖 tools/cordis-extract）
node tools/pc5.mjs          # Client：伪 loader + 组件渲染循环，234 项
```

探针不在仓库中（`tools/` 被 .gitignore 排除），恢复方法见 tools/README.md。对外观测 live host：`GET http://127.0.0.1:<port>/dsh-newsnow/api/status`（免鉴权，返回 version 与 textRoute）。

## 提交约定

- 改 client.js / locale 后 bump package.json version（rev 变化才会绕过客户端缓存）。
- 运行时文件新增必须同步加进 package.json `files`。
- 上传 GitHub 前确认 `git status` 不含 tools/ 与任何 asar 解包产物。
