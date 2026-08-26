# 周期循环读口量化测量报告（#363 复测：实例目录生命周期闭环后）

- 生成时间：2026-08-26T06:43:27.945Z
- 口径：每循环每档 21 轮，首轮冷缓存单列，暖轮（≥2）聚合；耗时单位 ms
- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测等）

## 数据集画像

| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |
|---|---|---|---|---|
| 1x | 55 | 721 | 15 | 7 |
| 10x | 460 | 7072 | 150 | 70 |
| 50x | 2260 | 3494 | 750 | 350 |

## 总览（暖轮 P50；wall 含 P95）

| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |
|---|---|---|---|---|---|---|---|
| agent-timeout | 1x | 16 | 9.0 | 14.1 | 1.3 | 2.1 | 0% |
| agent-timeout | 10x | 151 | 437 | 631 | 5.8 | 7.7 | 0% |
| agent-timeout | 50x | 751 | 9062 | 11105 | 25.0 | 30.2 | 0% |
| auditor-round | 1x | 9 | 4.5 | 7.2 | 182 | 241 | 98% |
| auditor-round | 10x | 9 | 7.4 | 10.4 | 223 | 263 | 97% |
| auditor-round | 50x | 9 | 14.2 | 18.9 | 341 | 363 | 96% |
| dispatch-reconciliation | 1x | 3 | 0.73 | 0.94 | 0.83 | 1.1 | 13% |
| dispatch-reconciliation | 10x | 3 | 5.1 | 6.7 | 5.4 | 7.0 | 4% |
| dispatch-reconciliation | 50x | 3 | 28.2 | 29.9 | 29.2 | 30.9 | 4% |
| evolution-scan | 1x | 1 | 0.08 | 0.12 | 0.78 | 1.2 | 90% |
| evolution-scan | 10x | 1 | 0.06 | 0.09 | 0.74 | 0.92 | 91% |
| evolution-scan | 50x | 1 | 0.07 | 0.10 | 0.73 | 1.9 | 91% |
| monitor-daily-reflection | 1x | 4 | 0.41 | 0.56 | 484 | 537 | 100% |
| monitor-daily-reflection | 50x | 4 | 0.43 | 0.49 | 475 | 479 | 100% |
| monitor-data-lifecycle | 1x | 3 | 6.3 | 6.6 | 12.2 | 13.1 | 48% |
| monitor-data-lifecycle | 50x | 3 | 34.9 | 43.9 | 63.4 | 80.5 | 45% |
| monitor-knowledge-decay | 1x | 0 | 0.00 | 0.00 | 1294 | 1305 | 100% |
| monitor-knowledge-decay | 50x | 0 | 0.00 | 0.00 | 1275 | 1325 | 100% |
| monitor-round | 1x | 7 | 2.1 | 3.9 | 691 | 806 | 100% |
| monitor-round | 10x | 7 | 13.4 | 26.0 | 704 | 785 | 98% |
| monitor-round | 50x | 7 | 65.7 | 82.3 | 743 | 819 | 91% |
| ops-round | 1x | 0 | 0.00 | 0.00 | 59.8 | 75.7 | 100% |
| ops-round | 10x | 0 | 0.00 | 0.00 | 63.4 | 69.4 | 100% |
| ops-round | 50x | 0 | 0.00 | 0.00 | 53.2 | 56.6 | 100% |
| workunit-input-reminder | 1x | 1 | 0.26 | 0.34 | 0.30 | 0.42 | 12% |
| workunit-input-reminder | 10x | 1 | 1.6 | 2.4 | 1.7 | 2.5 | 3% |
| workunit-input-reminder | 50x | 1 | 9.0 | 10.5 | 9.2 | 10.7 | 2% |
| wu-timeout | 1x | 1 | 0.28 | 0.53 | 0.33 | 0.58 | 16% |
| wu-timeout | 10x | 1 | 1.7 | 2.9 | 1.8 | 3.0 | 5% |
| wu-timeout | 50x | 1 | 9.4 | 10.7 | 9.7 | 10.9 | 3% |

## 冷轮（首轮，缓存全冷）

