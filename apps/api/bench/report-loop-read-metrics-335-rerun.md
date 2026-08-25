# 周期循环读口量化测量报告（#335 复测：读取窗口化落地后）

- 生成时间：2026-08-25T09:07:11.701Z
- 口径：每循环每档 21 轮，首轮冷缓存单列，暖轮（≥2）聚合；耗时单位 ms
- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测等）

## 数据集画像

| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |
|---|---|---|---|---|
| 1x | 55 | 724 | 746 | 7 |
| 10x | 460 | 11122 | 7460 | 70 |
| 50x | 2260 | 4548 | 37300 | 350 |

## 总览（暖轮 P50；wall 含 P95）

| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |
|---|---|---|---|---|---|---|---|
| agent-timeout | 1x | 747 | 9144 | 12279 | 24.5 | 31.8 | 0% |
| agent-timeout | 10x | 7461 | 1163592 | 1618525 | 292 | 357 | 0% |
| agent-timeout | 50x | 37301 | 29074791 | 31071718 | 1486 | 1581 | 0% |
| auditor-round | 1x | 9 | 5.1 | 6.9 | 158 | 184 | 97% |
| auditor-round | 10x | 9 | 6.5 | 7.9 | 207 | 231 | 97% |
| auditor-round | 50x | 9 | 18.0 | 36.0 | 598 | 769 | 97% |
| dispatch-reconciliation | 1x | 3 | 0.70 | 0.76 | 0.79 | 0.91 | 10% |
| dispatch-reconciliation | 10x | 3 | 4.6 | 5.1 | 4.7 | 5.3 | 4% |
| dispatch-reconciliation | 50x | 3 | 28.7 | 35.6 | 29.5 | 36.6 | 3% |
| evolution-scan | 1x | 1 | 0.06 | 0.08 | 0.72 | 0.78 | 91% |
| evolution-scan | 10x | 1 | 0.07 | 0.08 | 0.72 | 1.00 | 91% |
| evolution-scan | 50x | 1 | 0.08 | 0.16 | 1.0 | 2.4 | 92% |
| monitor-daily-reflection | 1x | 4 | 0.46 | 0.54 | 410 | 413 | 100% |
| monitor-daily-reflection | 50x | 4 | 0.61 | 1.6 | 667 | 699 | 100% |
| monitor-data-lifecycle | 1x | 3 | 6.3 | 6.3 | 12.7 | 13.3 | 51% |
| monitor-data-lifecycle | 50x | 3 | 68.2 | 69.3 | 114 | 145 | 40% |
| monitor-knowledge-decay | 1x | 0 | 0.00 | 0.00 | 1072 | 1109 | 100% |
| monitor-knowledge-decay | 50x | 0 | 0.00 | 0.00 | 1536 | 1610 | 100% |
| monitor-round | 1x | 7 | 1.7 | 8.0 | 580 | 599 | 100% |
| monitor-round | 10x | 7 | 12.5 | 18.1 | 599 | 651 | 98% |
| monitor-round | 50x | 7 | 65.1 | 113 | 700 | 1060 | 91% |
| ops-round | 1x | 0 | 0.00 | 0.00 | 42.5 | 44.2 | 100% |
| ops-round | 10x | 0 | 0.00 | 0.00 | 42.9 | 45.5 | 100% |
| ops-round | 50x | 0 | 0.00 | 0.00 | 87.8 | 169 | 100% |
| workunit-input-reminder | 1x | 1 | 0.23 | 0.25 | 0.25 | 0.33 | 8% |
| workunit-input-reminder | 10x | 1 | 1.5 | 2.8 | 1.6 | 2.8 | 3% |
| workunit-input-reminder | 50x | 1 | 10.4 | 20.0 | 10.8 | 21.2 | 3% |
| wu-timeout | 1x | 1 | 0.24 | 0.52 | 0.32 | 0.62 | 23% |
| wu-timeout | 10x | 1 | 2.1 | 5.4 | 2.2 | 5.6 | 3% |
| wu-timeout | 50x | 1 | 9.3 | 13.1 | 9.5 | 13.5 | 2% |

## 冷轮（首轮，缓存全冷）

