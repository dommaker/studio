# CONTEXT.md — scripts/visual

## 职责

改版验收截图基座（#391，#390 半机制）：Playwright 采集 A 档 17 页 × 3 档宽度默认态 +
交互态补拍 + B 档未认证页（--tier B），pixelmatch 逐像素 diff 产 markdown 报告。
用法与约定见本目录 README.md。

## 核心导出

- `config.ts`：`PAGES`（#379 基线 12 页 + #400 补 A 档 4 页 + NotFound）/ `B_PAGES`（未认证 4 页，spec §10.2）/ `WIDTHS` / `B_WIDTHS` / `RUNS_DIR`（.studio/visual，gitignored）/ `REPORTS_DIR`（docs/visual-reports，入 git）/ `FIXED_TIME` / `shotFileName`
- `report.ts`：`pairShots` / `classify` / `renderMarkdown`（纯函数，报告渲染唯一出口）
- `capture.ts`：采集 CLI；`firstId`（列表 API 响应逐路径探测取首条 id）/ `parseWidths`（--widths 窄屏档覆盖，#395；档位高度须在 config HEIGHTS 登记）/ `parseTier`（--tier B 未认证页，不种 auth 不要求 token）/ `fillPath`（带参路径填值，id 经 encodeURIComponent）/ `buildPrepare`（§10.4 交互态注册表工厂）/ `waitSettled`（拍前沉降）
- `diff.ts`：diff CLI；`parseShotName`

## 注意事项

- 认证走 `POST /api/v1/auth/refresh`（响应字段 `accessToken`），**refresh token 会轮换**——连跑两轮必须每轮重新取最新 token。
- 前端 profile 列表 API 是 `/api/v1/agent-profiles`；`/api/v1/agents` 的 GET / 是 legacy agents-registry 路由（响应无 id 字段），勿用于发现 profileId。
- capture/diff 两 CLI 都有 `isMain` 守卫（`import.meta.url === pathToFileURL(process.argv[1]).href`），单测 import 不会触发执行。
- 频道消息流 SSE 新消息导致的 diff 属可归因面（决议：不追零 diff，追可归因）。
- diff 对比图一律 `diffMask: true` 纯掩码（透明底），不出灰底原图——公开仓脱敏；入库报告 non-clean 条目人工补归因段。
- 拍前沉降三要件（#400 踩坑）：等 guest splash 消失（auth 水合，`user:null` 播种态会先渲 splash）+ 等「加载中/Loading」文案消失 + 等 `.animate-spin` 消失；settings 页串行拉 ~10 个慢 API（/workspaces/runtimes 单发 ~2.5s），waitSettled 超时给 20s。
- buildPrepare 的 `modal-studio-role-setup` 态会把 studio 角色 provider 翻牌 null 再 reload 触发自动弹框，紧随的 `restore-studio-provider` 态负责还原——两态勿拆散；交互态截图前不再重复注入 HIDE_DYNAMIC_CSS（会盖掉 prepare 里的角标揭开样式）。
- /audit-logs、/workspaces/:id、/setup/roles 的 API 均 requireAdmin——采集账号须 Admin（注册后改 users.json role 生效即时，FileStore 每请求读盘）。
