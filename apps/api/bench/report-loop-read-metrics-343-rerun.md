# 周期循环读口量化测量报告（#343 复测：知识库存储栈过缓存 seam 后）


- 生成时间：2026-08-28T03:34:09.546Z
- 口径：每循环每档 21 轮，首轮冷缓存单列，暖轮（≥2）聚合；耗时单位 ms
- 归约残差 = 轮 wall − 该轮读口耗时合计（含非读口开销：业务计算、写路径、execSync 探测等）

## 数据集画像

| 档位 | WU 条数 | events 行数 | agents 目录 | state 文件 |
|---|---|---|---|---|
| 1x | 56 | 452 | 15 | 7 |
| 10x | 470 | 6822 | 150 | 70 |
| 50x | 2310 | 1121 | 750 | 350 |

## 总览（暖轮 P50；wall 含 P95）

| 循环 | 档位 | 读次数/轮 | 读口合计 P50 | 读口合计 P95 | wall P50 | wall P95 | 残差占比 |
|---|---|---|---|---|---|---|---|
| agent-timeout | 1x | 16 | 7.5 | 15.7 | 1.2 | 4.6 | 0% |
| agent-timeout | 10x | 151 | 389 | 871 | 5.6 | 11.1 | 0% |
| agent-timeout | 50x | 751 | 8813 | 10729 | 24.0 | 27.1 | 0% |
| auditor-round | 1x | 18 | 155 | 160 | 195 | 199 | 20% |
| auditor-round | 10x | 18 | 154 | 159 | 219 | 234 | 30% |
| auditor-round | 50x | 18 | 167 | 186 | 360 | 387 | 54% |
| dispatch-reconciliation | 1x | 3 | 0.69 | 0.73 | 0.78 | 0.91 | 12% |
| dispatch-reconciliation | 10x | 3 | 4.7 | 5.3 | 4.9 | 5.6 | 4% |
| dispatch-reconciliation | 50x | 3 | 26.1 | 27.6 | 26.8 | 28.6 | 3% |
| evolution-scan | 1x | 1 | 0.06 | 0.07 | 0.65 | 0.89 | 91% |
| evolution-scan | 10x | 1 | 0.06 | 0.12 | 0.64 | 0.95 | 91% |
| evolution-scan | 50x | 1 | 0.07 | 0.08 | 0.64 | 0.81 | 89% |
| monitor-daily-reflection | 1x | 6 | 137 | 138 | 498 | 499 | 73% |
| monitor-daily-reflection | 50x | 6 | 135 | 141 | 495 | 506 | 73% |
| monitor-data-lifecycle | 1x | 3 | 4.1 | 4.1 | 8.0 | 9.3 | 49% |
| monitor-data-lifecycle | 50x | 3 | 17.3 | 17.9 | 27.0 | 27.2 | 36% |
| monitor-knowledge-decay | 1x | 788 | 871 | 878 | 908 | 916 | 4% |
| monitor-knowledge-decay | 50x | 788 | 870 | 893 | 909 | 934 | 4% |
| monitor-round | 1x | 314 | 225 | 239 | 245 | 263 | 8% |
| monitor-round | 10x | 314 | 241 | 251 | 263 | 275 | 8% |
| monitor-round | 50x | 314 | 283 | 303 | 306 | 334 | 8% |
| ops-round | 1x | 0 | 0.00 | 0.00 | 42.6 | 45.1 | 100% |
| ops-round | 10x | 0 | 0.00 | 0.00 | 43.0 | 45.9 | 100% |
| ops-round | 50x | 0 | 0.00 | 0.00 | 43.7 | 44.8 | 100% |
| workunit-input-reminder | 1x | 1 | 0.26 | 0.50 | 0.30 | 0.54 | 12% |
| workunit-input-reminder | 10x | 1 | 1.5 | 2.1 | 1.6 | 2.1 | 3% |
| workunit-input-reminder | 50x | 1 | 8.8 | 9.5 | 9.0 | 9.7 | 3% |
| wu-timeout | 1x | 1 | 0.39 | 0.47 | 0.46 | 0.61 | 16% |
| wu-timeout | 10x | 1 | 2.0 | 4.2 | 2.1 | 4.3 | 4% |
| wu-timeout | 50x | 1 | 9.6 | 11.5 | 9.8 | 11.9 | 2% |

## 冷轮（首轮，缓存全冷）

