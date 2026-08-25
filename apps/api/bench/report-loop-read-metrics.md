# 周期循环读口量化测量报告（#323 阶段一）

- 生成时间：2026-08-25T07:02:04.775Z
- 口径：每循环每档 21 轮，首轮冷缓存单列，暖轮（≥2）聚合；耗时单位 ms
- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测、KnowledgeStore 扫描等）
- 并发口径注意：agent-timeout 的 listStates 对每目录并发 readJson（Promise.all），单事件 stat 延迟含事件循环排队，
  逐事件合计 ≫ 轮 wall（50x 档合计 34.8s vs wall 1.8s）——该循环以 wall 为准，「读口合计」列仅反映排队深度，残差按 0 截断
- 1x 模板 = 真实 ~/.studio 快照（2026-08-25）：45 WU（全 closed/done/pending，安静稳态）+ 注入 10 条近 24h 子执行
  （驱动 auditor 全路径）；agents/ 746 目录中仅 7 个有 state.json（真实如此）；状态分布保持模板原样，
  各扫描循环无补救写洪峰，测的是稳态轮
- ops-round 全程零 FileStore 读口（getStatus 走 statfs//proc/HTTP 探活），wall 即纯系统探测开销

## 数据集画像

| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |
|---|---|---|---|---|
| 1x | 55 | 1150 | 746 | 7 |
| 10x | 460 | 11122 | 7460 | 70 |
| 50x | 2260 | 55442 | 37300 | 350 |

## 总览（暖轮 P50；wall 含 P95）

| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |
|---|---|---|---|---|---|---|---|
| agent-timeout | 1x | 747 | 10475 | 15311 | 27.3 | 36.5 | 0% |
| agent-timeout | 10x | 7461 | 2413829 | 2852686 | 574 | 712 | 0% |
| agent-timeout | 50x | 37301 | 34836330 | 51182739 | 1786 | 2636 | 0% |
| auditor-round | 1x | 11 | 11.1 | 14.3 | 161 | 175 | 93% |
| auditor-round | 10x | 11 | 71.5 | 92.2 | 257 | 303 | 72% |
| auditor-round | 50x | 11 | 741 | 986 | 1060 | 1345 | 30% |
| dispatch-reconciliation | 1x | 3 | 0.72 | 0.91 | 0.81 | 1.1 | 11% |
| dispatch-reconciliation | 10x | 3 | 8.6 | 13.1 | 9.2 | 15.7 | 6% |
| dispatch-reconciliation | 50x | 3 | 42.1 | 54.3 | 43.5 | 56.0 | 3% |
| evolution-scan | 1x | 2 | 1.7 | 2.5 | 1.8 | 2.6 | 5% |
| evolution-scan | 10x | 2 | 17.9 | 19.5 | 18.7 | 20.4 | 4% |
| evolution-scan | 50x | 2 | 196 | 467 | 206 | 483 | 5% |
| monitor-round | 1x | 8 | 6.5 | 19.7 | 584 | 615 | 99% |
| monitor-round | 10x | 8 | 93.1 | 556 | 1072 | 2696 | 91% |
| monitor-round | 50x | 8 | 547 | 801 | 1643 | 2041 | 67% |
| ops-round | 1x | 0 | 0.00 | 0.00 | 42.8 | 47.4 | 100% |
| ops-round | 10x | 0 | 0.00 | 0.00 | 64.7 | 84.2 | 100% |
| ops-round | 50x | 0 | 0.00 | 0.00 | 137 | 213 | 100% |
| workunit-input-reminder | 1x | 1 | 0.27 | 0.35 | 0.31 | 0.39 | 13% |
| workunit-input-reminder | 10x | 1 | 2.3 | 4.3 | 2.4 | 4.4 | 3% |
| workunit-input-reminder | 50x | 1 | 14.2 | 38.8 | 14.6 | 39.6 | 3% |
| wu-timeout | 1x | 1 | 0.25 | 0.28 | 0.30 | 0.38 | 16% |
| wu-timeout | 10x | 1 | 2.6 | 12.2 | 2.8 | 15.3 | 9% |
| wu-timeout | 50x | 1 | 9.1 | 9.6 | 9.3 | 9.8 | 2% |

## 冷轮（首轮，缓存全冷）

