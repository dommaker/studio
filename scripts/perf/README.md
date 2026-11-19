# scripts/perf — 性能基线、规模场景与回归门

所有运行场景使用隔离 `STUDIO_HOME`/`STUDIO_DATA_DIR` 和本机回环空闲端口，不读默认数据根、真实凭证或远端服务。API 以 `node node_modules/tsx/dist/cli.mjs apps/api/src/index.ts` 启动；浏览器测 `apps/web/dist` 构建产物。

## 命令

```bash
pnpm perf:bench                              # 空数据区 baseline 同口径；默认 3 轮重复
pnpm perf:bench --seed 500 --out s.json      # WU 单域数据量画像（兼容旧工具）
pnpm perf:gate                               # full：每周 workflow / 发布前，完整规模 + 100频道/1000详情
pnpm perf:gate --quick                       # 日常本地：小矩阵 + 20 HTTP/browser 样本；legacy 空区仍用60样本
pnpm perf:gate --quick --skip-browser        # 显式诊断运行；输出不代表浏览器门禁证据
pnpm perf:scale                              # 五域规模、HTTP/SSE 并发、WU 写路径、知识注入、真实 AgentLoop
pnpm perf:scale --wu 20 --events 50 --messages 100 --notifications 20 --knowledge 10 --roles 4 --http-concurrency 2 --sse-clients 2 --repeats 2
pnpm perf:browser                            # 长历史、持续 SSE、长会话 heap、LCP/INP/long task/dropped frames
pnpm perf:browser --channels 4 --messages 100 --sse-events 3 --detail-visits 10 --repeats 2
node node_modules/tsx/dist/cli.mjs scripts/perf/compare.ts a.json b.json
pnpm perf:bundle                             # 前端 bundle 预算门（前置：pnpm build）
pnpm perf:lcp                                # 旧单首载 LCP 工具（前置：pnpm build:web + chromium）
```

`perf:scale` 的 AgentLoop 使用真实观察、claim、`agentStep`、`recordResult` 和业务存储，只把外部 Executor 换成确定性假实现，不启动真实 LLM。临时 `pkill`/`systemd-run`/`claude` 工具只用于隔离环境，防止测量触及宿主任务或向量库。

## 门禁口径（PERF-07）

- 输出固定分 **correctness / latency / soak**。HTTP 非 2xx、缺失端点、规模结果和持久化副作用归 correctness；时延回归/绝对预算归 latency；持续 SSE、INP 和长会话内存归 soak。
- 每个旧端点默认 3 轮重复，硬门只比较 **p50/p95**。相对回归仍为严格 `>20%` 且超过 5ms 噪声地板；同时必须满足绝对预算。**max 只进 observations/诊断，绝不判红**，没有改名后的替代硬门。
- 旧 bench 保持空数据区，与 `baseline.json` 同口径；默认 gate 的非空证据由 `scale.ts` 和 `browser.ts` 提供，避免拿空区 baseline 与规模区误比。执行顺序为 scale → browser → legacy，避免浏览器负载污染规模时延；每次 gate 将当次内层报告分别写到 `/tmp/studio-perf-gate-{scale,browser}-<runId>.json` 并打印路径，不引用独立运行结果。
- `runWorkerPool(concurrency, runs)` 只启动固定数量 worker，每个 worker 串行执行 runs；不得把 `concurrency×runs` 误当并发数。HTTP 样本 = repeats×concurrency×runs；update/claim/lease/knowledge/token 样本 = repeats×runs。
- `measureScenarioAlternating` 按 B,C / C,B 交替，但 B/C 必须是**同端点、同冻结数据快照**，action-center 与 overview 不得互相冒充 A/B。B/C 漂移只诊断；冻结旧 commit 不伪称可交替重跑的代码版本 A/B。
- 每个 `BudgetMetric` 携带 `n/minSamples`。空样本、样本不足、必需 latency/soak/correctness 缺项均 fail-closed；role shared、scale visible、SSE 全收、action-center stateItems、LCP/INP 都不能缺测出绿。
- 默认规模矩阵：200 WU、1000 事件、2000 消息、200 通知、100 知识、20 角色、10 HTTP 并发、4 SSE client。覆盖 action-center（含 blocked/in_review/pending 与 waitingForInput 三类 stateItems）、overview、知识注入、真实 AgentLoop，以及 updateMetadata、并发 claim、lease flush、30 次 token ledger 写入。诊断记录锁等待、event-loop delay、RSS、读取字节、parse 行数和磁盘读取（cache miss）；角色观察另断言共享读取次数。
- 默认浏览器拆成一次完整 soak + 至少20个 vitals 样本：完整 soak 覆盖 100 频道、2000 长历史消息、50 持续 SSE、1000 详情访问，必须完成真实旧页响应、精确收到全部 SSE id，并逐次等待 1000 个目标详情 DOM 内容后才测 GC heap。LCP/INP 另在同一长历史页做真实输入交互，quick/default 都至少20个有效样本，不重复完整详情 soak。long task/dropped frames 只诊断。CDP `Performance.enable + HeapProfiler.collectGarbage` 后的 heap 必须非零，拒绝内存假绿；精确驻留键数由 PERF-06 store 直测覆盖，浏览器不虚报键数。
- 新出现且尚无基线的真实 AgentLoop step、角色惊群时延只诊断，correctness 仍为硬门；不得为变绿删除旧端点或放宽原复杂度断言。PERF-01 的逐次 `read <= appended` 硬断言继续由原测试承担，规模报告不另造较宽松替代口径。