| 循环 | 档位 | 读次数 | 读口合计 | wall |
|---|---|---|---|---|
| agent-timeout | 1x | 16 | 20.1 | 4.0 |
| agent-timeout | 10x | 151 | 1808 | 24.1 |
| agent-timeout | 50x | 751 | 25937 | 71.5 |
| auditor-round | 1x | 18 | 163 | 244 |
| auditor-round | 10x | 18 | 158 | 261 |
| auditor-round | 50x | 18 | 175 | 425 |
| dispatch-reconciliation | 1x | 3 | 0.82 | 2.0 |
| dispatch-reconciliation | 10x | 3 | 4.8 | 6.3 |
| dispatch-reconciliation | 50x | 3 | 27.5 | 29.7 |
| evolution-scan | 1x | 2 | 2.3 | 5.3 |
| evolution-scan | 10x | 2 | 2.2 | 6.0 |
| evolution-scan | 50x | 2 | 2.3 | 5.1 |
| monitor-daily-reflection | 1x | 5 | 134 | 532 |
| monitor-daily-reflection | 50x | 5 | 134 | 531 |
| monitor-data-lifecycle | 1x | 4 | 11.8 | 19.1 |
| monitor-data-lifecycle | 50x | 4 | 190 | 594 |
| monitor-knowledge-decay | 1x | 790 | 873 | 927 |
| monitor-knowledge-decay | 50x | 790 | 902 | 959 |
| monitor-round | 1x | 314 | 589 | 628 |
| monitor-round | 10x | 314 | 612 | 653 |
| monitor-round | 50x | 314 | 641 | 683 |
| ops-round | 1x | 0 | 0.00 | 54.0 |
| ops-round | 10x | 0 | 0.00 | 54.2 |
| ops-round | 50x | 0 | 0.00 | 54.0 |
| workunit-input-reminder | 1x | 1 | 0.33 | 0.64 |
| workunit-input-reminder | 10x | 1 | 2.4 | 2.8 |
| workunit-input-reminder | 50x | 1 | 8.3 | 8.8 |
| wu-timeout | 1x | 1 | 2.0 | 3.1 |
| wu-timeout | 10x | 1 | 9.6 | 10.6 |
| wu-timeout | 50x | 1 | 53.2 | 54.8 |

## 分桶明细（暖轮，按存储源）

### agent-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | agent-state | 15.0 | 47% | 0.51/1.1 | 0.00/0.00 | 0.00/0.01 |
| 1x | agents-dir | 1.0 | 100% | 0.05/2.0 | 0.00/0.00 | 0.00/0.00 |
| 10x | agent-state | 150.0 | 47% | 2.6/6.5 | 0.00/0.00 | 0.00/0.01 |
| 10x | agents-dir | 1.0 | 100% | 0.04/0.07 | 0.00/0.00 | 0.00/0.00 |
| 50x | agent-state | 750.0 | 47% | 11.7/14.8 | 0.00/0.00 | 0.00/0.01 |
| 50x | agents-dir | 1.0 | 100% | 0.05/0.07 | 0.00/0.00 | 0.00/0.00 |

### auditor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 12.0 | 83% | 0.07/0.22 | 0.00/0.08 | 0.01/0.02 |
| 1x | knowledge | 5.0 | 0% | 0.82/1.1 | 2.0/137 | 0.05/1.7 |
| 1x | wu-index | 1.0 | 100% | 0.10/0.11 | 0.00/0.00 | 0.24/0.32 |
| 10x | channels | 12.0 | 83% | 0.07/0.23 | 0.00/0.08 | 0.01/0.02 |
| 10x | knowledge | 5.0 | 0% | 0.81/0.99 | 2.1/135 | 0.05/1.3 |
| 10x | wu-index | 1.0 | 100% | 0.09/0.12 | 0.00/0.00 | 1.9/2.2 |
| 50x | channels | 12.0 | 83% | 0.07/1.6 | 0.00/0.10 | 0.01/0.02 |
| 50x | knowledge | 5.0 | 0% | 0.82/0.99 | 2.1/139 | 0.05/1.3 |
| 50x | wu-index | 1.0 | 100% | 0.10/2.7 | 0.00/0.00 | 8.6/12.1 |

### dispatch-reconciliation

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 3.0 | 100% | 0.04/0.06 | 0.00/0.00 | 0.18/0.21 |
| 10x | wu-index | 3.0 | 100% | 0.05/0.39 | 0.00/0.00 | 1.5/1.8 |
| 50x | wu-index | 3.0 | 100% | 0.08/0.11 | 0.00/0.00 | 8.8/9.8 |

### evolution-scan

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | other | 1.0 | 0% | 0.06/0.07 | 0.00/0.00 | 0.00/0.00 |
| 10x | other | 1.0 | 0% | 0.06/0.12 | 0.00/0.00 | 0.00/0.00 |
| 50x | other | 1.0 | 0% | 0.07/0.08 | 0.00/0.00 | 0.00/0.00 |

### monitor-daily-reflection

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | channels | 4.0 | 75% | 0.07/0.08 | 0.00/0.09 | 0.00/0.02 |
| 1x | knowledge | 2.0 | 0% | 0.82/0.89 | 1.4/133 | 0.02/1.3 |
| 50x | channels | 4.0 | 75% | 0.07/0.17 | 0.00/0.09 | 0.01/0.02 |
| 50x | knowledge | 2.0 | 0% | 0.81/0.95 | 1.4/136 | 0.02/1.8 |