| 循环 | 档位 | 读次数 | 读口合计 | wall |
|---|---|---|---|---|
| agent-timeout | 1x | 747 | 21366 | 63.8 |
| agent-timeout | 10x | 7461 | 2099857 | 589 |
| agent-timeout | 50x | 37301 | 34538314 | 1826 |
| auditor-round | 1x | 11 | 8.9 | 197 |
| auditor-round | 10x | 11 | 135 | 423 |
| auditor-round | 50x | 11 | 1062 | 1613 |
| dispatch-reconciliation | 1x | 3 | 1.0 | 2.3 |
| dispatch-reconciliation | 10x | 3 | 7.4 | 9.1 |
| dispatch-reconciliation | 50x | 3 | 42.3 | 45.5 |
| evolution-scan | 1x | 2 | 4.9 | 5.5 |
| evolution-scan | 10x | 2 | 23.2 | 26.1 |
| evolution-scan | 50x | 2 | 364 | 379 |
| monitor-round | 1x | 8 | 6.4 | 655 |
| monitor-round | 10x | 8 | 128 | 1591 |
| monitor-round | 50x | 8 | 499 | 2060 |
| ops-round | 1x | 0 | 0.00 | 52.9 |
| ops-round | 10x | 0 | 0.00 | 101 |
| ops-round | 50x | 0 | 0.00 | 183 |
| workunit-input-reminder | 1x | 1 | 0.34 | 0.71 |
| workunit-input-reminder | 10x | 1 | 8.2 | 8.7 |
| workunit-input-reminder | 50x | 1 | 90.0 | 90.7 |
| wu-timeout | 1x | 1 | 5.5 | 6.6 |
| wu-timeout | 10x | 1 | 42.2 | 49.3 |
| wu-timeout | 50x | 1 | 48.8 | 50.5 |

## 分桶明细（暖轮，按存储源）

### agent-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | agent-state | 746.0 | 1% | 13.4/21.0 | 0.00/0.00 | 0.00/0.00 |
| 1x | agents-dir | 1.0 | 100% | 0.04/0.07 | 0.00/0.00 | 0.00/0.00 |
| 10x | agent-state | 7460.0 | 1% | 317/444 | 0.00/0.00 | 0.00/0.00 |
| 10x | agents-dir | 1.0 | 100% | 0.08/0.64 | 0.00/0.00 | 0.00/0.00 |
| 50x | agent-state | 37300.0 | 1% | 934/1476 | 0.00/0.00 | 0.00/0.00 |
| 50x | agents-dir | 1.0 | 100% | 0.07/3.3 | 0.00/0.00 | 0.00/0.00 |

### auditor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 8.0 | 75% | 0.09/1.5 | 0.00/0.10 | 0.01/0.02 |
| 1x | studio-events | 2.0 | 50% | 0.05/1.6 | 0.00/2.7 | 1.6/2.2 |
| 1x | wu-index | 1.0 | 100% | 0.10/0.16 | 0.00/0.00 | 0.23/0.30 |
| 10x | channels | 8.0 | 75% | 0.09/0.65 | 0.00/0.17 | 0.01/0.03 |
| 10x | studio-events | 2.0 | 50% | 0.08/0.24 | 0.00/36.4 | 19.3/26.9 |
| 10x | wu-index | 1.0 | 100% | 0.11/8.4 | 0.00/0.00 | 1.8/2.8 |
| 50x | channels | 8.0 | 75% | 0.11/4.5 | 0.00/0.78 | 0.01/0.04 |
| 50x | studio-events | 2.0 | 50% | 0.08/3.8 | 0.00/451 | 188/251 |
| 50x | wu-index | 1.0 | 100% | 0.30/8.3 | 0.00/0.00 | 24.9/36.6 |

### dispatch-reconciliation

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 3.0 | 100% | 0.05/0.06 | 0.00/0.00 | 0.19/0.26 |
| 10x | wu-index | 3.0 | 100% | 0.10/2.6 | 0.00/0.00 | 2.3/4.9 |
| 50x | wu-index | 3.0 | 100% | 0.11/0.89 | 0.00/0.00 | 13.0/21.5 |

### evolution-scan

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | other | 1.0 | 0% | 0.08/0.82 | 0.00/0.00 | 0.00/0.00 |
| 1x | studio-events | 1.0 | 95% | 0.04/0.07 | 0.00/0.00 | 1.6/1.6 |
| 10x | other | 1.0 | 0% | 0.11/0.65 | 0.00/0.00 | 0.00/0.00 |
| 10x | studio-events | 1.0 | 95% | 0.05/0.07 | 0.00/0.00 | 17.5/19.3 |
| 50x | other | 1.0 | 0% | 0.19/34.1 | 0.00/0.00 | 0.00/0.00 |
| 50x | studio-events | 1.0 | 95% | 0.06/6.9 | 0.00/0.00 | 196/326 |

### monitor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 1.0 | 0% | 0.10/1.5 | 2.6/7.5 | 1.6/2.1 |
| 1x | wu-index | 7.0 | 100% | 0.05/1.5 | 0.00/0.00 | 0.19/0.31 |
| 10x | studio-events | 1.0 | 0% | 3.9/17.9 | 39.8/259 | 23.1/78.1 |
| 10x | wu-index | 7.0 | 100% | 0.10/6.5 | 0.00/0.00 | 2.4/9.4 |
| 50x | studio-events | 1.0 | 0% | 0.12/3.2 | 231/316 | 185/236 |
| 50x | wu-index | 7.0 | 100% | 0.12/5.6 | 0.00/0.00 | 14.6/34.1 |

