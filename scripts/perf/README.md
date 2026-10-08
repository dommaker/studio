# scripts/perf — 性能基线测量与回归门（#673 / #674）

把 `docs/architecture/performance-baseline.md` §2 的手工测量方法论固化为脚本：
隔离 `STUDIO_HOME`（mktemp，全程不碰默认数据根）、空闲端口、`STUDIO_AUTH=none`、
`node node_modules/tsx/dist/cli.mjs apps/api/src/index.ts`（与生产同形态，node 直跑 tsx cli、无 npm 壳），冷启动 = `/health` 首次 200，
端点 3 warmup + 50 串行记 p50/p95/max，SSE 走真实业务事件链（POST workunit →
workunit.created → events 桥 → `/events/stream`）。

## 命令

```bash
pnpm perf:bench                              # 空数据区基线同口径测量（markdown 上 stdout，JSON 落 tmp）
pnpm perf:bench -- --seed 500 --out s.json   # 预置 500 条 workunit 的数据量画像
pnpm perf:gate                               # bench + 对比 baseline.json，回归 >20% exit 1
node node_modules/tsx/dist/cli.mjs scripts/perf/compare.ts a.json b.json  # 任意两份报告对比（--threshold / --min-delta-ms 可调）
pnpm perf:bundle                             # 前端 bundle 预算门（#674，前置：已 pnpm build）
pnpm perf:lcp                                # 已认证主应用 LCP 测量（#674，前置：已 pnpm build:web + 本机 playwright chromium）
pnpm perf:lcp -- --runs 5 --out lcp.json     # 轮数/输出可调
# 事件循环阻塞监控 preload（#678，NODE_OPTIONS --import 须绝对路径；采样窗口/阈值用 EL_MONITOR_INTERVAL_MS / EL_MONITOR_THRESHOLD_MS 调）：
NODE_OPTIONS="--import $PWD/scripts/perf/el-monitor.mjs" node node_modules/tsx/dist/cli.mjs apps/api/src/index.ts
```

## 回归门

- 判定：相对恶化 **严格大于 20%** 且绝对增量 > 5ms（异机/毫秒级噪声地板）记回归；
  baseline 有而本次未测的端点、出现非 2xx 状态码同样判红。
- 阈值正本 `gate-thresholds.json`（#678，bundle-budget.json 同风格）——调阈值 = 改配置
  文件（commit message 说明理由），不改代码；`--threshold` 等 CLI 参数优先于配置文件，
  配置缺失/文件不存在回落 compareReports 内置默认值（20% / 5ms / 1000ms）。
- 接线：`.github/workflows/perf-gate.yml`（每周 schedule + workflow_dispatch，
  不进日常 CI）；ship 前本地跑 `pnpm perf:gate` 同口径。
  不接 ship 自动前置的论据（#678 评估结论，#680 沉淀）：baseline.json 锚定参考机，
  回归门机器敏感，非参考机跑 ship 前置会噪声误红、侵蚀门禁信用；且 bench 分钟级
  耗时会拖慢每次 ship。周频 CI 负责发现 + ship 前人工本地跑负责拦截，是当前机器
  锚定下的合理分工；若未来 baseline 多机化/自校准，再评估进 ship 前置。
- 基线重锚：`baseline.json` 数字锚定参考机（见文件 meta.note）。换参考机或架构
  大版本后，用 `pnpm perf:bench -- --out scripts/perf/baseline.json` 在参考机上
  重测并提交，同时在 performance-baseline.md 记录新锚点与环境差异。

## bundle 预算门（#674）

- `pnpm perf:bundle`：测 `apps/web/dist` 产物（原始字节，非 gzip）四项指标——
  totalJs / entryJs（index entry）/ maxChunk（最大单 chunk）/ totalCss，
  对比 `bundle-budget.json` 预算，超预算 exit 1。
- 阈值 = 基线实测 + ~20-25% 余量，正本 `bundle-budget.json`（含基线测量 commit）。
  调预算 = 改该文件，commit message 说明理由。
- 接线：**进日常 CI**（ci.yml `pnpm build` 之后）——同 lockfile 同代码 size 稳定，
  断言毫秒级，无异机噪声问题，与 perf-gate（机器敏感，挂周频）不同口径。
- LCP 是测量工具不是门：机器敏感、留人工判读，结果记 performance-baseline.md §9。

## 文件

| 文件 | 职责 |
|---|---|
| `bench.ts` | 测量主程序（CLI + `runBench()` 供 gate 复用） |
| `compare.ts` | 两份报告对比 CLI |
| `gate.ts` | bench + compare baseline.json 一把梭 |
| `gate-thresholds.json` | 回归门阈值正本（#678：thresholdPct / minDeltaMs / coldStartMinDeltaMs） |
| `el-monitor.mjs` | 事件循环阻塞监控 preload（#678，原 #675 诊断工具固化；NODE_OPTIONS --import 用） |
| `bundle-budget.ts` | bundle 预算门 CLI（#674） |
| `bundle-budget.json` | bundle 预算正本（阈值 + 基线测量 commit，#674） |
| `lcp.ts` | 已认证主应用 LCP 测量 CLI（#674：隔离 API + 注册用户 + vite preview + chromium + web-vitals） |
| `lib/stats.ts` | percentile / summarize 纯函数 |
| `lib/report.ts` | BenchReport 模型 + markdown 渲染 + 回归判定 |
| `lib/bundle-budget.ts` | bundle 测量/预算判定/报告渲染（#674） |
| `lib/server.ts` | 隔离起服/停服、/health 冷启动轮询、/readyz 全量就绪 |
| `baseline.json` | 冻结参考值（performance-baseline.md §6.2/§7/§7.1） |
