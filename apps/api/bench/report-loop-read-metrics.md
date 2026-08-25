# 周期循环读口量化测量报告（#323 阶段一）

- 生成时间：2026-08-25T07:31:31.888Z
- 口径：每循环每档 21 轮，首轮冷缓存单列，暖轮（≥2）聚合；monitor 日级窗口补测每档 3 轮（仅 1x/50x，窗口条件强制开启）；耗时单位 ms
- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测、KnowledgeStore 目录自读等）
- 并发口径注意：agent-timeout 的 listStates 对每目录并发 readJson（Promise.all），单事件 stat 延迟含事件循环排队，
  逐事件合计 ≫ 轮 wall（50x 档合计 30s vs wall 1.5s）——该循环以 wall 为准，「读口合计」列仅反映排队深度，残差按 0 截断
- 1x 模板 = 真实 ~/.studio 快照（2026-08-25）：45 WU（全 closed/done/pending，安静稳态）+ 注入 10 条近 24h 子执行
  （驱动 auditor 全路径）；agents/ 746 目录中仅 7 个有 state.json（真实如此）；状态分布保持模板原样，
  各扫描循环无补救写洪峰，测的是稳态轮
- ops-round 全程零 FileStore 读口（getStatus 走 statfs//proc/HTTP 探活），wall 即纯系统探测开销

## 数据集画像

| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |
|---|---|---|---|---|
| 1x | 55 | 725 | 746 | 7 |
| 10x | 460 | 11122 | 7460 | 70 |
| 50x | 2260 | 34044 | 37300 | 350 |

## 总览（暖轮 P50；wall 含 P95）

| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |
|---|---|---|---|---|---|---|---|
| agent-timeout | 1x | 747 | 9376 | 12779 | 24.9 | 32.2 | 0% |
| agent-timeout | 10x | 7461 | 1120775 | 1334669 | 287 | 320 | 0% |
| agent-timeout | 50x | 37301 | 30031632 | 33750232 | 1510 | 1682 | 0% |
| auditor-round | 1x | 11 | 11.0 | 16.0 | 160 | 173 | 93% |
| auditor-round | 10x | 11 | 62.2 | 69.6 | 216 | 245 | 71% |
| auditor-round | 50x | 11 | 375 | 426 | 553 | 600 | 32% |
| dispatch-reconciliation | 1x | 3 | 0.70 | 0.94 | 0.79 | 1.0 | 11% |
| dispatch-reconciliation | 10x | 3 | 4.6 | 5.3 | 4.7 | 5.5 | 4% |
| dispatch-reconciliation | 50x | 3 | 27.2 | 30.5 | 28.0 | 31.3 | 3% |
| evolution-scan | 1x | 2 | 1.7 | 2.9 | 1.8 | 3.0 | 5% |
| evolution-scan | 10x | 2 | 17.7 | 32.4 | 18.4 | 33.5 | 4% |
| evolution-scan | 50x | 2 | 102 | 157 | 109 | 173 | 7% |
| monitor-daily-reflection | 1x | 7 | 13.6 | 16.8 | 423 | 437 | 97% |
| monitor-daily-reflection | 50x | 7 | 448 | 480 | 928 | 933 | 52% |
| monitor-data-lifecycle | 1x | 3 | 6.0 | 6.5 | 11.7 | 12.9 | 49% |
| monitor-data-lifecycle | 50x | 3 | 360 | 384 | 631 | 656 | 43% |
| monitor-knowledge-decay | 1x | 0 | 0.00 | 0.00 | 1087 | 1217 | 100% |
| monitor-knowledge-decay | 50x | 0 | 0.00 | 0.00 | 1213 | 1259 | 100% |
| monitor-round | 1x | 8 | 6.3 | 19.4 | 591 | 663 | 99% |
| monitor-round | 10x | 8 | 57.3 | 74.7 | 650 | 708 | 91% |
| monitor-round | 50x | 8 | 328 | 380 | 969 | 1062 | 66% |
| ops-round | 1x | 0 | 0.00 | 0.00 | 42.4 | 44.2 | 100% |
| ops-round | 10x | 0 | 0.00 | 0.00 | 45.6 | 54.8 | 100% |
| ops-round | 50x | 0 | 0.00 | 0.00 | 56.1 | 101 | 100% |
| workunit-input-reminder | 1x | 1 | 0.23 | 0.25 | 0.26 | 0.31 | 11% |
| workunit-input-reminder | 10x | 1 | 1.6 | 6.3 | 1.7 | 6.4 | 7% |
| workunit-input-reminder | 50x | 1 | 10.6 | 22.2 | 10.8 | 22.7 | 2% |
| wu-timeout | 1x | 1 | 0.32 | 3.5 | 0.38 | 3.6 | 15% |
| wu-timeout | 10x | 1 | 1.8 | 5.0 | 2.0 | 5.2 | 6% |
| wu-timeout | 50x | 1 | 9.0 | 14.3 | 9.2 | 14.6 | 2% |

