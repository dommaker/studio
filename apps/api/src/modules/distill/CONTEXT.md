# distill

> 此文件描述 apps/api/src/modules/distill 目录的职责和上下文

## 职责

蒸馏主链路最小闭环（#143，spec #141 / 决策 #83 D1-D5）：把知识库里堆积的「矿石」（session-summary 自动沉淀条目）事件门槛驱动地提炼成蒸馏知识条目。链路 = WU 收尾钩子（`workunit.status_changed → done`）顺带跑门槛检测（纯确定性计数，零 LLM 成本）→ 命中发 `distill_proposal` 人审卡到 #系统 频道 → approve 后由 system-executor 执行一次蒸馏调用 → 产物入库（`sourceReferences` 指向全部原料 id）+ 原料 `maturity=archived` 移出主区 → 运行记录落数据区、全链路事件写 `studio-events.jsonl`。

GC 候选清单与人审归档（#144，D4）：每次蒸馏运行后按**蒸馏周期**计龄生成淘汰候选——reference/context 层条目连续 3 个周期 `lastReferenced` 未更新 → 进清单（每条附可读理由：哪几个周期零引用）发 `gc_proposal` 人审卡；approve 后候选 `maturity=archived`（可恢复：归档不搬文件）；reject = 人判保留，后续运行不再提案该条目。manual 过审（verified/proven）条目享 3 周期新生豁免；signal 层跳过（归蒸馏生命周期）、rule 层跳过（归 #139）；主区 >200 条无条件强制出清单（放宽周期门，有多少周期用多少）。判据不读墙钟：系统闲置 → 无蒸馏运行 → 无新周期 → GC 自然休眠。

产物三分落地分流（#145，D2 三分）：蒸馏 LLM 产出自带类型分类——skill（过程性知识）→ skills 库提案（skillStore draft + proposalStore pending + skill_review_request 卡，审批走既有 `/api/v1/skills/proposals/:id/*`）；constraint（边界性知识）→ `constraint-drafts.jsonl` 变更草案（add/override/retire 的具体 ymlSnippet，不直接改约束文件——#82 D6 派单通道未就绪的简化落盘形态，草案 status=pending 待派单接线）；preference/execution-knowledge → 角色记忆草稿（studio 系统角色，review=manual + memory_proposal 人审卡，复用 #99/#101 接线）。缺/未知类型、约束缺合法 change、通道未接线或落地失败 → 回落知识库条目（#143 行为，产物不丢）。三类通道产物都带原料指针（skill→metadata.sourceReferences、constraint→草案记录、memory→draft sourceRefs）。

存量约束审计归 #146。

## 数据布局

```
<studioDir()>/distill/
  proposals.jsonl          # append-only：{kind:'proposal',...} 行 + {kind:'status',id,status,at} 墓碑行
  runs.jsonl               # 蒸馏运行记录：executedAt/outcome(executed|failed)/signals/materialIds/productIds/landings(#145)
  gc-proposals.jsonl       # GC 候选清单提案（#144）：候选附理由 + runId 回指触发运行 + 状态墓碑
  constraint-drafts.jsonl  # 约束变更草案（#145）：action/constraintId/ymlSnippet/rationale/sourceReferences，status=pending 待 D6 派单
```