| 循环 | 档位 | 读次数 | 读口合计 | wall |
|---|---|---|---|---|
| agent-timeout | 1x | 16 | 25.1 | 4.5 |
| agent-timeout | 10x | 151 | 1694 | 22.3 |
| agent-timeout | 50x | 751 | 33703 | 91.1 |
| auditor-round | 1x | 9 | 3.4 | 251 |
| auditor-round | 10x | 9 | 12.2 | 307 |
| auditor-round | 50x | 9 | 22.7 | 498 |
| dispatch-reconciliation | 1x | 3 | 0.79 | 1.7 |
| dispatch-reconciliation | 10x | 3 | 5.5 | 6.9 |
| dispatch-reconciliation | 50x | 3 | 25.9 | 27.9 |
| evolution-scan | 1x | 1 | 0.18 | 5.5 |
| evolution-scan | 10x | 1 | 0.15 | 6.3 |
| evolution-scan | 50x | 1 | 0.14 | 4.4 |
| monitor-daily-reflection | 1x | 4 | 0.59 | 498 |
| monitor-daily-reflection | 50x | 4 | 0.40 | 487 |
| monitor-data-lifecycle | 1x | 3 | 10.2 | 21.7 |
| monitor-data-lifecycle | 50x | 3 | 242 | 556 |
| monitor-knowledge-decay | 1x | 0 | 0.00 | 1280 |
| monitor-knowledge-decay | 50x | 0 | 0.00 | 1227 |
| monitor-round | 1x | 7 | 2.0 | 838 |
| monitor-round | 10x | 7 | 11.6 | 759 |
| monitor-round | 50x | 7 | 76.1 | 840 |
| ops-round | 1x | 0 | 0.00 | 72.1 |
| ops-round | 10x | 0 | 0.00 | 78.2 |
| ops-round | 50x | 0 | 0.00 | 76.7 |
| workunit-input-reminder | 1x | 1 | 0.56 | 0.96 |
| workunit-input-reminder | 10x | 1 | 2.8 | 3.2 |
| workunit-input-reminder | 50x | 1 | 8.9 | 9.4 |
| wu-timeout | 1x | 1 | 1.9 | 3.1 |
| wu-timeout | 10x | 1 | 9.1 | 10.5 |
| wu-timeout | 50x | 1 | 48.8 | 50.4 |

## 分桶明细（暖轮，按存储源）

### agent-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | agent-state | 15.0 | 47% | 0.60/1.0 | 0.00/0.00 | 0.00/0.02 |
| 1x | agents-dir | 1.0 | 100% | 0.05/0.06 | 0.00/0.00 | 0.00/0.00 |
| 10x | agent-state | 150.0 | 47% | 2.9/4.5 | 0.00/0.00 | 0.00/0.01 |
| 10x | agents-dir | 1.0 | 100% | 0.05/0.09 | 0.00/0.00 | 0.00/0.00 |
| 50x | agent-state | 750.0 | 47% | 11.9/16.4 | 0.00/0.00 | 0.00/0.01 |
| 50x | agents-dir | 1.0 | 100% | 0.05/0.07 | 0.00/0.00 | 0.00/0.00 |

### auditor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 8.0 | 75% | 0.09/1.9 | 0.00/0.13 | 0.01/0.03 |
| 1x | wu-index | 1.0 | 100% | 0.11/0.15 | 0.00/0.00 | 0.28/0.32 |
| 10x | channels | 8.0 | 75% | 0.09/1.9 | 0.00/0.13 | 0.01/0.04 |
| 10x | wu-index | 1.0 | 100% | 0.11/0.19 | 0.00/0.00 | 2.0/2.5 |
| 50x | channels | 8.0 | 75% | 0.09/2.0 | 0.00/0.12 | 0.01/0.03 |
| 50x | wu-index | 1.0 | 100% | 0.10/0.11 | 0.00/0.00 | 9.2/13.9 |

### dispatch-reconciliation

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 3.0 | 100% | 0.04/0.06 | 0.00/0.00 | 0.20/0.27 |
| 10x | wu-index | 3.0 | 100% | 0.07/0.42 | 0.00/0.00 | 1.6/2.2 |
| 50x | wu-index | 3.0 | 100% | 0.10/0.13 | 0.00/0.00 | 9.1/11.3 |

### evolution-scan

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | other | 1.0 | 0% | 0.08/0.12 | 0.00/0.00 | 0.00/0.00 |
| 10x | other | 1.0 | 0% | 0.06/0.09 | 0.00/0.00 | 0.00/0.00 |
| 50x | other | 1.0 | 0% | 0.07/0.10 | 0.00/0.00 | 0.00/0.00 |

### monitor-daily-reflection

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 4.0 | 75% | 0.08/0.13 | 0.00/0.11 | 0.01/0.02 |
| 50x | channels | 4.0 | 75% | 0.07/0.10 | 0.00/0.14 | 0.01/0.02 |

### monitor-data-lifecycle

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 2.0 | 0% | 0.07/0.08 | 1.8/1.9 | 1.1/1.2 |
| 1x | wu-index | 1.0 | 100% | 0.06/0.06 | 0.00/0.00 | 0.23/0.33 |
| 50x | studio-events | 2.0 | 0% | 0.11/0.15 | 8.4/12.1 | 4.9/6.7 |
| 50x | wu-index | 1.0 | 100% | 0.07/0.07 | 0.00/0.00 | 8.3/10.6 |