## 冷轮（首轮，缓存全冷）

| 循环 | 档位 | 读次数 | 读口合计 | wall |
|---|---|---|---|---|
| agent-timeout | 1x | 747 | 17343 | 48.0 |
| agent-timeout | 10x | 7461 | 1356641 | 367 |
| agent-timeout | 50x | 37301 | 31917565 | 1732 |
| auditor-round | 1x | 11 | 14.0 | 188 |
| auditor-round | 10x | 11 | 63.5 | 237 |
| auditor-round | 50x | 11 | 415 | 631 |
| dispatch-reconciliation | 1x | 3 | 0.74 | 1.6 |
| dispatch-reconciliation | 10x | 3 | 4.8 | 6.2 |
| dispatch-reconciliation | 50x | 3 | 27.6 | 30.0 |
| evolution-scan | 1x | 2 | 3.2 | 3.8 |
| evolution-scan | 10x | 2 | 22.0 | 24.7 |
| evolution-scan | 50x | 2 | 104 | 113 |
| monitor-daily-reflection | 1x | 7 | 5.5 | 430 |
| monitor-daily-reflection | 50x | 7 | 422 | 916 |
| monitor-data-lifecycle | 1x | 3 | 5.3 | 22.4 |
| monitor-data-lifecycle | 50x | 3 | 267 | 912 |
| monitor-knowledge-decay | 1x | 0 | 0.00 | 1091 |
| monitor-knowledge-decay | 50x | 0 | 0.00 | 1175 |
| monitor-round | 1x | 8 | 7.7 | 687 |
| monitor-round | 10x | 8 | 58.7 | 723 |
| monitor-round | 50x | 8 | 341 | 1186 |
| ops-round | 1x | 0 | 0.00 | 56.1 |
| ops-round | 10x | 0 | 0.00 | 57.5 |
| ops-round | 50x | 0 | 0.00 | 74.7 |
| workunit-input-reminder | 1x | 1 | 0.26 | 0.73 |
| workunit-input-reminder | 10x | 1 | 4.6 | 5.1 |
| workunit-input-reminder | 50x | 1 | 16.9 | 17.7 |
| wu-timeout | 1x | 1 | 3.9 | 4.8 |
| wu-timeout | 10x | 1 | 11.2 | 12.4 |
| wu-timeout | 50x | 1 | 49.0 | 50.7 |

## 分桶明细（暖轮，按存储源）

### agent-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | agent-state | 746.0 | 1% | 12.6/18.6 | 0.00/0.00 | 0.00/0.00 |
| 1x | agents-dir | 1.0 | 100% | 0.04/0.09 | 0.00/0.00 | 0.00/0.00 |
| 10x | agent-state | 7460.0 | 1% | 153/186 | 0.00/0.00 | 0.00/0.00 |
| 10x | agents-dir | 1.0 | 100% | 0.08/2.0 | 0.00/0.00 | 0.00/0.00 |
| 50x | agent-state | 37300.0 | 1% | 810/937 | 0.00/0.00 | 0.00/0.00 |
| 50x | agents-dir | 1.0 | 100% | 0.07/0.16 | 0.00/0.00 | 0.00/0.00 |

### auditor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 8.0 | 75% | 0.08/1.6 | 0.00/0.10 | 0.01/0.02 |
| 1x | studio-events | 2.0 | 50% | 0.06/0.24 | 0.00/3.6 | 1.6/2.2 |
| 1x | wu-index | 1.0 | 100% | 0.10/0.12 | 0.00/0.00 | 0.23/0.27 |
| 10x | channels | 8.0 | 75% | 0.08/1.6 | 0.00/0.12 | 0.01/0.02 |
| 10x | studio-events | 2.0 | 50% | 0.06/0.22 | 0.00/25.4 | 16.7/21.1 |
| 10x | wu-index | 1.0 | 100% | 0.10/0.12 | 0.00/0.00 | 1.7/2.4 |
| 50x | channels | 8.0 | 75% | 0.09/1.7 | 0.00/0.18 | 0.01/0.04 |
| 50x | studio-events | 2.0 | 50% | 0.06/0.28 | 0.00/188 | 104/117 |
| 50x | wu-index | 1.0 | 100% | 0.11/0.16 | 0.00/0.00 | 12.5/20.4 |

