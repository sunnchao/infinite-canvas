# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

无限画布（infinite-canvas）是一个本地优先的 AI 图片创作工作台：无限画布编排 + 浏览器直连 OpenAI 兼容接口生成图片、视频、文本和音频。仓库没有业务后端，AI 请求由浏览器前端直接发出；`canvas-proxy`（本地转发）和 `canvas-agent`（本地 Agent / MCP）都是可选的本地进程。

开发约定（目录组织、画布 UI、文档、发版、PR 审查等）以根目录 `AGENTS.md` 为准，本文件只补充常用命令和大图景架构。

## 仓库结构

| 目录 | 说明 |
| --- | --- |
| `web/` | Vite + React 19 单页应用，主产品，端口 3000 |
| `canvas-agent/` | 本地 Node 服务：给网页侧边栏提供 Codex 会话，同时可作为 MCP Server 被 Codex / Claude Code 调用 |
| `canvas-proxy/` | 极简本地转发代理，解决浏览器直连第三方 AI 接口的 CORS 限制 |
| `plugins/canvas/` | 画布节点插件：`sdk/`、`template/`、`markdown/`、`svg/`、`html/`、`panorama/`、`sticky-note/` 等，彼此独立构建 |
| `docs/` | Next.js + Fumadocs 文档站，内容在 `docs/content/docs/` |
| 根目录 | `VERSION`、`CHANGELOG.md`、Docker / Render / Vercel 部署配置 |

## 常用命令

### 主应用 `web/`

```bash
cd web
bun install
bun run dev          # Vite，http://localhost:3000
bun run build        # 产物 web/dist
bun run typecheck    # tsc --noEmit
bun test             # bun:test，运行 web/tests/*.test.ts
bun test tests/model-selection.test.ts
bun test -t "a saved video"   # 按测试名过滤
bun run format       # Prettier 写入
bun run format:check # Prettier 检查（没有 ESLint）
```

`web` 以 `bun.lock` 为准；不要用 npm / pnpm 重新安装并生成其他锁文件。

### 文档站 `docs/`

```bash
cd docs
bun install
bun run dev          # Next dev；默认 3000，与 web 同时起时加 -- --port 3001
bun run build
bun run types:check  # fumadocs-mdx + next typegen + tsc --noEmit
```

### 本地 Canvas Agent `canvas-agent/`

```bash
cd canvas-agent
npm install
npm run dev                            # tsx src/index.ts，默认 127.0.0.1:17371
npm run debug                          # 带调试日志
npm test                               # tsx --test，运行 package.json 中列出的全部测试
npx tsx --test src/canvas/operations.test.ts   # 单个测试文件
npm run build && node dist/index.js    # HTTP 服务
node dist/index.js mcp                 # MCP stdio 服务
```

### 本地转发代理 `canvas-proxy/`

```bash
cd canvas-proxy
node index.js      # 默认 http://127.0.0.1:23210
```

### 插件 `plugins/canvas/<name>/`

```bash
npm install
npm run dev        # watch 构建，产物同步到 web/public/plugins/
npm run build
npm run typecheck
```

官方插件由 `plugins/canvas/registry` 集中构建；产物不进 git，由 CI 发布到孤儿分支 `plugins-dist`。

### Docker

```bash
docker compose up -d   # 构建镜像并暴露 3000
```

## 架构

### 前端入口与路由

`web/src/main.tsx` 挂载 `AppProviders`（Ant Design `ConfigProvider` + react-query + i18n + 主题）和 React Router。路由集中在 `web/src/router.tsx`：`/canvas`（画布列表）、`/canvas/:id`（画布编辑）、`/image`、`/video`、`/assets`、`/prompts`、`/config`。

### 画布数据模型

画布状态在 `web/src/stores/canvas/use-canvas-store.ts`，用 Zustand `persist` + localforage（IndexedDB）持久化，写入有 400ms 防抖。核心类型在 `web/src/types/canvas.ts`：

