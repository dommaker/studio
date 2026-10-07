# scripts/perf — 性能基线测量与回归门（#673）

把 `docs/architecture/performance-baseline.md` §2 的手工测量方法论固化为脚本：
隔离 `STUDIO_HOME`（mktemp，全程不碰默认数据根）、空闲端口、`STUDIO_AUTH=none`、
`npx tsx apps/api/src/index.ts`（与生产同形态），冷启动 = `/health` 首次 200，
端点 3 warmup + 50 串行记 p50/p95/max，SSE 走真实业务事件链（POST workunit →
workunit.created → events 桥 → `/events/stream`）。

## 命令

```bash
pnpm perf:bench                              # 空数据区基线同口径测量（markdown 上 stdout，JSON 落 tmp）
pnpm perf:bench -- --seed 500 --out s.json   # 预置 500 条 workunit 的数据量画像
pnpm perf:gate                               # bench + 对比 baseline.json，回归 >20% exit 1
npx tsx scripts/perf/compare.ts a.json b.json  # 任意两份报告对比（--threshold / --min-delta-ms 可调）
```

## 回归门

- 判定：相对恶化 **严格大于 20%** 且绝对增量 > 5ms（异机/毫秒级噪声地板）记回归；
  baseline 有而本次未测的端点、出现非 2xx 状态码同样判红。
- 接线：`.github/workflows/perf-gate.yml`（每周 schedule + workflow_dispatch，
  不进日常 CI）；ship 前本地跑 `pnpm perf:gate` 同口径。
- 基线重锚：`baseline.json` 数字锚定参考机（见文件 meta.note）。换参考机或架构
  大版本后，用 `pnpm perf:bench -- --out scripts/perf/baseline.json` 在参考机上
  重测并提交，同时在 performance-baseline.md 记录新锚点与环境差异。

## 文件

| 文件 | 职责 |
|---|---|
| `bench.ts` | 测量主程序（CLI + `runBench()` 供 gate 复用） |
| `compare.ts` | 两份报告对比 CLI |
| `gate.ts` | bench + compare baseline.json 一把梭 |
| `lib/stats.ts` | percentile / summarize 纯函数 |
| `lib/report.ts` | BenchReport 模型 + markdown 渲染 + 回归判定 |
| `lib/server.ts` | 隔离起服/停服、/health 冷启动轮询、/readyz 全量就绪 |
| `baseline.json` | 冻结参考值（performance-baseline.md §6.2/§7/§7.1） |