| 循环 | 档位 | 读次数 | 读口合计 | wall |
|---|---|---|---|---|
| agent-timeout | 1x | 747 | 15419 | 42.2 |
| agent-timeout | 10x | 7461 | 1323743 | 357 |
| agent-timeout | 50x | 37301 | 31312375 | 1708 |
| auditor-round | 1x | 9 | 4.4 | 212 |
| auditor-round | 10x | 9 | 15.9 | 255 |
| auditor-round | 50x | 9 | 40.9 | 1008 |
| dispatch-reconciliation | 1x | 3 | 0.75 | 1.6 |
| dispatch-reconciliation | 10x | 3 | 5.1 | 6.4 |
| dispatch-reconciliation | 50x | 3 | 25.8 | 28.1 |
| evolution-scan | 1x | 1 | 0.16 | 5.9 |
| evolution-scan | 10x | 1 | 0.17 | 5.3 |
| evolution-scan | 50x | 1 | 4.4 | 10.6 |
| monitor-daily-reflection | 1x | 4 | 0.42 | 425 |
| monitor-daily-reflection | 50x | 4 | 0.48 | 680 |
| monitor-data-lifecycle | 1x | 3 | 10.7 | 24.1 |
| monitor-data-lifecycle | 50x | 3 | 499 | 1197 |
| monitor-knowledge-decay | 1x | 0 | 0.00 | 1080 |
| monitor-knowledge-decay | 50x | 0 | 0.00 | 1554 |
| monitor-round | 1x | 7 | 2.2 | 712 |
| monitor-round | 10x | 7 | 11.1 | 671 |
| monitor-round | 50x | 7 | 64.3 | 855 |
| ops-round | 1x | 0 | 0.00 | 71.9 |
| ops-round | 10x | 0 | 0.00 | 57.6 |
| ops-round | 50x | 0 | 0.00 | 84.5 |
| workunit-input-reminder | 1x | 1 | 0.71 | 1.0 |
| workunit-input-reminder | 10x | 1 | 2.0 | 2.4 |
| workunit-input-reminder | 50x | 1 | 25.8 | 26.6 |
| wu-timeout | 1x | 1 | 13.2 | 14.3 |
| wu-timeout | 10x | 1 | 9.9 | 11.1 |
| wu-timeout | 50x | 1 | 51.7 | 53.4 |

## 分桶明细（暖轮，按存储源）

### agent-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | agent-state | 746.0 | 1% | 12.3/18.9 | 0.00/0.00 | 0.00/0.00 |
| 1x | agents-dir | 1.0 | 100% | 0.04/0.06 | 0.00/0.00 | 0.00/0.00 |
| 10x | agent-state | 7460.0 | 1% | 156/222 | 0.00/0.00 | 0.00/0.00 |
| 10x | agents-dir | 1.0 | 100% | 0.08/0.98 | 0.00/0.00 | 0.00/0.00 |
| 50x | agent-state | 37300.0 | 1% | 779/874 | 0.00/0.00 | 0.00/0.00 |
| 50x | agents-dir | 1.0 | 100% | 0.06/0.18 | 0.00/0.00 | 0.00/0.00 |

### auditor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 8.0 | 75% | 0.08/1.7 | 0.00/0.12 | 0.01/0.02 |
| 1x | wu-index | 1.0 | 100% | 0.09/0.13 | 0.00/0.00 | 0.23/0.33 |
| 10x | channels | 8.0 | 75% | 0.08/1.5 | 0.00/0.11 | 0.01/0.03 |
| 10x | wu-index | 1.0 | 100% | 0.09/2.2 | 0.00/0.00 | 1.9/2.8 |
| 50x | channels | 8.0 | 75% | 0.10/4.0 | 0.00/0.14 | 0.01/0.03 |
| 50x | wu-index | 1.0 | 100% | 0.31/6.4 | 0.00/0.00 | 11.8/22.9 |

### dispatch-reconciliation

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 3.0 | 100% | 0.05/0.07 | 0.00/0.00 | 0.18/0.20 |
| 10x | wu-index | 3.0 | 100% | 0.06/0.55 | 0.00/0.00 | 1.4/1.5 |
| 50x | wu-index | 3.0 | 100% | 0.10/0.15 | 0.00/0.00 | 9.4/13.8 |

### evolution-scan

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | other | 1.0 | 0% | 0.06/0.08 | 0.00/0.00 | 0.00/0.00 |
| 10x | other | 1.0 | 0% | 0.07/0.08 | 0.00/0.00 | 0.00/0.00 |
| 50x | other | 1.0 | 0% | 0.08/0.16 | 0.00/0.00 | 0.00/0.00 |

### monitor-daily-reflection

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 4.0 | 75% | 0.09/0.12 | 0.00/0.10 | 0.01/0.03 |
| 50x | channels | 4.0 | 75% | 0.11/0.14 | 0.00/1.1 | 0.01/0.06 |

### monitor-data-lifecycle

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 2.0 | 0% | 0.05/0.07 | 1.8/2.0 | 1.1/1.1 |
| 1x | wu-index | 1.0 | 100% | 0.04/0.07 | 0.00/0.00 | 0.21/0.29 |
| 50x | studio-events | 2.0 | 0% | 0.10/0.25 | 15.9/21.3 | 9.6/12.7 |
| 50x | wu-index | 1.0 | 100% | 0.06/1.8 | 0.00/0.00 | 10.3/11.8 |

### monitor-knowledge-decay

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### monitor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 7.0 | 100% | 0.05/0.59 | 0.00/0.00 | 0.20/0.33 |
| 10x | wu-index | 7.0 | 100% | 0.06/1.7 | 0.00/0.00 | 1.5/2.5 |
| 50x | wu-index | 7.0 | 100% | 0.09/2.0 | 0.00/0.00 | 9.7/17.3 |

### ops-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### workunit-input-reminder

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.05/0.06 | 0.00/0.00 | 0.18/0.20 |
| 10x | wu-index | 1.0 | 100% | 0.05/1.3 | 0.00/0.00 | 1.5/1.5 |
| 50x | wu-index | 1.0 | 100% | 0.09/5.1 | 0.00/0.00 | 10.4/18.5 |