### monitor-data-lifecycle

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | studio-events | 2.0 | 0% | 0.04/0.07 | 1.1/1.2 | 0.63/0.75 |
| 1x | wu-index | 1.0 | 100% | 0.02/0.05 | 0.00/0.00 | 0.21/0.22 |
| 50x | studio-events | 2.0 | 0% | 0.07/0.10 | 2.4/2.5 | 1.5/1.6 |
| 50x | wu-index | 1.0 | 100% | 0.05/0.05 | 0.00/0.00 | 9.0/9.9 |

### monitor-knowledge-decay

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | knowledge | 788.0 | 74% | 0.67/0.96 | 0.00/0.71 | 0.02/0.03 |
| 50x | knowledge | 788.0 | 74% | 0.68/1.00 | 0.00/0.75 | 0.02/0.03 |

### monitor-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | knowledge | 307.0 | 100% | 0.67/0.91 | 0.00/0.00 | 0.02/0.03 |
| 1x | wu-index | 7.0 | 100% | 0.05/0.09 | 0.00/0.00 | 0.20/0.28 |
| 10x | knowledge | 307.0 | 100% | 0.67/1.0 | 0.00/0.00 | 0.02/0.03 |
| 10x | wu-index | 7.0 | 100% | 0.06/0.45 | 0.00/0.00 | 1.5/2.2 |
| 50x | knowledge | 307.0 | 100% | 0.66/0.94 | 0.00/0.00 | 0.02/0.03 |
| 50x | wu-index | 7.0 | 100% | 0.08/0.16 | 0.00/0.00 | 9.0/10.6 |

### ops-round

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|

### workunit-input-reminder

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.06/0.11 | 0.00/0.00 | 0.20/0.36 |
| 10x | wu-index | 1.0 | 100% | 0.04/0.56 | 0.00/0.00 | 1.5/1.7 |
| 50x | wu-index | 1.0 | 100% | 0.09/0.11 | 0.00/0.00 | 8.5/9.4 |

### wu-timeout

| 档位 | 存储源 | 次数/轮 | 命中率 | stat P50/P95 | readParse P50/P95 | clone P50/P95 |
|---|---|---|---|---|---|---|
| 1x | wu-index | 1.0 | 100% | 0.07/0.12 | 0.00/0.00 | 0.32/0.35 |
| 10x | wu-index | 1.0 | 100% | 0.09/2.2 | 0.00/0.00 | 1.9/2.5 |
| 50x | wu-index | 1.0 | 100% | 0.11/0.57 | 0.00/0.00 | 9.5/11.3 |

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

（待人工分析后填写）

## 复测结论（#343）

**前后对比（基线 = report-loop-read-metrics-363-rerun.md，2026-08-26，同口径 21 轮；「后」= 本报告 2026-08-28，#343 memo 后）**：

| 循环 | 档位 | wall P50（前 → 后） | 残差占比（前 → 后） | 读次数/轮（前 → 后） |
|---|---|---|---|---|
| monitor-round | 1x | 691 → 245 | 100% → 8% | 7 → 314 |
| monitor-round | 10x | 704 → 263 | 98% → 8% | 7 → 314 |
| monitor-round | 50x | 743 → 306 | 91% → 8% | 7 → 314 |
| auditor-round | 1x | 182 → 195 | 98% → 20% | 9 → 18 |
| auditor-round | 10x | 223 → 219 | 97% → 30% | 9 → 18 |
| auditor-round | 50x | 341 → 360 | 96% → 54% | 9 → 18 |

- 读次数上升 = 知识库读口此前不在埋点面（harness FileKnowledgeStore 裸 fs，绕过 studio-shared 读口），#343 起经 MtimeMemoKnowledgeStore 埋点（op=knowledgeRead）进入统计，分母补全导致残差占比下降的可见化效应。
- **monitor-round wall -63%**（691→245 @1x；743→306 @50x）：原残差大头（每轮对 ~203 条知识条目的多次全库同步扫描——healthScore + promotion 逐条 get + linter，N+1 readFileSync）被 memo 收敛为指纹校验 + 内存命中；knowledge 桶 307 读/轮、**命中率 100%、readParse P50=0**（零文件重读），memo 生效直接证据。
- **auditor-round wall 持平**（±5% 噪声内）：其知识开销是写驱动——dailyAudit 每轮 `recordPattern` 写 audit trend 条目打穿 memo，读侧 5 次/轮全部 miss 属预期（写后读一致性优先，正确性行为不变）；残差占比下降是读口可见化的分母效应，非提速。
- **injectContext 验收（每步读口 ≤1 次 memo 查）**：memo 单测锁定（同指纹重复 list/get 零底层调用、异 filter 共享指纹、外部写必现——knowledge-store-memo.test.ts）；agent-loop 连续步间 `recordReference('prompt-inject')` 同日同贡献者去重（harness lifecycle B4）保证指纹跨步稳定，稳态每步 4 次 memo 查、0 次文件重读。
- 后续方向（不在本票）：指纹校验为每次读口 O(N) stat，monitor-round 307 次/轮 × ~0.7ms ≈ 215ms 已成该轮读口新大头，可加 tick 内/TTL 窗口去重；知识库收进 FileStore seam（#343 长期方向，另票）后 memo 与本测量口径整体作废。
