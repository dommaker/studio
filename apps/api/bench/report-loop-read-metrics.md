# 周期循环读口量化测量报告（#323 阶段一）

- 生成时间：2026-09-01T13:14:23.678Z
- 口径：每循环每档 21 轮，首轮冷缓存单列，暖轮（≥2）聚合；耗时单位 ms
- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测等）
- 分段归因口径（#411）：读口 = FileStore 四读口 + knowledgeRead（memo 指纹 stat/clone 与 miss 时穿透 harness 存储栈的磁读）；harness = @dommaker/harness 存储栈调用级打点（FileKnowledgeStore 方法 + lifecycle/ingest/query/injector/linter facade，嵌套只记顶层），上报自耗时 = span 全时长 − 嵌套在其中的读口耗时（与读口段按构造不相交）；exec = execAsync/execFileAsync 子进程（按命令前 3 token 分列）；其他（残差）= wall P50 − 读口/harness/exec 三段 P50 之和，含业务纯计算与未打点 I/O（inline 构造的 harness 对象纯 CPU 段也在此列）
- 并发口径注意：并发读口循环（如 agent-timeout 的 listStates Promise.all）逐事件耗时可远大于 wall，此类循环的读口列与「其他（残差）」可为负——以 wall 为准

## 数据集画像

| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |
|---|---|---|---|---|
| 1x | 56 | 124 | 15 | 7 |

## 总览（暖轮 P50；wall 含 P95）

| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |
|---|---|---|---|---|---|---|---|
| agent-timeout | 1x | 16 | 8.7 | 20.0 | 1.3 | 5.0 | 0% |
| auditor-round | 1x | 18 | 180 | 193 | 220 | 232 | 18% |
| dispatch-reconciliation | 1x | 3 | 0.69 | 1.1 | 0.79 | 1.2 | 12% |
| evolution-scan | 1x | 1 | 0.07 | 0.15 | 0.73 | 1.1 | 90% |
| monitor-daily-reflection | 1x | 6 | 148 | 157 | 545 | 571 | 73% |
| monitor-data-lifecycle | 1x | 3 | 1.5 | 1.6 | 3.3 | 3.8 | 53% |
| monitor-knowledge-decay | 1x | 689 | 897 | 1069 | 946 | 1120 | 5% |
| monitor-round | 1x | 213 | 168 | 194 | 193 | 225 | 13% |
| ops-round | 1x | 0 | 0.00 | 0.00 | 51.3 | 64.5 | 100% |
| workunit-input-reminder | 1x | 1 | 0.25 | 1.2 | 0.29 | 1.3 | 15% |
| wu-timeout | 1x | 1 | 0.31 | 0.37 | 0.36 | 0.47 | 14% |

## 分段归因（暖轮 P50，ms）

| 循环 | 档位 | 读口 | harness | exec | 其他（残差） | wall P50 |
|---|---|---|---|---|---|---|
| agent-timeout | 1x | 8.7 | 0.00 | 0.00 | -7.32 | 1.3 |
| auditor-round | 1x | 180 | 17.8 | 0.00 | 22.9 | 220 |
| dispatch-reconciliation | 1x | 0.69 | 0.00 | 0.00 | 0.10 | 0.79 |
| evolution-scan | 1x | 0.07 | 0.00 | 0.00 | 0.66 | 0.73 |
| monitor-daily-reflection | 1x | 148 | 1.6 | 4.1 | 392 | 545 |
| monitor-data-lifecycle | 1x | 1.5 | 0.00 | 0.00 | 1.7 | 3.3 |
| monitor-knowledge-decay | 1x | 897 | 37.6 | 3.7 | 6.9 | 946 |
| monitor-round | 1x | 168 | 10.5 | 4.3 | 9.8 | 193 |
| ops-round | 1x | 0.00 | 0.00 | 0.00 | 51.3 | 51.3 |
| workunit-input-reminder | 1x | 0.25 | 0.00 | 0.00 | 0.04 | 0.29 |
| wu-timeout | 1x | 0.31 | 0.00 | 0.00 | 0.05 | 0.36 |

### exec 命令明细（暖轮）

| 循环 | 档位 | 命令 | 次/轮 | 耗时 P50 |
|---|---|---|---|---|
| monitor-daily-reflection | 1x | git log --since=2026-08-31T13:14:18.940Z | 0.5 | 0.00 |
| monitor-daily-reflection | 1x | git log --since=2026-08-31T13:14:19.511Z | 0.5 | 0.00 |
| monitor-knowledge-decay | 1x | npx harness update-user-model | 1.0 | 3.7 |
| monitor-round | 1x | git worktree prune | 1.0 | 4.3 |

## 冷轮（首轮，缓存全冷）

| 循环 | 档位 | 读次数 | 读口合计 | wall |
|---|---|---|---|---|
| agent-timeout | 1x | 16 | 21.7 | 3.8 |
| auditor-round | 1x | 18 | 173 | 256 |
| dispatch-reconciliation | 1x | 3 | 0.75 | 1.8 |
| evolution-scan | 1x | 2 | 3.9 | 7.9 |
| monitor-daily-reflection | 1x | 5 | 151 | 579 |
| monitor-data-lifecycle | 1x | 4 | 8.9 | 12.6 |
| monitor-knowledge-decay | 1x | 689 | 853 | 905 |
| monitor-round | 1x | 311 | 609 | 659 |
| ops-round | 1x | 0 | 0.00 | 76.5 |
| workunit-input-reminder | 1x | 1 | 0.28 | 0.58 |
| wu-timeout | 1x | 1 | 2.4 | 3.9 |