### dispatch-reconciliation

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 3.0 | 100% | 0.04/0.06 | 0.00/0.00 | 0.18/0.28 |
| 10x | wu-index | 3.0 | 100% | 0.06/0.51 | 0.00/0.00 | 1.5/1.6 |
| 50x | wu-index | 3.0 | 100% | 0.10/0.12 | 0.00/0.00 | 9.4/10.8 |

### evolution-scan

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | other | 1.0 | 0% | 0.07/1.2 | 0.00/0.00 | 0.00/0.00 |
| 1x | studio-events | 1.0 | 95% | 0.04/0.06 | 0.00/0.00 | 1.6/2.0 |
| 10x | other | 1.0 | 0% | 0.14/2.8 | 0.00/0.00 | 0.00/0.00 |
| 10x | studio-events | 1.0 | 95% | 0.05/0.70 | 0.00/0.00 | 17.2/24.1 |
| 50x | other | 1.0 | 0% | 0.17/5.5 | 0.00/0.00 | 0.00/0.00 |
| 50x | studio-events | 1.0 | 95% | 0.05/1.4 | 0.00/0.00 | 102/146 |

### monitor-daily-reflection

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 4.0 | 75% | 0.11/1.2 | 0.00/2.2 | 0.01/0.03 |
| 1x | studio-events | 3.0 | 67% | 0.16/0.64 | 0.00/6.4 | 1.8/2.5 |
| 50x | channels | 4.0 | 75% | 0.08/0.11 | 0.00/0.10 | 0.01/0.04 |
| 50x | studio-events | 3.0 | 67% | 0.19/6.8 | 0.00/174 | 93.4/111 |

### monitor-data-lifecycle

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 2.0 | 0% | 0.04/0.06 | 1.8/2.0 | 1.0/1.1 |
| 1x | wu-index | 1.0 | 100% | 0.05/0.06 | 0.00/0.00 | 0.21/0.29 |
| 50x | studio-events | 2.0 | 0% | 0.10/1.4 | 84.3/152 | 65.1/68.5 |
| 50x | wu-index | 1.0 | 100% | 0.05/0.08 | 0.00/0.00 | 9.5/12.3 |

### monitor-knowledge-decay

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### monitor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 1.0 | 0% | 0.10/1.9 | 2.6/13.5 | 1.6/2.3 |
| 1x | wu-index | 7.0 | 100% | 0.05/0.48 | 0.00/0.00 | 0.19/0.26 |
| 10x | studio-events | 1.0 | 0% | 1.9/2.7 | 22.9/41.2 | 16.4/18.3 |
| 10x | wu-index | 7.0 | 100% | 0.07/2.9 | 0.00/0.00 | 1.6/2.4 |
| 50x | studio-events | 1.0 | 0% | 0.10/0.17 | 158/200 | 106/113 |
| 50x | wu-index | 7.0 | 100% | 0.10/0.19 | 0.00/0.00 | 9.3/11.2 |

### ops-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### workunit-input-reminder

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.05/0.06 | 0.00/0.00 | 0.18/0.20 |
| 10x | wu-index | 1.0 | 100% | 0.07/3.1 | 0.00/0.00 | 1.5/3.1 |
| 50x | wu-index | 1.0 | 100% | 0.10/2.0 | 0.00/0.00 | 10.6/20.2 |

### wu-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.08/3.2 | 0.00/0.00 | 0.23/0.30 |
| 10x | wu-index | 1.0 | 100% | 0.05/2.7 | 0.00/0.00 | 1.8/2.7 |
| 50x | wu-index | 1.0 | 100% | 0.11/0.89 | 0.00/0.00 | 8.9/12.1 |

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

## 建/不建快照层建议

**结论：不建快照层。** 现状与可预见规模内，读口成本全部处于无感量级；50x 档暴露的大头是访问模式问题（全量读日志文件），快照层不是正确修法。