### 统一绝对预算

正本 `gate-thresholds.json`：读 p50/p95 = 50/100ms、写 = 150/300ms、SSE p50/p95 = 50/100ms、冷启动中位数 = 10s，依据 `docs/architecture/performance-baseline.md` §5、§7、§7.1。scale/browser 全部经 `lib/thresholds.ts` 读同一文件，不得在场景内另写预算。

浏览器 LCP p50/p95 = 1000/2000ms：p95 沿用既有 2s 目标，p50 约为旧实测 516ms 的 2 倍；INP p50/p95 = 100/200ms，采用 Web Vitals “good <200ms”绝对预算；长会话 GC 后 heap 增长预算 128MiB，是有界矩阵的绝对资源上限。上述预算与机器 max 尖刺无关。

## 接线与基线重锚

- `.github/workflows/perf-gate.yml` 维持每周 schedule + workflow_dispatch，不进日常 CI；ship 前本地跑同一 `pnpm perf:gate`。浏览器场景需要已构建 `apps/web/dist` 和本机 Playwright Chromium，缺任一条件会失败而不是跳过出绿。
- 机器敏感的绝对时延结果必须连环境一起判读，不能用一次 max 归因业务回归。`baseline.json` 只锚 legacy 空区；换参考机或架构大版本后重锚，并记录环境差异。重锚必须取完整默认 gate 同次的 20×3（每端点60样本）legacy 报告，保留全部端点、max/SSE/cold-start 诊断和旧值原因；禁止用更快单次或 cherry-pick。20%+5ms 相对门与绝对预算不得随重锚放宽。
- `lib/telemetry.mjs` 只在主线程写 event-loop/RSS/readBytes/parsedLines/cacheMisses，worker 不覆盖报告，临时文件名带递增序号；首个 preload 进程通过 `PERF_TELEMETRY_OWNER_PID` 取得所有权，继承 `NODE_OPTIONS` 的 node 子进程不得覆盖 API 报告。`lib/server.ts` 使用最小 env allowlist，同时重置 `STUDIO_HOME`、`STUDIO_DATA_DIR`、`STUDIO_EVENTS_FILE`。`DOTENV_CONFIG_PATH` 指向隔离空文件，`JWT_SECRET`/`ENCRYPTION_KEY` 每次随机生成，不继承宿主 secret，也不读取仓内真实 `.env`。
- 隔离 API 日志写临时 `perf-server.log`，启动失败保留尾部诊断；浏览器仅开启 `pw:browser` 日志（不记录可能含认证参数的 `pw:api`），并记录 page crash/disconnect 与详情进度。浏览器失败时保留隔离目录及脱敏 `failure.json`，成功才清理；报告 JSON 默认写 `/tmp` 或 `--out` 指定位置。`--skip-browser` 仅诊断，其他类别全绿时也返回 2，绝不作为门禁缺项通行证。

## bundle 预算门（#674）

- `pnpm perf:bundle` 检查 totalJs / entryJs / maxChunk / totalCss 原始字节，正本 `bundle-budget.json`；进日常 CI。
- 旧 `perf:lcp` 保留为单首载诊断工具；完整交互与长会话门禁归 `perf:browser`，不再用空频道 LCP 代替。

## 文件

| 文件 | 职责 |
|---|---|
| `bench.ts` | legacy 空区多轮测量主程序 |
| `compare.ts` | 两份 bench 报告对比 CLI |
| `gate.ts` | correctness/latency/soak 总门 |
| `scale.ts` | 五域规模、角色/HTTP/SSE 并发和真实写/Loop 场景 |
| `browser.ts` | 长历史、持续 SSE、INP/LCP 和长会话内存场景 |
| `gate-thresholds.json` | 统一回归阈值和绝对预算 |
| `el-monitor.mjs` | 独立事件循环阻塞诊断 preload |
| `lib/telemetry.mjs` | 隔离 API 的读取量/RSS/event-loop preload |
| `lib/measure.ts` | 同场景交替测量和资源诊断汇总 |
| `lib/thresholds.ts` | scale/browser 统一读取 gate-thresholds.json |
| `lib/stats.ts` | percentile / summarize 纯函数 |
| `lib/report.ts` | BenchReport、p50/p95 硬门、max observations |
| `lib/server.ts` | 隔离起停服、就绪轮询、telemetry 和启动日志 |
| `lcp.ts` | 旧 LCP 工具及浏览器共享 preview/auth 装配 |
| `baseline.json` | legacy 空区冻结参考值 |
