# 性能基线测量脚本化 + 回归门（#673）

日期：2026-10-08　工单：#673　上位计划：docs/plans/2026-10-arch-deepening.md Phase 4

## 目标

把 `docs/architecture/performance-baseline.md` 的手工测量方法论固化成脚本：一条命令复现基线同口径测量，回归门 >20% 红，补有数据量下 FileStore 全量扫描端点画像。

## 设计

### 落点：`scripts/perf/`（新建）

| 文件 | 职责 |
|---|---|
| `lib/stats.ts` | 纯函数：percentile / summarize（p50/p95/max） |
| `lib/report.ts` | BenchReport 类型 + renderMarkdown（baseline 同口径表格）+ compareReports（>20% 回归检测，min-delta 绝对噪声地板） |
| `lib/server.ts` | 隔离起服：mkdtemp STUDIO_HOME + 空闲端口 + spawn `npx tsx apps/api/src/index.ts`，/health 轮询出冷启动，/readyz 出全量就绪 |
| `bench.ts` | CLI：冷启动 3 轮（run1 全新数据区 / run2/3 重启）+ 读 8 端点（3 warmup + 50 串行）+ 写 2 端点 + SSE 20 轮；`--seed N` 先经 API 预置 N 条 workunit 再测（数据量画像） |
| `compare.ts` | CLI：两份 report JSON 对比，回归 >阈值（默认 20%）exit 1 |
| `gate.ts` | bench + compare baseline.json 一把梭（`pnpm perf:gate`） |
| `baseline.json` | 冻结参考值（performance-baseline.md §6.2/§7/§7.1，commit ff546ba9） |
| `README.md` | 用法 |

### 回归门接线（二选一决策）

票给「接 CI 或 studio-ship 前置」。决策：**接 CI，但不进日常 CI**——新增 `.github/workflows/perf-gate.yml`，仅 `workflow_dispatch` + 每周 schedule，跑 `pnpm perf:gate`，回归即红。理由：① studio-config 是另一 checkout，守夜会话纪律不碰；② 不拖慢日常 CI（票面选择标准）；③ ship 前本地跑同一命令即可，文档注明。compare 带 `--min-delta-ms 5` 绝对地板，防 CI 异机毫秒级噪声误红。

### TDD

纯逻辑（stats / compareReports / renderMarkdown）先写 FAIL 测试（`scripts/perf/__tests__/`）再实现；server/bench 为 I/O 编排，靠真实 bench 跑通验证。

## 验收

- `pnpm perf:bench` 一条命令出 baseline 同口径报告（实跑一次）。
- 人为回归实测：doctored report 喂 compare → exit 1（拦得住）。
- `--seed 500` 数据量画像 → performance-baseline.md 新 §8。
- performance-baseline.md / target-architecture.md 性能预算节同步。
- `pnpm test`（scripts 项目新测试）+ `pnpm typecheck` 绿。