- `runs.jsonl` 的 executedAt 序列有三个读法：熔断时钟 `lastRunAt`（任何 outcome——失败/空产出也烧了 token，同样熔断）、消费基线 `lastConsumedAt`（executed 且产物 ≥1——「新条目」判定基线，失败不推进，原料不被老化作废）、GC 蒸馏周期序列（outcome=executed 的运行——#144 计龄输入，失败运行不构成周期）。
- 知识库读写走 harness `FileKnowledgeStore`（`update(id,{maturity:'archived'})` 即归档，不搬文件）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `evaluateDistillThreshold` | `distill-threshold.ts` | 门槛检测纯函数：同 tag 新条目 ≥3 或 manual 过审（verified/proven）新条目 ≥5，且距上次运行 ≥7 天；「新」= created 严格晚于 lastConsumedAt（失败/空产出不推进）；archived/deprecated 不计 |
| `TOPIC_MIN_NEW` / `MANUAL_MIN_NEW` / `COOLDOWN_DAYS` / `MAX_MATERIALS` | `distill-threshold.ts` | 阈值常量（3 / 5 / 7 / 20） |
| `DistillService` | `distill-service.ts` | 编排：subscribeToEvents（done 钩子）/ maybePropose（门槛+发卡）/ approve（预算守卫+执行）/ reject（零副作用）/ getProposalStatuses |
| `DISTILL_SYSTEM_PROMPT` / `buildDistillPrompt` / `normalizeDistillProducts` | `distill-service.ts` | 蒸馏 prompt（#145 起要求产物带 type 分类）与产出解析（缺 title/content 丢弃，≤5 条；缺/未知 type、constraint 缺合法 change → 回落 knowledge） |
| `DistillProductType` / `NormalizedDistillProduct` / `DistillLanding` / `DistillLandings` | `distill-service.ts` | #145 类型化产物与落地通道接口（通道返回 null/抛错 → 回落知识条目） |
| `createSkillLanding` / `createConstraintLanding` / `createMemoryLanding` | `distill-landings.ts` | #145 三通道实现：skills 库提案 / 约束变更草案落盘 / 角色记忆草稿（studio 系统角色 + memory_proposal 卡） |
| `DistillStore` | `distill-store.ts` | proposals/runs JSONL 持久化（墓碑折叠、lastRunAt） |
| `postDistillProposalCard` | `distill-proposal-card.ts` | 发卡到 #系统；频道缺失/发卡失败返回 false（静默，#101 降级口径） |
| `generateGcCandidates` | `gc-candidates.ts` | GC 周期计龄纯函数（#144）：reference/context 层连续 3 周期 `lastReferenced` 未更新 → 候选（附可读理由）；manual 3 周期新生豁免；signal/rule 跳过；主区 >200 强制 |
| `GC_REQUIRED_CYCLES` / `GC_MAIN_AREA_LIMIT` | `gc-candidates.ts` | 阈值常量（3 / 200） |
| `GcStore` | `gc-store.ts` | gc-proposals.jsonl 持久化（墓碑折叠；rejectedEntryIds = 人判保留不再提案） |
| `postGcProposalCard` | `gc-proposal-card.ts` | gc_proposal 卡到 #系统（候选逐条附理由；失败静默同口径） |
| `DistillService.runGcCheck/approveGc/rejectGc` | `distill-service.ts` | #144：每次蒸馏运行后 GC 检查（永不抛）；approve → 候选 archived（可恢复）；reject → 零副作用 |
| `getDistillService` / `initDistillLoop` | `distill-runtime.ts` | 懒单例 + 启动订阅（唯一 import knowledge-singletons 的文件；onProductsSaved 接 scheduleVectorDbSync） |
| `distill.routes` | `distill.routes.ts` | POST `/approve` `/reject`（`{proposalId}`）；GET `/proposal-status?ids=`（只读）；#144：POST `/gc/approve` `/gc/reject`（`{gcProposalId}`）、GET `/gc/proposal-status?ids=` |

## 设计决策