**口径说明**：本报告「归约残差」= 轮 wall − 四个 FileStore 读口耗时合计，其中**包含 KnowledgeStore（FileKnowledgeStore）目录自读、裸 fs 读写（dataLifecycle 截断写、probe 文件）、execSync 系统探测、HTTP 探活等不走四读口的部分**——monitor/auditor 的残差（1x 档 93–99%、50x 档 32–66%）大部分来自 KnowledgeStore 扫描，无法按现有埋点全归因，解读 wall 时勿把残差当作「FileStore 隐藏成本」。

**数据依据**

1. **hit 路径主税 = structuredClone，随条数线性**。wu-index（命中率 100%）单次 clone P50：1x 0.2ms → 10x 1.7ms → 50x 9–12.5ms。
   读口最密的 monitor 每轮 7 次 getIndex：50x 档 clone 合计 ≈65–90ms/轮，相对 5min 周期占比 ≈0.03%。
   按线性外推，要到 ~10 万条 WU（≈2000x）单轮 clone 合计才达到周期的 1%（3s）。
2. **studio-events 是唯一随规模显著变痛的读口**，但痛在「每轮全量 parse 整个日志文件」：
   miss 一次 parse+clone P50：1x ≈4ms → 10x ≈39ms → 50x ≈264ms（~9.4MB / 3.4 万行）。
   monitor 每轮必 miss（自己写 trajectory 事件把缓存失效掉），auditor 每轮 2 读、evolution-scan 1 读（95% hit 但 clone 仍 102ms@50x）。
   正确修法是**读取窗口化/增量读/落盘前过滤**（#173 轮转已有雏形），或 monitor 事件另走小文件——快照层（再缓存一份）不解决全量 parse 本身。
3. **agent-timeout 的 wall 随 agents 目录数线性**（25ms@746 → 287ms@7460 → 1510ms@37300），
   但 99% 是对不存在 state.json 的目录做 stat（ENOENT 不进缓存，每轮重扫）——这是目录治理问题
   （死实例目录不清理），不是读口缓存问题；746 目录的现状下 wall 仅 25ms。
4. **ops-round 零 FileStore 读口**；monitor/auditor/daily-reflection/knowledge-decay 轮 wall 的大头是 KnowledgeStore
   （FileKnowledgeStore 自读 15MB knowledge 目录，不走四个读口）——knowledge-decay 一轮 ~1.1–1.2s 且 FileStore 读口为零，
   日级 daily-reflection 残差 97%@1x。若后续要优化轮 wall，先看 knowledge 读路径，与 FileStore 快照层无关。

**Monitor 日级窗口补测（1x/50x，3 轮，窗口强制开启）**

| 循环 | 档 | 读次数/轮 | 读口合计 P50 | wall P50 | 说明 |
|---|---|---|---|---|---|
| monitor-daily-reflection | 1x | 7 | 13.6 | 423 | 残差 97%：KnowledgeAudit/FileKnowledgeStore 自读 + git log |
| monitor-daily-reflection | 50x | 7 | 448 | 928 | 3 次 studio-events 读（67% hit）+ 4 次 channels 读 |
| monitor-data-lifecycle | 1x | 3 | 6.0 | 11.7 | 2 次 events 读 + 1 次 getIndex；截断写为裸 fs 不计入读口 |
| monitor-data-lifecycle | 50x | 3 | 360 | 631 | 冷轮含 30d 沉淀标记 + 7d 截断（912ms） |
| monitor-knowledge-decay | 1x/50x | 0 | 0 | 1087/1213 | 零 FileStore 读口，全部为 KnowledgeStore decay+linter |

日级轮一天一次，50x 档最贵 ~1.2s——相对 24h 周期占比 0.001%，同样不需要快照层。

**拐点判断（何时值得建）**

- wu-index：单轮 clone 合计达到 5min 周期的 1%（3s）约需 **~10 万条 WU（≈2000x 现状）**——远未到。
- studio-events：parse+clone ≈28ms/MB × 每轮 ~3.5 次有效读，达到周期 1% 约需 **~30MB（≈100x 现状）**；
  若 events 持续增长，**~10MB（≈35x）时建议先做读取窗口化**（仍不是快照层）。
- 综合：**任何 ≤50x 的规模都不建快照层**。阶段一数据支持的行动项只有一个：events 文件的窗口化/增量读（另行立项评估）。

**遗留观测**：auditor 每轮 pushConfirmationCards（合成数据下 circuit health 每轮产出 1 条 high-risk 建议 → 频道写 + knowledge 写），
属业务行为非读口问题，未纳入本报告口径。