## 分桶明细（暖轮，按存储源）

### agent-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | agent-state | 15.0 | 47% | 0.58/1.7 | 0.00/0.00 | 0.00/0.01 |
| 1x | agents-dir | 1.0 | 100% | 0.05/1.7 | 0.00/0.00 | 0.00/0.00 |

### auditor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 12.0 | 83% | 0.08/0.31 | 0.00/0.09 | 0.01/0.02 |
| 1x | knowledge | 5.0 | 0% | 0.95/1.3 | 2.4/163 | 0.06/1.7 |
| 1x | wu-index | 1.0 | 100% | 0.11/0.40 | 0.00/0.00 | 0.26/0.31 |

### dispatch-reconciliation

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 3.0 | 100% | 0.04/0.08 | 0.00/0.00 | 0.19/0.28 |

### evolution-scan

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | other | 1.0 | 0% | 0.07/0.15 | 0.00/0.00 | 0.00/0.00 |

### monitor-daily-reflection

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 4.0 | 75% | 0.08/0.11 | 0.00/0.11 | 0.01/0.03 |
| 1x | knowledge | 2.0 | 0% | 0.94/1.00 | 1.6/151 | 0.04/1.4 |

### monitor-data-lifecycle

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 2.0 | 0% | 0.04/0.05 | 0.40/0.44 | 0.19/0.22 |
| 1x | wu-index | 1.0 | 100% | 0.03/0.06 | 0.00/0.00 | 0.20/0.21 |

### monitor-knowledge-decay

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | knowledge | 689.0 | 70% | 0.75/1.2 | 0.00/0.99 | 0.02/0.04 |

### monitor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | knowledge | 206.0 | 100% | 0.73/1.1 | 0.00/0.00 | 0.02/0.04 |
| 1x | wu-index | 7.0 | 100% | 0.05/0.48 | 0.00/0.00 | 0.01/0.25 |

### ops-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### workunit-input-reminder

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.06/0.94 | 0.00/0.00 | 0.19/0.29 |

### wu-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.06/0.07 | 0.00/0.00 | 0.24/0.30 |

## 驱动缺口

- monitor 日级窗口已补测（1x/50x 单列 monitor-daily-reflection / monitor-data-lifecycle / monitor-knowledge-decay，窗口条件强制开启）；user-model 更新（npx harness）已纳入 exec 段测量（#411），在 monitor-knowledge-decay 日级窗口轮内实测（bench 为假 npx 桩，记录的是桩壳开销；常态 5min 轮不触发，与生产 24h 门控一致），真实耗时以生产数据为准
- ops-round 的 apiResponding=false 分支（自动重启/退出）与 preflight：不属于周期健康轮，未测
- auditor 的失败执行分支（eval case 生成 / auto resolution / Triage 升级 / 确认卡片）：合成数据全成功执行，未触发；触发型读口未计入
- Triage 升级被记录桩替换（安全闸：升级路径会拉 systemExecutor 跑 LLM 诊断，bench 不可触碰）；触发次数见 worker 输出 triageStubCalls

## 测量代码清单

- packages/studio-shared/src/read-metrics.ts（新增：sink + ALS 归因 + readMetricsBegin/emitReadMetric；#411 增段事件 SegmentMetricEvent + runSegmentSpan + wrapWithSegmentSpan）
- packages/studio-shared/src/file-store.ts（readJson / readJsonl / readdirCached / readIndexForQuery 四读口内计时埋点；锁内裸读路径未动）
- packages/studio-shared/package.json（exports 增 ./read-metrics 子路径）
- apps/api/src/modules/agents/monitor/exec-async.ts（#411：execAsync/execFileAsync 内 exec 段计时上报，命令名前 3 token）
- apps/api/src/modules/knowledge/knowledge-singletons.ts（#411：装配层包装 rawKnowledgeStore + 五 facade 方法为 harness 段 span，嵌套只记顶层）
- apps/api/bench/synthesize-dataset.ts（新增：数据合成器，只读 ~/.studio → tmp 合成 1x/10x/50x）
- apps/api/bench/loop-read-worker.ts（新增：单档循环驱动 worker；#411 增段事件采集 + user-model 门控放开）
- apps/api/bench/loop-read-metrics.ts（新增：bench 入口，合成 → 子进程驱动 → 聚合出报告；#411 增 git init REPO_DIR + 假 npx 桩）
- apps/api/bench/read-metrics-aggregate.ts（新增：轮次聚合 + markdown 渲染纯函数；#411 增分段归因表 + exec 命令明细）
- apps/api/bench/__tests__/（新增：上述模块的单测）
- apps/api/vitest.config.ts（include 增 bench/**/__tests__/**/*.test.ts）

## 建/不建快照层建议

（待人工分析后填写）
