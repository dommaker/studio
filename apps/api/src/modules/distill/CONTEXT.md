# distill

> 此文件描述 apps/api/src/modules/distill 目录的职责和上下文

## 职责

蒸馏主链路最小闭环（#143，spec #141 / 决策 #83 D1-D5）：把知识库里堆积的「矿石」（session-summary 自动沉淀条目）事件门槛驱动地提炼成蒸馏知识条目。链路 = WU 收尾钩子（`workunit.status_changed → done`）顺带跑门槛检测（纯确定性计数，零 LLM 成本）→ 命中发 `distill_proposal` 人审卡到 #系统 频道 → approve 后由 system-executor 执行一次蒸馏调用 → 产物入库（`sourceReferences` 指向全部原料 id）+ 原料 `maturity=archived` 移出主区 → 运行记录落数据区、全链路事件写 `studio-events.jsonl`。

本票边界：产物统一入库为知识条目（guideline/active/reference）；三分落地（skill/约束/角色记忆分流）归 #145，GC 候选清单归 #144，存量约束审计归 #146。

## 数据布局

```
<studioDir()>/distill/
  proposals.jsonl   # append-only：{kind:'proposal',...} 行 + {kind:'status',id,status,at} 墓碑行
  runs.jsonl        # 蒸馏运行记录：executedAt/outcome(executed|failed)/signals/materialIds/productIds
```

- `runs.jsonl` 的 executedAt 序列有两个读法：熔断时钟 `lastRunAt`（任何 outcome——失败/空产出也烧了 token，同样熔断）与消费基线 `lastConsumedAt`（executed 且产物 ≥1——「新条目」判定基线，失败不推进，原料不被老化作废）；后者也是 #144 GC 按蒸馏周期计龄的输入。
- 知识库读写走 harness `FileKnowledgeStore`（`update(id,{maturity:'archived'})` 即归档，不搬文件）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `evaluateDistillThreshold` | `distill-threshold.ts` | 门槛检测纯函数：同 tag 新条目 ≥3 或 manual 过审（verified/proven）新条目 ≥5，且距上次运行 ≥7 天；「新」= created 严格晚于 lastConsumedAt（失败/空产出不推进）；archived/deprecated 不计 |
| `TOPIC_MIN_NEW` / `MANUAL_MIN_NEW` / `COOLDOWN_DAYS` / `MAX_MATERIALS` | `distill-threshold.ts` | 阈值常量（3 / 5 / 7 / 20） |
| `DistillService` | `distill-service.ts` | 编排：subscribeToEvents（done 钩子）/ maybePropose（门槛+发卡）/ approve（预算守卫+执行）/ reject（零副作用）/ getProposalStatuses |
| `DISTILL_SYSTEM_PROMPT` / `buildDistillPrompt` / `normalizeDistillProducts` | `distill-service.ts` | 蒸馏 prompt 与产出解析（缺 title/content 丢弃，≤5 条） |
| `DistillStore` | `distill-store.ts` | proposals/runs JSONL 持久化（墓碑折叠、lastRunAt） |
| `postDistillProposalCard` | `distill-proposal-card.ts` | 发卡到 #系统；频道缺失/发卡失败返回 false（静默，#101 降级口径） |
| `getDistillService` / `initDistillLoop` | `distill-runtime.ts` | 懒单例 + 启动订阅（唯一 import knowledge-singletons 的文件；onProductsSaved 接 scheduleVectorDbSync） |
| `distill.routes` | `distill.routes.ts` | POST `/approve` `/reject`（`{proposalId}`）；GET `/proposal-status?ids=`（只读） |

## 设计决策

- **人审闸门**：LLM 批处理永远有人确认（#80 已判无人值守触发器死刑）。pending 提案存在期间不重复发卡；发卡失败标记 `card-failed`（终态，不阻塞后续提案）。
- **蒸馏即消费**：approve 成功且产物 ≥1 → 原料 `maturity=archived`；产物 `sourceReferences` 用扩展键 `entryId` 回指全部原料 id（harness `SourceRef` 无此字段，扩展键随 frontmatter YAML 原样往返）。LLM 空产出 → 不消费原料但落 executed 运行记录。
- **失败不阻塞**：LLM 异常 / JSON 解析失败 → 原料不动、提案 `failed`、落 failed 运行记录；maybePropose 永不抛（fire-and-forget + catch 记日志，同 WuCompletionExtractor）。失败运行推进熔断时钟（防烧钱循环）但不推进消费基线（原料可下轮再蒸馏）。
- **预算守卫**：approve 时查 daily-token-budget（与 #99 同口径）；耗尽 → 跳过执行（不报错、不消费），提案保持 pending 可次日重试。
- **manual 过审口径**：maturity verified/proven（promote 路径 draft→verified→proven 是唯一人审通过通道）；promote 不留独立时间戳，故按「created 晚于上次运行」计新。
- **事件**：`knowledge:distill`，stage ∈ proposal-posted / card-failed / executed / failed / rejected / skipped(budget-exhausted)；门槛未命中不落事件（零噪音）。
- **前端**：`DistillProposalCard`（cardType `distill_proposal`）+ ChannelDetailPage handleAction 分发；approve 返回 `success:false + skipped:'budget-exhausted'` 时卡片保持待审。

## 依赖关系

**上游**:
- `@dommaker/harness`（`FileKnowledgeStore` / `KnowledgeEntry` 类型）
- `@dommaker/studio-shared`（`FileStore`、`eventBus`、`studioPath`）
- `modules/knowledge/knowledge-singletons.ts`（sharedStore / scheduleVectorDbSync，仅 runtime 装配）
- `modules/agents/system-executor.ts`（LLM 调用）、`modules/agents/loop/daily-token-budget.ts`（预算守卫）
- `modules/channels/channel-message.service.ts`（发卡）、`utils/studio-events.ts`（统一事件入口）

**下游**:
- #144 GC 候选清单（消费 runs.jsonl 计龄）、#145 产物三分落地、#146 存量约束审计挂蒸馏事件

## 注意事项

- 测试注入临时目录（`new DistillService({store, fileStore, dataDir, eventsFile})`），不碰 `~/.studio`；LLM seam = mock `getSystemExecutor`。
- `store.list()` 每次门槛检测全量读索引（零 LLM 但有 IO）；知识库稳态百条级，可接受。
- approve 非事务：进程在「产物已存、原料归档中」崩溃会留下半成品（原料部分归档）——最小闭环接受，重跑由新提案覆盖。