- **人审闸门**：LLM 批处理永远有人确认（#80 已判无人值守触发器死刑）。pending 提案存在期间不重复发卡；发卡失败标记 `card-failed`（终态，不阻塞后续提案）。
- **GC 周期计龄（#144）**：计龄单位 = 执行成功的蒸馏运行（runs.jsonl 中 outcome=executed 的 executedAt 序列；失败运行不构成周期，同消费基线「失败不推进」口径），不读墙钟——系统闲置三个月 → 无新运行 → 无新周期 → 无人过线冤案。manual 新生豁免锚在 `created`（promote 不留独立时间戳，承袭 #143 口径；「老条目新过审」场景覆盖不了，已知限制）。reject 的候选条目记入人判保留集，后续运行不再提案（防打扰，D4「人审历史作保护项」）；approve 归档可恢复（改回 active 即恢复，无独立恢复入口——语义可逆）。GC 检查挂在每次 executed 运行落盘后，runGcCheck 永不抛。
- **蒸馏即消费**：approve 成功且产物 ≥1 → 原料 `maturity=archived`；产物 `sourceReferences` 用扩展键 `entryId` 回指全部原料 id（harness `SourceRef` 无此字段，扩展键随 frontmatter YAML 原样往返）。LLM 空产出 → 不消费原料但落 executed 运行记录。
- **三分落地（#145）**：`productIds` 记全部落地产物 id（知识条目 + 三通道产物），保证「executed 且产物 ≥1 才推进消费基线」口径不因分流漏推进；运行记录带 `landings` 分布（knowledge/skill/constraint/memory 各桶产物 id，knowledge 桶含回落条目）。落地通道经 `deps.landings` 注入（service 保持 DI 纯净），单产物落地失败只回落该产物、不影响同批其它产物。约束草案是落盘简化形态（D6 派单未就绪），retire 草案只写操作说明（harness retire 落 config.yml 非 custom-constraints.yml，草案不替人执行）。memory 通道锚 studio 系统角色（`ensureStudioProfile` 幂等解析）——蒸馏是系统级沉淀，无具体 WU 承担者角色。
- **失败不阻塞**：LLM 异常 / JSON 解析失败 → 原料不动、提案 `failed`、落 failed 运行记录；maybePropose 永不抛（fire-and-forget + catch 记日志，同 WuCompletionExtractor）。失败运行推进熔断时钟（防烧钱循环）但不推进消费基线（原料可下轮再蒸馏）。
- **预算守卫**：approve 时查 daily-token-budget（与 #99 同口径）；耗尽 → 跳过执行（不报错、不消费），提案保持 pending 可次日重试。
- **manual 过审口径**：maturity verified/proven（promote 路径 draft→verified→proven 是唯一人审通过通道）；promote 不留独立时间戳，故按「created 晚于上次运行」计新。
- **事件**：`knowledge:distill`，stage ∈ proposal-posted / card-failed / executed / failed / rejected / skipped(budget-exhausted) / gc-proposal-posted / gc-card-failed / gc-executed / gc-rejected（#144）；门槛未命中与 GC 零候选不落事件（零噪音）。
- **前端**：`DistillProposalCard`（cardType `distill_proposal`）+ `GcProposalCard`（cardType `gc_proposal`，#144）+ ChannelDetailPage handleAction 分发；approve 返回 `success:false + skipped:'budget-exhausted'` 时卡片保持待审。

## 依赖关系

**上游**:
- `@dommaker/harness`（`FileKnowledgeStore` / `KnowledgeEntry` 类型）
- `@dommaker/studio-shared`（`FileStore`、`eventBus`、`studioPath`）
- `modules/knowledge/knowledge-singletons.ts`（sharedStore / scheduleVectorDbSync，仅 runtime 装配）
- `modules/agents/system-executor.ts`（LLM 调用）、`modules/agents/loop/daily-token-budget.ts`（预算守卫）
- `modules/channels/channel-message.service.ts`（发卡）、`utils/studio-events.ts`（统一事件入口）

**下游**:
- #145 产物三分落地已落地（本模块 distill-landings；下游通道：modules/skills 提案、modules/role-memory 草稿）；#146 存量约束审计挂蒸馏事件；#144 GC 候选清单已落地（本模块 gc-*）

## 注意事项

- 测试注入临时目录（`new DistillService({store, fileStore, dataDir, eventsFile})`），不碰 `~/.studio`；LLM seam = mock `getSystemExecutor`。
- `store.list()` 每次门槛检测全量读索引（零 LLM 但有 IO）；知识库稳态百条级，可接受。
- approve 非事务：进程在「产物已存、原料归档中」崩溃会留下半成品（原料部分归档）——最小闭环接受，重跑由新提案覆盖。
