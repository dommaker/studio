# apps/api/bench

### 职责

#323 阶段一（周期循环读口量化测量）的基准 harness：以真实 `~/.studio` 为 1x 模板合成 1x/10x/50x 数据集到 tmp，子进程驱动 8 个周期循环体各 N 轮（外加 monitor 日级窗口补测），聚合产出 markdown 报告。**去留随 #323 评审**（阶段一为一次性测量，不作为常驻工具维护）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `synthesizeDataset` | synthesize-dataset.ts | 数据合成：WU index/events/agents ×scale（id 重映射），channels/knowledge/users 原样复制；模板只读 |
| `parseArgs` | loop-read-metrics.ts | bench 入口参数解析（`--rounds`/`--scales`）；入口脚本（tsx 直跑）合成 → 子进程驱动 → 聚合 |
| `bucketOfFor` | loop-read-worker.ts | 读口事件按存储源分桶（wu-index/studio-events/agent-state/...）；worker 为每档子进程 |
| `summarize` / `renderMarkdown` / `loadWorkerResults` | read-metrics-aggregate.ts | 轮次聚合（分桶计数、各阶段 P50/P95、残差）与 markdown 渲染纯函数 |

### 注意事项

- worker 经 env 注入（`STUDIO_HOME`/`STUDIO_DATA_DIR` 等必须在 app 模块 import 前生效——多处模块级常量 import 期冻结）；父进程 `execFileSync` 子进程隔离每档。
- 事件副本时间单调（#335）：studio-events.jsonl ×scale 时第 k 份副本时间戳偏移 `-k*12h`（createdAt/timestamp 都移），最旧副本在前——整段复制会让全局时间非单调，`readStudioEventsSince` 窗口读口的早停前提（append-only 单调）在合成数据上不成立。
- 安全闸两道：Triage 升级换记录桩（升级路径会拉 systemExecutor 跑 LLM）；PATH 前置假 `systemd-run` 阻断 `scheduleVectorDbSync` → mcp-local-rag ingest（写共享生产 lancedb + 30min 子进程吊住事件 loop；模块内部直线调用，exports 桩拦不住，详见 knowledge/CONTEXT.md）。
- monitor 常态轮预置跳过日级子项；日级窗口（dailyReflection/dataLifecycle/knowledge decay）单列 label 补测，窗口条件强制（状态重置 / Date 冻结到 23:55），只测 1x/50x。
- ops-round 依赖本地 stub HTTP（端口 39100+scale）让 `apiResponding=true`，避开自动重启/退出分支。
- 只读引用 `~/.studio`，合成与驱动全部落在 tmp；metrics 当次 bench root 保留（结果文件所在，启动时自清 >24h 旧根），worker 的 `bench-repo-` 目录经 `process.on('exit')` 自清（2026-08-26 /tmp 泄漏修复）。
- #363（2026-08-26）：worker 驱动循环前跑一次 `fileStore.sweepEmptyAgentDirs()`——模拟 API 启动时的一次性存量清扫；合成数据集继承模板的历史空实例目录，不先清扫测不出目录闭环的读口收益（生产同路径在 apps/api index.ts 启动段）。
