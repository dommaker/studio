# CONTEXT.md — scripts/visual

## 职责

改版验收截图基座（#391，#390 半机制）：Playwright 采集 12 页 × 3 档宽度默认态截图 +
pixelmatch 逐像素 diff 产 markdown 报告。用法与约定见本目录 README.md。

## 核心导出

- `config.ts`：`PAGES`（12 页清单，#379 基线）/ `WIDTHS` / `RUNS_DIR`（.studio/visual，gitignored）/ `REPORTS_DIR`（docs/visual-reports，入 git）/ `FIXED_TIME` / `shotFileName`
- `report.ts`：`pairShots` / `classify` / `renderMarkdown`（纯函数，报告渲染唯一出口）
- `capture.ts`：采集 CLI；`firstId`（列表 API 响应逐路径探测取首条 id）
- `diff.ts`：diff CLI；`parseShotName`

## 注意事项

- 认证走 `POST /api/v1/auth/refresh`（响应字段 `accessToken`），**refresh token 会轮换**——连跑两轮必须每轮重新取最新 token。
- 前端 profile 列表 API 是 `/api/v1/agent-profiles`；`/api/v1/agents` 的 GET / 是 legacy agents-registry 路由（响应无 id 字段），勿用于发现 profileId。
- capture/diff 两 CLI 都有 `isMain` 守卫（`import.meta.url === pathToFileURL(process.argv[1]).href`），单测 import 不会触发执行。
- 频道消息流 SSE 新消息导致的 diff 属可归因面（决议：不追零 diff，追可归因）。
- diff 对比图一律 `diffMask: true` 纯掩码（透明底），不出灰底原图——公开仓脱敏；入库报告 non-clean 条目人工补归因段。