### ops-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### workunit-input-reminder

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.05/0.07 | 0.00/0.00 | 0.22/0.27 |
| 10x | wu-index | 1.0 | 100% | 0.09/2.0 | 0.00/0.00 | 2.2/2.6 |
| 50x | wu-index | 1.0 | 100% | 0.10/3.5 | 0.00/0.00 | 13.2/31.1 |

### wu-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.06/0.08 | 0.00/0.00 | 0.19/0.21 |
| 10x | wu-index | 1.0 | 100% | 0.13/4.9 | 0.00/0.00 | 2.4/7.4 |
| 50x | wu-index | 1.0 | 100% | 0.11/0.13 | 0.00/0.00 | 9.0/9.5 |

## 驱动缺口

- monitor 日级子项（dailyReflection / dataLifecycle TTL / knowledge decay / user-model 更新）：预置状态跳过——这些是 1/288 的低频轮，不属于常态 5 分钟轮
- ops-round 的 apiResponding=false 分支（自动重启/退出）与 preflight：不属于周期健康轮，未测
- auditor 的失败执行分支（eval case 生成 / auto resolution / Triage 升级 / 确认卡片）：合成数据全成功执行，未触发；触发型读口未计入
- Triage 升级被记录桩替换（安全闸：升级路径会拉 systemExecutor 跑 LLM 诊断，bench 不可触碰）；触发次数见 worker 输出 triageStubCalls

## 建/不建快照层建议

**结论：不建快照层。** 现状与可预见规模内，读口成本全部处于无感量级；50x 档暴露的大头是访问模式问题（全量读日志文件），快照层不是正确修法。

**数据依据**

1. **hit 路径主税 = structuredClone，随条数线性**。wu-index（命中率 100%）单次 clone P50：1x 0.2ms → 10x 2.3ms → 50x 13–25ms。
   读口最密的 monitor 每轮 7 次 getIndex：50x 档 clone 合计 ≈100–170ms/轮，相对 5min 周期占比 0.05%。
   按线性外推，要到 ~10 万条 WU（≈2000x）单轮 clone 合计才达到周期的 1%（3s）。
2. **studio-events 是唯一随规模显著变痛的读口**，但痛在「每轮全量 parse 整个日志文件」：
   miss 一次 parse+clone P50：1x ≈4ms → 10x ≈63ms → 50x ≈420ms（15MB / 5.5 万行）。
   monitor 每轮必 miss（自己写 trajectory 事件把缓存失效掉），auditor 每轮 2 读、evolution-scan 1 读（95% hit 但 clone 仍 196ms@50x）。
   正确修法是**读取窗口化/增量读/落盘前过滤**（#173 轮转已有雏形），或 monitor 事件另走小文件——快照层（再缓存一份）不解决全量 parse 本身。
3. **agent-timeout 的 wall 随 agents 目录数线性**（27ms@746 → 574ms@7460 → 1786ms@37300），
   但 99% 是对不存在 state.json 的目录做 stat（ENOENT 不进缓存，每轮重扫）——这是目录治理问题
   （死实例目录不清理），不是读口缓存问题；746 目录的现状下 wall 仅 27ms。
4. **ops-round 零 FileStore 读口**；auditor/monitor 轮 wall 的 67–99% 残差是 KnowledgeStore
   （FileKnowledgeStore 自读 15MB knowledge 目录，不走四个读口）——若后续要优化轮 wall，
   先看 knowledge 读路径，与 FileStore 快照层无关。

**拐点判断（何时值得建）**

- wu-index：单轮 clone 合计 ≈0.07ms × (WU 条数/1000) × 每轮 getIndex 次数。达到 5min 周期的 1%（3s）约需 **~10 万条 WU（≈2000x 现状）**——远未到。
- studio-events：单轮 parse+clone 合计 ≈28ms × 文件 MB 数 × 每轮读次数。达到周期 1% 约需 **~35MB（≈120x 现状）**；
  若 events 持续增长，**~10MB（≈35x）时建议先做读取窗口化**（仍不是快照层）。
- 综合：**任何 ≤50x 的规模都不建快照层**。阶段一数据支持的行动项只有一个：events 文件的窗口化/增量读（另行立项评估）。

**遗留观测**：auditor 每轮 pushConfirmationCards（合成数据下 circuit health 每轮产出 1 条 high-risk 建议 → 频道写 + knowledge 写），
属业务行为非读口问题，未纳入本报告口径。