### wu-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.05/0.21 | 0.00/0.00 | 0.19/0.33 |
| 10x | wu-index | 1.0 | 100% | 0.07/2.5 | 0.00/0.00 | 2.0/2.4 |
| 50x | wu-index | 1.0 | 100% | 0.11/0.62 | 0.00/0.00 | 9.1/13.0 |

## 驱动缺口

- monitor 日级窗口已补测（1x/50x 单列 monitor-daily-reflection / monitor-data-lifecycle / monitor-knowledge-decay，窗口条件强制开启）；user-model 更新（npx harness 子进程）不属于读口测量面，未测
- ops-round 的 apiResponding=false 分支（自动重启/退出）与 preflight：不属于周期健康轮，未测
- auditor 的失败执行分支（eval case 生成 / auto resolution / Triage 升级 / 确认卡片）：合成数据全成功执行，未触发；触发型读口未计入
- Triage 升级被记录桩替换（安全闸：升级路径会拉 systemExecutor 跑 LLM 诊断，bench 不可触碰）；触发次数见 worker 输出 triageStubCalls

## 测量代码清单

- packages/studio-shared/src/read-metrics.ts（新增：sink + ALS 归因 + readMetricsBegin/emitReadMetric）
- packages/studio-shared/src/file-store.ts（readJson / readJsonl / readdirCached / readIndexForQuery 四读口内计时埋点；锁内裸读路径未动）
- packages/studio-shared/package.json（exports 增 ./read-metrics 子路径）
- apps/api/bench/synthesize-dataset.ts（新增：数据合成器，只读 ~/.studio → tmp 合成 1x/10x/50x）
- apps/api/bench/loop-read-worker.ts（新增：单档循环驱动 worker）
- apps/api/bench/loop-read-metrics.ts（新增：bench 入口，合成 → 子进程驱动 → 聚合出报告）
- apps/api/bench/read-metrics-aggregate.ts（新增：轮次聚合 + markdown 渲染纯函数）
- apps/api/bench/__tests__/（新增：上述模块的单测）
- apps/api/vitest.config.ts（include 增 bench/**/__tests__/**/*.test.ts）

## 复测结论（#335，2026-08-25）

对照基线 = `report-loop-read-metrics.md`（#323 阶段一，窗口化落地前）。注意口径变化：
**窗口读口 `readStudioEventsSince` 走裸 fs 倒扫，不经 FileStore 四读口埋点**——studio-events
桶从分桶表消失不代表零成本，其耗时移入「残差」；真实收益见末节微基准。

| 循环 @50x（暖轮 P50） | 基线读口合计 | 复测读口合计 | 基线 wall | 复测 wall |
|---|---|---|---|---|
| monitor-round | 328ms | **65.1ms**（-80%，余量全为 wu-index clone） | 969ms | 700ms |
| auditor-round | 375ms | **18.0ms**（-95%） | 553ms | 598ms |
| evolution-scan | 102ms | **0.08ms**（≈0） | 109ms | 1.0ms |

monitor-round 读次数 8→7/轮：每轮那次必 miss 的 studio-events 全量读（基线 parse+clone P50
≈264ms）已从 FileStore 读口消失。auditor 的 2 次全量读同理消失（读次数 11→9）。

**微基准**（一次性脚本，真实模板 50x = 55400 行 / 14.8MB，10 次取 P50）：

| 读法 | P50 |
|---|---|
| `readStudioEvents` 全量（readJsonl hit 路径含 clone） | 105.6ms |
| `readStudioEventsSince` 1h 窗口（0 行） | 0.5ms |
| `readStudioEventsSince` 24h 窗口（30 行） | 0.5ms |
| `readStudioEventsSince` 7d 窗口（683 行） | 3.2ms |

窗口读口耗时随窗口内行数而非文件总量增长 → AC「parse 量与文件总量解耦」成立。
1h 窗口 0 行属正常（模板快照最新事件早于测量时刻 1h+）。

**数据集修复**：`synthesize-dataset.ts` 事件副本由整段复制改为按 `-k*12h` 偏移时间戳
（保全局单调）——原形态下窗口读口的早停前提不成立，且与生产 append-only 单调形态不符。
因此本表与基线的绝对值不完全同口径（数据集已变），趋势结论不受影响。

**口径修正（maintainer 已确认，2026-08-25）**：
- auditor-reports 的 24h 趋势原实现 `getStudioEventTime(row) < sinceMs` 过滤会把 NaT
  （无 createdAt/timestamp）行**保留**（NaN 比较恒 false，疑似意外）；窗口读口统一跳过
  NaT 行——口径修正为"非法时间行不进窗口"，与其他读方一致。
- wu-changed-files 原本无时间窗（全文件扫），默认读口加 30d 窗口对齐 #173 热保留期；
  轮转滞后时 30~31 天龄事件原可见、现不可见——语义与"归档后查不到即降级"一致。

**保持全量读（固有）**：monitor-lifecycle 的 precipitate / 7d 截断 / 30d 沉淀清理三处
重写整个文件，必须拿到窗口外行，不在窗口化范围。