- `CanvasProject` = `nodes` + `connections` + `chatSessions` + `viewport` + `backgroundMode`。
- 节点是世界坐标下的 `CanvasNodeData`，`type` 为开放字符串：内置 `image/text/config/video/audio/group`，插件为 `<pluginId>:<name>`。
- 连线只存 `fromNodeId` / `toNodeId`，路径在渲染时计算。
- viewport 变换：`screen = viewport.{x,y} + world * viewport.k`。
- 图片/视频/音频节点不保存 base64；`metadata.storageKey` 指向 IndexedDB 中的 Blob，`content` 通常是会话级 `blob:` URL。

`web/src/types/canvas.ts` 的 `CanvasNodeMetadata` 是节点配置的集中位置（生成模式、模型、尺寸、质量、多图/多文本槽位、视频任务 ID 等）。

### 画布渲染与变更入口

- `web/src/pages/canvas/project.tsx` 是画布页编排层（约 3.5k 行，交互、生成、导入导出都在这里汇总）。
- UI 在 `web/src/components/canvas/`，纯计算/工厂函数在 `web/src/lib/canvas/`。
- 节点渲染走 `web/src/components/canvas/canvas-node.tsx` + `web/src/lib/canvas/node-registry.ts`；内置节点在 `web/src/components/canvas/nodes/builtin-nodes.tsx` 注册。
- **所有画布写操作统一使用 `CanvasAgentOp` 指令集**（`web/src/lib/canvas/canvas-agent-ops.ts`）：`add_node`、`update_node`、`delete_node`、`connect_nodes`、`delete_connections`、`set_viewport`、`select_nodes`、`run_generation`。本地 Agent、插件 `ctx.applyOps` 和画布内部动作都走这里；新增画布变更时优先扩展这套指令，不要另建平行通道。

### 节点插件系统

- 插件加载：`web/src/lib/canvas/plugin-loader.ts`（从 URL 拉 ESM → Blob URL → `import()`），运行时桥接在 `plugin-runtime.ts`，宿主 React 通过 `globalThis.InfiniteCanvasRuntime` 以单例注入，避免插件打包第二份 React。
- 插件契约：`web/src/types/canvas-plugin.ts`（`CanvasPlugin` / `CanvasNodeDefinition` / `CanvasNodeContext`）。SDK 中的 `plugins/canvas/sdk/src/types.ts` 是这份契约的镜像，宿主契约改动时需同步。
- 插件可拿到 `ctx.applyOps`、上下游节点、宿主 AI 能力（`ctx.ai`）、插件私有 `ctx.storage` 和事件总线。
- 本地开发：构建产物落到 `web/public/plugins/<name>.js`，画布启动时自动发现（默认关闭）；或在 `web/.env.local` 设置 `VITE_DEV_PLUGINS=/plugins/a.js,/plugins/b.js` 强制每次刷新重新加载。
- 官方插件注册表从 jsDelivr 的 `plugins-dist` 分支读取，可用 `VITE_PLUGIN_REGISTRY_URL` 覆盖。

### AI 配置与请求

- 配置在 `web/src/stores/use-config-store.ts`：多个渠道（`ModelChannel`：`baseUrl` / `apiKey` / `apiFormat: "openai" | "gemini"`），每个渠道有按能力区分的模型列表；模型值编码为 `channelId::modelName`。
- 每个模型可附带自定义调用脚本，`services/api/model-plugin.ts` 负责执行；未配置脚本时走内置 OpenAI / Gemini 请求逻辑。
- 请求服务在 `web/src/services/api/`：
  - `image.ts`：文生图、图生图、参考图编辑、模型列表、OpenAI Responses / Gemini 文本与工具调用。
  - `video.ts`：OpenAI / Gemini 视频任务创建、轮询、恢复（节点保存 `videoTaskId`）。
  - `audio.ts`：语音生成。
- `withLocalProxy(url)` 在开启本地代理时改写请求地址；关闭时全部直连。
- 图片超时、下载超时等边界值不要静默调整（见 `AGENTS.md`「项目注意事项」）。

### 本地存储与媒体生命周期

