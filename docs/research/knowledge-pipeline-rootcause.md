# 知识沉淀管线死亡根因排查（issue #75）

> 2026-08-09 研究票 [#75](https://github.com/dommaker/studio/issues/75)，供决策票 [#74 角色长期记忆机制](https://github.com/dommaker/studio/issues/74) 引用。
> 种子文档：`research/timeout-data-measurement` 分支 `docs/issues/2026-08-09-knowledge-flywheel-handoff.md`（#53/#68 移交）。
> 方法：代码路径走查 + 生产数据（`~/.studio/`，只读）交叉验证。注：agent-loop 已于 2026-08-07 从 `modules/channels/` 迁至 `modules/agents/loop/`（commit 89d3c2ed），下文均按现路径引用。

## TL;DR

管线不是"坏了"，是**被故意关停 + 结构性断点叠加**：

1. **总闸（主因）**：2026-08-03 无人值守烧掉 1.03 亿 token（`docs/issues/2026-08-03-unattended-token-burn.md`），当日全部 5 个 LLM CREATE 类触发器被设为 `enabled: false` 止血（commit 2b0859fb）。此后**没有任何自动 WU 创建**，执行驱动的沉淀链路整体无输入。这是 08-03 后静默的直接原因。
2. **失败步埋点缺口（次因，且是永久性的）**：失败步在 `agent-loop.ts:747-764` 提前 return、异常分支在 `:861-875` return，都跳过 `recordExecutionOutcome`——`knowledge:outcome:failure` 事件**历史上一条都不存在**。即使恢复触发器，占大头的失败执行对反馈环依然完全隐形。
3. **会话提取几乎从未工作**：`knowledge:extraction` 历史仅 1 条，且该次 `entryCount: 0, totalTokens: 0`——唯一跑成的一次也没提取出任何东西。
4. **维护侧空转烧噪声**：`runSyncCycle` 每小时无条件落一条 trend 条目，占 `knowledge:entry_created` 的 38%；`capture()` 无任何生产调用方；会话归档器代码不存在（07-18 起）。

---

## 生产事件流基线（`~/.studio/logs/studio-events.jsonl`，截至 2026-08-09）

| 事件 | 总量 | 时间窗 | 结论 |
|---|---|---|---|
| `knowledge:skill_used` | 9,352 | 08-02 → 08-09 | 注入侧活着（其中 08-03 一天 9,198 条 = 烧钱事故当天） |
| `knowledge:entry_created` | 469 | 持续至今 | 维护噪声仍在产出（详见噪声清单） |
| `knowledge:outcome:success` | 5 | 08-02 → 08-03 01:33 | 只有 5 条，此后再无 |
| `knowledge:outcome:failure` | **0** | — | **从未存在过** |
| `extractFromExecution` | 5 | 同上 | 与 outcome 同生同灭 |
| `knowledge:extraction` | 1 | 08-02 20:20 | 唯一一条：`entryCount:0, promptTokens:0, completionTokens:0, durationMs:16359` |
| `workunit:tokens` | 08-02: 2 / **08-03: 641** / 08-04~08-08: **0** / 08-09: 3 | — | 08-03 后 agent 执行归零 |
| `workunit:execution_step` | 08-02: 2 / 08-03: 3 / 此后 0 | — | 该事件只在成功路径发射（见断点 2），641 vs 3 ⇒ 08-03 约 638 次执行全部失败 |

WU 侧（`~/.studio/data/workunits/index.json` + `events.jsonl`）：共 150 个 WU，**08-04 ~ 08-08 五天零创建**；08-09 人工建了 3 个（2 个 unassigned，1 个 analysis WU `3a86c8c0` 在 3 次 120s 超时后 blocked）。

## 总闸：触发器全停（08-03 止血）

- `apps/api/src/modules/agents/default-triggers.ts`：`knowledge-quality-audit`(:43)、`session-knowledge-extraction`(:71)、`zero-consumption-audit`(:89)、`knowledge-synthesis`(:107)、`doc-semantic-review`(:148) 五个 CREATE WorkUnit 触发器全部 `enabled: false`，注释直指 burn 文档；commit 2b0859fb（2026-08-03「无人值守 token 燃烧修复 B/C 档」）。
- `~/.studio/triggers/daily-health-check.yaml`：`enabled: false`，注释同日停用。
- 仍 enabled 的都是 EXECUTE 类扫描（workunit-timeout / agent-timeout / okr-metric-sync / workunit-input-reminder / evolution-daily-scan），不创建 WU、不驱动执行。
- 同文件 `getDefaultTriggerConfigs()`（:155-273，标注 for testing）里这五个触发器仍是 `enabled: true`——与生产注册块漂移，存在被误用的隐患。

**结论：08-03 后沉淀链路的"静默"首先是刻意为之。** 但下面的断点说明：即使把触发器开回来，链路也仍然是漏的。

## 逐环节根因

### 断点 1：`recordOutcome` / `extractFromExecution` —— 失败步整体隐形

调用链：`agentStep` 成功路径 `agent-loop.ts:807` → `recordExecutionOutcome`（:953-978）→ `knowledgeService.recordOutcome`（knowledge-service.ts:846，写 `knowledge:outcome:success|failure`）+ `extractFromExecution`（knowledge-service.ts:259，写 `extractFromExecution` 事件 + `[Exec]` 条目）。

断点：

- **失败分支跳过**：`result.success === false` 时 `agent-loop.ts:747-764` 直接 return（W-3 接线，2026-07-27 commit 6f263685 引入），`recordExecutionOutcome` 在 :807 永远到不了。catch 异常分支 :861-875 同样跳过。
- **生产实证**：`knowledge:outcome:failure` 0 条；08-03 有 641 条 `workunit:tokens`（失败也记账，:713-734 在 return 之前）但只有 3 条 `workunit:execution_step`（成功路径才发，:795）——约 638 次失败执行在知识反馈环里零痕迹。08-03 01:00 一小时 532 次 = 烧钱风暴主体。
- **新鲜实证（08-09）**：WU `3a86c8c0`（PMO-12 分析）08:59 认领，3 个会话各自精确跑了 120 秒（08:59:24→09:01:24、09:01:40→09:03:40、09:03:56→09:05:56）——全部被 `timeoutMs: 120_000`（agent-loop.ts:703）杀掉 → 走失败分支 → consecutiveStuck=3 → blocked。3 次执行，0 条 outcome、0 条 extraction。**120s 超时 + 失败无埋点，是"维护 WU 反复超时空烧"（种子文档线索 3）的机制根因。**
- 次要：`extractFromExecution` 的去重合并逻辑（knowledge-service.ts:279-292）按标题前 40 字符合并同类 `[Exec]` 条目，即使运行也多是合并而非新建。

### 断点 2：`extractFromConversation` —— 四重门全过才发射，历史上只跑成 1 次且颗粒无收

调用链：`agent-loop.ts:813-826`，条件 `stepResult.action === 'complete' && !metadata.knowledgeExtractedAt` → knowledge-service.ts:334-408。

四重门：

1. 步必须成功（失败分支到不了，同断点 1）；
2. 该步必须输出 `ACTION: COMPLETE`；
3. studio role provider 必须配置，否则 `StudioRoleNotConfiguredError` → knowledge-service.ts:401-403 **静默 return**（仅 info 日志，无事件）；
4. LLM 输出必须能 JSON.parse 且含 `entries`。

- **生产实证**：唯一的 `knowledge:extraction`（08-02 20:20，WU d5efbf96）`entryCount: 0, totalTokens: 0`——唯一跑成的一次，LLM 返回空 entries 且未回报 usage。其余 complete 步要么在 R3 上线前、要么被门 3/4 静默吞掉（warn 日志不进事件流，事后无法归因）。
- 08-03 后无 complete 步，此链路归零。

### 断点 3：`KnowledgeSync.capture()` —— 零生产调用方（死代码）

- knowledge-sync.service.ts:141-185，设计为"Cycle 1：分析完成 → 按 scope upsert 知识"。全仓 grep（排除 `__tests__`）**无任何调用方**。
- 连带后果：`detectStaleness`（:192-275）依赖 capture 写入的 scope 标签条目才有东西可检；capture 死了 → 每轮恒 `0 stale` → 喂给断点 4 的噪声机。另 `runSyncCycle` 每轮把 unmonitored scope 以 `files: []` 自动注册（:322-331），这些 scope 永远无法判 stale，注册表只增不减（内存态）。
- 若被调用，它每次还会写一条 `KnowledgeSync capture:` trend 条目（:175-182）——又一台噪声机。

### 断点 4：`runSyncCycle` —— 唯一活着的环节，每小时写零值噪声

- 唯一调用方：`monitor-system-probes.ts:97`（`runCircuitCheckAndRepair`），挂在 MonitorService 启动 + 每小时 setInterval（monitor.service.ts:48,51）。
- knowledge-sync.service.ts:341-355：**无条件** `recordPattern` 一条 `KnowledgeSync cycle: X stale, Y unmonitored, Z healed` trend 条目，0/0/0 也写（severity=info 照写）。
- **生产实证**：`knowledge:entry_created` 469 条中 180 条（**38%**）是 KnowledgeSync cycle（161 × `0 stale, 0 unmonitored, 0 healed` + 19 × `0 stale, 1 unmonitored, 0 healed`）；管线全死的 08-04~08-08 期间仍以 ~24 条/天的速度新增。与种子文档"约 40%"一致。

### 断点 5：会话归档器 —— 代码不存在，沉淀输入 07-18 起断供（移交事实复核确认）

- 全仓 grep `data/sessions`：仅 default-triggers.ts:67,205 两处触发器 scope **文本**，无任何写 `~/.studio/data/sessions/` 的代码。
- 目录实况：19 个文件全部 `.done`，最新沉积 07-16/18（种子文档口径，本次复核一致）。
- 真实 transcript 源（`~/.claude/projects/<slug>/*.jsonl`、`~/.kimi-code/sessions/`）→ `data/sessions/` 的归档器从未被实现。注意：**若直接恢复 `session-knowledge-extraction` 触发器而不补归档器，它会恢复"每天 04:17 扫一遍全 `.done` 目录然后空转退出"的纯烧钱循环**（burn 文档 P2-1 已实证）。

## 噪声源与死循环完整清单

| # | 噪声源 | 位置 | 量级（实测） | 状态 |
|---|---|---|---|---|
| N1 | KnowledgeSync cycle 零值条目 | knowledge-sync.service.ts:341-355 | entry_created 的 38%，~24 条/天 | **活跃，管线死后仍在增长** |
| N2 | `[Auditor] Daily audit … 0 execs, 100% success` | auditor 日审计 | ~22 条事件（08-03 起每天 1-10 条） | 活跃——审计一个不存在的执行流 |
| N3 | evolution-daily-scan | default-triggers.ts:124-131（`EVOLUTION_ENABLED` 默认 ON） | `daily_reflection` 事件每天 1 条 | 活跃——扫描无新 traces/outcomes，恒零提案 |
| N4 | session-knowledge-extraction 空扫 | default-triggers.ts:59-75 | 启用时日烧一轮 LLM 会话 | 已停用（止血），恢复即有害 |
| N5 | capture() 的 `KnowledgeSync capture:` 条目 | knowledge-sync.service.ts:175-182 | 0（无调用方） | 休眠炸弹 |
| N6 | 无 GC | — | knowledge 活跃 218 + archive 220（6.3MB）只进不出；`data/sessions/` 143MB `.done` 永久保留 | 活跃 |

## 修复建议（按依赖序，仅建议不实现）

1. **失败步埋点（P0，一切恢复的前置）**：在 `agent-loop.ts:747` 失败分支与 `:861` catch 分支 return 前调 `recordExecutionOutcome`（至少 `recordOutcome({success:false, …})`）。没有 outcome:failure 信号，任何"恢复触发器"都是盲飞。
2. **120s 超时重设计（P0）**：`timeoutMs: 120_000`（agent-loop.ts:703）把真实任务变成 3×120s→blocked 零产出。按 WU 类型配预算；健康巡检类按 burn 文档 P0-1a 改 shell 直跑（零 token）。
3. **KnowledgeSync 止血（P1，立即可做，不影响恢复决策）**：`stale=0 && unmonitored=0 && healed=0` 时只 log 不落条目（knowledge-sync.service.ts:341 加守卫）；同批抑制 N2（0 execs 不写条目）。预计消灭 ~40% 新增噪声。
4. **extractFromConversation 可观测性（P1）**：跳过原因（provider 未配置 / 空提取 / parse 失败）写事件（如 `knowledge:extraction` 带 `skipped: reason` 字段），否则恢复后仍无法归因。
5. **capture() 二选一（P2）**：接线到 analyst 分析完成流程，或删除。勿留着腐烂——它还连着 detect/heal 的语义空转。
6. **归档器（P2，恢复 session-knowledge-extraction 的前置）**：实现 claude/kimi transcript → `~/.studio/data/sessions/` 的增量归档；之后才可重开该触发器。
7. **触发器恢复门禁（P2）**：五个停用触发器不要一把梭恢复。前置：埋点（#1）+ 超时（#2）+ 预算熔断（burn 文档 P2-2）验证生效；节奏：先周级后日级。
8. **GC 策略（P2）**：trend 类条目（KnowledgeSync cycle 等）TTL 7 天；`.done` session 文件与 knowledge archive 定保留期。
9. **触发器配置漂移（P3）**：`getDefaultTriggerConfigs()`（default-triggers.ts:155-273）与生产注册块 enabled 状态不一致，统一单一来源。

## 衍生的新问题（建议另开跟进票）

- 失败步 outcome 埋点 + 120s 超时预算重设计（本报告断点 1，P0）
- transcript 自动归档器（断点 5，恢复 session 提取的前置）
- KnowledgeSync 零值条目止血 + trend 条目 GC（N1/N6）
- 触发器分批恢复门禁：预算熔断验证 → 周级 → 日级
- Auditor 零执行条目抑制（N2）+ extractFromConversation 跳过原因可观测性
