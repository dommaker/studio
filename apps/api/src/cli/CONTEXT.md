# apps/api/src/cli — Studio CLI 入口与命令域

## 职责

`studio` 命令的入口/分发（studio-cli.ts）与各命令域实现。两类服务启动路径：

- `studio run web`（run-web.ts，#571）：npm 本地形态一体起服务总入口——API + 托管已构建 web dist + 首启检测块 + 端口动态顺延，前台进程 Ctrl-C 即停。
- `studio up`（server.ts）：服务器形态启动（systemd 托管场景），原样保留。

## 核心导出

- `studio-cli.ts`：入口/分发/帮助文本；`run web [--port <n>]` 动词。
- `run-web.ts`：`studioRunWeb()`——启动链：ensureDataDirs/ensureDaemonSecrets → 端口解析 → 首启面板 → preflight（存储探针 + frontend dist）→ ensureDefaults → `await import('../index.js')`。数据区迁移钩子接入点（#572）在其 preflight 之前。
- `bootstrap.ts`：ensureDataDirs / ensureDaemonSecrets（env > .daemon/ 文件 > 生成落盘）/ probeStorageWritable；run web 与 up 共用。
- `port-probe.ts`：probePortFree（net 模块探测，跨平台不走 lsof）/ resolvePort（默认 3001 起顺延上限 +100；显式 --port/PORT 占用即拒启）/ parsePortFlag / explicitPortFromEnv。
- `first-run-panel.ts`：buildFirstRunPanel()——Node 版本对 engines>=20、cli-scanner 全 provider 探测结果、数据根、实际监听地址；零 provider 只提示不阻断。
- `mcp-install.ts`（#566 P3）：`studio mcp install <agent> [--url] [--print] [--uninstall]`——把对外只读 MCP 入口（/api/v1/mcp/external/sse）幂等合入 agent 用户级配置（claude `~/.claude.json` / kimi `~/.kimi-code/mcp.json` / opencode `~/.config/opencode/opencode.json`，均只动 `studio` key、写前 .bak 备份、JSON 损坏拒写）；URL 缺省探测 3001 /mcp/health，不通报错提示 --url；codex 不支持 SSE 报错（Q2 不架 mcp-remote 桥）。

## 注意事项

- **npm 单包形态 = esbuild bundle**（`scripts/build-npm.mjs` → `dist-npm/`，根 package.json files 白名单 `bin/studio` + `dist-npm`）：workspace 包代码全部内嵌，npm 依赖保持 external（= 根 dependencies，metafile 校验内嵌零 node_modules）。`bin/studio` 薄入口：bundle 存在则 import，否则 monorepo fallback 到 tsx 跑源。
- **两个 bundle 相对路径约定**：frontend dist = `<bundle>/../frontend/dist`（与 app.ts:133 同表达式）；内置 skill 正本 = `<bundle>/../skills`（seed.ts defaultSourceDir 上溯一级约定）。改 dist-npm 布局三处要一起动。
- **坑（esbuild 提升）**：index.ts 顶部的 `import 'dotenv/config'` 被 esbuild 提升到 bundle 顶层 → 任何 CLI 动词都会加载 **cwd 的 .env**；其中 PORT 对 `run web` 是显式语义（占用即拒启）。在含 PORT 的仓库目录下跑 `studio run web` 不带 --port 会被 .env 的 PORT 卡住。
- **apps/api 的 tsc dist 不能被 node 直跑**（tsconfig module ESNext 而包无 `type: module`，产物含 ESM import + 裸 require/__dirname）——npm 形态不走 tsc dist，`pnpm start`/`dev` 走 tsx；不要再给 tsc dist 加 bin 指向（apps/api bin 已于 #571 移除）。
- CJS 遗迹：部分模块仍有 `require(...)` 惰性调用——bundle 靠 banner 的 createRequire 兜底，dev 靠 tsx；改 ESM 化时逐文件处理，别指望 tsc 产物直接跑。
- `studio up` 语义不动，但端口口径已随 #573 收口：启动前经 port-probe 解析（PORT 显式占用即拒启，缺省 3001 动态顺延上限 +100），ops preflight 的 lsof abort 与 index.ts 的 EADDRINUSE 3s 无限重试均已删除（后者归 utils/listen-error.ts，listen 竞态撞占用 = 拒启）。checkPrerequisites 的 agent CLI 检查同票对齐 provider 注册表扫描（不再硬编码 claude），缺失只警告不阻断。