localforage 数据库统一叫 `infinite-canvas`，对象仓库：

| store | 用途 |
| --- | --- |
| `app_state` | Zustand persist（画布项目、配置等 JSON） |
| `image_files` | 原始图片 Blob |
| `image_previews` | 768px 长边缩略图，仅本地，不参与导出 / 同步 |
| `media_files` | 视频、音频等 Blob |
| `image_generation_logs` / `video_generation_logs` | 工作台生成历史 |

- 项目 JSON 只存 `storageKey` 和元数据，不存大 base64。
- 打开项目时把 `storageKey` 解析成新的 `blob:` URL；删除节点 / 画布 / 资产后按引用计数清理 Blob 和 object URL。
- 业务数据持久化默认用 localforage；`localStorage` 只放极小的偏好（locale、侧栏宽度、Agent 地址等）。
- WebDAV 同步在 `web/src/services/webdav-sync.ts` + `app-sync.ts`，同步清单与素材，不包含缩略图。

### 本地 Canvas Agent

- `canvas-agent/src/index.ts`：无参数启动 HTTP 服务，`mcp` 子命令启动 MCP stdio 服务。
- 默认监听 `127.0.0.1:17371`；token 与配置在 `~/.infinite-canvas/canvas-agent.json`，文件权限 0600。
- 侧边栏通过 HTTP/SSE 连接（`web/src/services/api/canvas-agent.ts`），网页侧 `pages/canvas/hooks/use-agent-bridge.ts` 发布画布快照并应用 Agent 指令（带撤销快照）。
- Codex 通过 `codex app-server --stdio` 启动并复用同一 thread；Claude Adapter 代码保留，但网页侧目前只开放 Codex。
- Agent 消息必须同时按 `threadId` / `turnId` / `itemId` 归属；消息存储版本与通信协议版本独立管理，未知版本或损坏文件必须拒绝覆盖。

### 版本、文档与发布

- 构建时 Vite 读取根目录 `VERSION` 和 `CHANGELOG.md`，注入 `__APP_VERSION__` / `__APP_RELEASES__`（见 `web/vite.config.ts`）。
- 文档内容在 `docs/content/docs/`，每个目录的 `meta.json` 控制导航；`docs/index.md` 是给 AI 用的文档索引。
- 功能完成后：先从 `docs/content/docs/progress/todo.mdx` 移到 `docs/content/docs/progress/pending-test.mdx`，用户确认后再写入 `overview/features.mdx`。
- 每次有用户可感知的改动，都要在 `CHANGELOG.md` 的 `Unreleased` 追加 `[新增]/[调整]/[修复]/[优化]` 条目。
- 发版：把 `Unreleased` 整理成版本记录、更新 `VERSION`、提交全部代码、打 `vX.Y.Z` tag；流程中不执行构建或测试，除非用户明确要求。
- CI 在 `v*` tag 触发：Docker 多架构镜像（GHCR）、GitHub Pages（`VITE_BASE`）、官方插件发布到 `plugins-dist`。`canvas-agent` 按自己的 `package.json` 版本独立发布 npm。

## 工作规则速记

完整规则见 `AGENTS.md`，以下是高频且容易遗漏的几条：

- 先读现有代码，沿用项目结构与写法；代码尽量短，不为兼容更多场景堆分支。
- 不引入项目后端假设；外部请求统一放 `web/src/services/api/`，跨页面状态放 `web/src/stores/`。
- 画布 UI 必须使用 `canvasThemes` / `useThemeStore` / Ant Design token，禁止硬编码黑白灰；操作按钮默认扁平透明，`activeBg` 只用于选中态。
- 所有用户可见文案必须同时更新 `web/src/i18n/locales/zh-CN.ts` 和 `en-US.ts`。
- 画布项目、素材、API Key 均在浏览器本地，文档不得写成已支持云同步。
- 改动超时、重试、大小限制、并发上限等行为边界前，先向用户说明并取得确认。
- 本地验收时使用独立测试页面，不要关闭用户已打开的浏览器窗口或标签页。