### monitor-knowledge-decay

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### monitor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 7.0 | 100% | 0.06/0.17 | 0.00/0.00 | 0.22/0.32 |
| 10x | wu-index | 7.0 | 100% | 0.07/1.9 | 0.00/0.00 | 1.7/2.7 |
| 50x | wu-index | 7.0 | 100% | 0.09/2.3 | 0.00/0.00 | 9.2/13.4 |

### ops-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### workunit-input-reminder

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.06/0.13 | 0.00/0.00 | 0.19/0.27 |
| 10x | wu-index | 1.0 | 100% | 0.07/0.25 | 0.00/0.00 | 1.5/1.8 |
| 50x | wu-index | 1.0 | 100% | 0.09/0.11 | 0.00/0.00 | 8.9/10.4 |

### wu-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.07/0.18 | 0.00/0.00 | 0.20/0.25 |
| 10x | wu-index | 1.0 | 100% | 0.08/0.85 | 0.00/0.00 | 1.6/2.0 |
| 50x | wu-index | 1.0 | 100% | 0.12/0.22 | 0.00/0.00 | 9.3/10.5 |

## 驱动缺口

- monitor 日级窗口已补测（1x/50x 单列 monitor-daily-reflection / monitor-data-lifecycle / monitor-knowledge-decay，窗口条件强制开启）；user-model 更新（npx harness 子进程）不属于读口测量面，未测
- ops-round 的 apiResponding=false 分支（自动重启/退出）与 preflight：不属于周期健康轮，未测
- auditor 的失败执行分支（eval case 生成 / auto resolution / Triage 升级 / 确认卡片）：合成数据全成功执行，未触发；触发型读口未计入
- Triage 升级被记录桩替换（安全闸：升级路径会拉 systemExecutor 跑 LLM 诊断，bench 不可触碰）；触发次数见 worker 输出 triageStubCalls

## 复测结论（#363）

**前后对比（agent-timeout 档）**：

| 档位 | 读次数/轮（前 → 后） | wall P50（前 → 后） |
|---|---|---|
| 50x | 37301 → 751 | 1486ms → 25.0ms |

- 「前」= #363 工单正文记录的基线（同口径 21 轮，50x 合成档含 753×50 目录、其中 735×50 空死实例目录）；「后」= 本报告。
- 751 = 1 次 agents/ readdir（缓存 100% 命中）+ 750 次 state.json 探测。750 目录 = （7 存活实例 + 8 profile）× 50——worker 驱动前跑了一次与生产同路径的 `sweepEmptyAgentDirs`（模拟 API 启动），空目录全部清掉；冷轮里首轮扫描把陈旧心跳实例 terminate、次轮经 #363 回收路径清目录清 state，暖轮起进入稳态。
- 读次数比工单预估的「~350（存活实例数）」多出的 400 次 = 8 个 profile 目录 × 50 的 state.json 空探测：profile 与 state 共享 `agents/<id>/` namespace（决策 1 红线），有 profile.json 的目录绝不删，这部分探测是布局固有成本。
- 命中率从 1% 升到 47%（750 次探测中 350 次命中真实 state 文件）。

**判定（决策 4）**：目录闭环后扫描对象从 ~37650 目录降到 ~750，量级达标；负结果缓存维持不做。

## 测量代码清单

- packages/studio-shared/src/read-metrics.ts（新增：sink + ALS 归因 + readMetricsBegin/emitReadMetric）
- packages/studio-shared/src/file-store.ts（readJson / readJsonl / readdirCached / readIndexForQuery 四读口内计时埋点；锁内裸读路径未动）
- packages/studio-shared/package.json（exports 增 ./read-metrics 子路径）
- apps/api/bench/synthesize-dataset.ts（新增：数据合成器，只读 ~/.studio → tmp 合成 1x/10x/50x）
- apps/api/bench/loop-read-worker.ts（新增：单档循环驱动 worker；#363：驱动前跑 sweepEmptyAgentDirs 模拟启动清扫）
- apps/api/bench/loop-read-metrics.ts（新增：bench 入口，合成 → 子进程驱动 → 聚合出报告）
- apps/api/bench/read-metrics-aggregate.ts（新增：轮次聚合 + markdown 渲染纯函数）
- apps/api/bench/__tests__/（新增：上述模块的单测）
- apps/api/vitest.config.ts（include 增 bench/**/__tests__/**/*.test.ts）
