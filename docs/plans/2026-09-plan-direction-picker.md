# plan 流程方向锁定提案卡（plan-direction-picker）

## 背景与现状

plan WU 一脉会话流程（`apps/api/src/modules/agents/loop/prompt-composer.ts` CONTRACT_TEMPLATES.plan，
#471/#467 定稿）：澄清 → fog 调研 → **裁决轮** → spec 成文 → TASK 拆单。裁决环节现状：

- #467 已落「裁决轮」：fog 调研齐后 agent 输出 `ACTION: NEED_INPUT:…` + 紧随逐行
  `RULING: {"question","suggestion","default?"}`（解析在 `agents/loop/agent-loop-parsers.ts`
  parseRulingLines，封顶 MAP_OPENING_FOG_MAX=12，可与 OPTIONS 行共存）→ 落
  `metadata.planRulings` + `waitingReason='plan-ruling'` → 频道 PlanRulingCard 接力卡 +
  PlanRulingDialog 逐题裁决 → `POST /workunits/:id/ruling` → `pmo/plan-ruling.ts`
  applyPlanRuling 批量落 map.decisions[]/fog + resumeWaitingWorkUnit 同会话复活。
- 裁决轮是**逐题裁决**：每个待决问题给一个建议结论，人逐题采纳/修改/打回。它回答
  「这题怎么定」，不回答「这票整体往哪个方向走」。当待决问题背后是互斥的大方向
  （如「自研 vs 引入依赖」「改旧链 vs 新链并行」），逐题裁决会让人在没有全局图景下
  逐题表态，方向性返工（拆完单发现方向错了）仍会发生。
- 相关现成机制：F5 NEED_INPUT 挂起/恢复（`workunit/waiting-input.ts`
  resumeWaitingWorkUnit，回复入 pendingReplies 注入下一步 prompt，sessionId 不动同会话
  续跑）；OPTIONS 结构化选项行（#279，`OPTIONS: [{label,description,value}]`，前端点选
  即作为回复发送，ownership 链在用）；blocked 30 分钟一次性提醒
  （scanWaitingForInputReminders，STUDIO_INPUT_REMINDER_MINUTES 可配）；blocked 24h
  死信自动关闭（autoAbandonStaleBlocked，**decision/spec 豁免，plan 不豁免**）。
- 人审提案卡正本（`modules/review-proposal/`，ADR 2026-08-25-review-proposal-lifecycle-module）：
  adapter 注册 `{kind, cardType, renderCardContent, onApprove, onReject?}`，生命周期
  `pending|executed|rejected|failed|card-failed`，**发卡固定 #系统 频道**（card.ts
  SYSTEM_CHANNEL_NAME），语义是异步 approve/reject 审批闸。

## 目标与非目标

目标：
- plan 流程在「存在互斥大方向」时，先出 2-3 个候选方向 + agent 推荐 + 取舍说明，
  人锁定一个方向后再继续裁决细节/成文/拆单，减少方向性返工。
- 只改 plan 类型的裁决环节，复用 #467 已建的挂起-卡-复活链路，不另起范式。

非目标：
- 不动其他 WU 类型（implement/review/analysis/bug/decision/spec）流程。
- 不改裁决轮（RULING）既有语义；方向锁定是其**前置可选环节**，不是替代。
- 不做方向效果的追踪/度量（先跑起来，有数据再议）。

## 方案

### 设计判断（读码后定）

**人选通道走 plan-ruling 链路扩展，不走 review-proposal 正本。** 三条理由：

1. review-proposal 发卡固定 #系统 频道；方向选择必须落在 plan WU 所在频道线程，
   人脱离 plan 上下文无法判断方向。
2. review-proposal 语义是异步 approve/reject 墓碑终态的审批闸（提案与工单解耦），
   无挂起/同会话复活语义；方向选择本质是 NEED_INPUT 人答交互，与 RULING 同构。
3. ADR「新提案类型必须走正本」约束的是 approve/reject 型**提案**；方向选择不是提案，
   是会话内问答，#467 裁决轮已为先例（同为结构化人答，同样未走 review-proposal）。

review-proposal 与 ruling 通道的语义冲突是真冲突（no_conflict_blending：选人答通道，
review-proposal 维持提案闸定位，不泛化）。

### P1：契约 + 解析 + 落档（后端，独立可交付）

契约变更（`prompt-composer.ts` CONTRACT_TEMPLATES.plan，插在裁决轮段之前）：

```
方向锁定（存在互斥大方向时出一次，在裁决轮之前）：输出
  ACTION: NEED_INPUT:方向锁定——请选定本票方向
  紧随一行 DIRECTION: {"question":"<方向抉择点>","options":[{"name":"<方向名>","summary":"<一句话>","tradeoffs":"<取舍说明>","impact":"<影响面：触及哪些模块/票>","recommended":true|false}]}
  候选 2~3 个（至多 4），recommended 恰好一个；人选定后同一会话继续，方向结论落探路台账。
无互斥方向（只有一条合理路径）或小需求快道：不出方向锁定，直接进裁决轮/成文拆单。
```

- parser：`agent-loop-parsers.ts` 加 parseDirectionLine——DIRECTION 行紧随 NEED_INPUT
  （与 OPTIONS/RULING 共存，同区解析）；防御口径同 RULING：JSON 损坏静默跳过、
  options 2..4 条、字段截断（500 字符）、recommended 恰好一个否则置 false 取首条。
- `agent-loop.types.ts` StepResult 加 `directions`；`agent-loop.ts` need_input 路径：
  directions 存在 → `metadata.planDirections` 落档 + `waitingReason='plan-direction'` +
  里程碑消息 `meta.cardType='plan_direction'`。
- 本阶段落地后，人可经频道自由文本回复方向（通用复活路径现成），不阻断。

触及：`agents/loop/prompt-composer.ts`、`agent-loop-parsers.ts`、`agent-loop.types.ts`、
`agent-loop.ts`、`workunit/wu-metadata.ts`（类型）+ 各自测试（先行 RED）。

### P2：提交链（后端，独立可交付）

仿 `pmo/plan-ruling.ts` 新建 `pmo/plan-direction.ts`：

- `validateDirectionPick(raw)`：`{choice: <方向名>, note?: <补充说明>}`，choice 必须在
  planDirections.options 内（路由 400/404/409 映射同 ruling 路由）。
- `applyPlanDirection(wuId, pick)`：
  1. 落账（有 pmoId 时，同 projectId 串行化）：`map.decisions[]` 追加
     `{ wuId, summary: "方向：<name>——<summary>（人锁定）", resolvedAt }`；幂等：
     同 wuId 同结论不双写。方向抉择点若对应 fog 条目 → 置 resolved（缺失不补建，
     方向题不一定来自 fog）。
  2. 清 `waitingReason/planDirections`，composeDirectionReply（选定方向 + 推荐与否 +
     note）经 resumeWaitingWorkUnit 注入 pendingReplies 同会话复活。
  3. 频道里程碑双出声（照 ruling 先例）。
- 路由：`workunit/workunit.routes.ts` 加 `POST /:id/direction`（human-only，同 ruling）。

触及：`pmo/plan-direction.ts`（新）、`workunit/workunit.routes.ts` + 测试
（落账/幂等/非 blocked 409/无 planDirections 409/复活注入）。

### P3：前端卡（独立可交付）

- `PlanDirectionCard`（新，仿 PlanRulingCard）：接力卡显示抉择点 + 候选数 + 推荐方向名。
- `PlanDirectionDialog`（新）：候选方向卡片并排（2-3 列），每卡显示 name/summary/
  tradeoffs/impact，推荐卡带徽标；单选 + 可选补充说明；提交按钮动态标签
  「锁定推荐方向」/「锁定所选方向」；次按钮「都不合适」→ 转自由文本回复
  （走通用复活路径，agent 收文本后重出方向或直接裁决轮）。
- 接线：ChannelMessageItem `case 'plan_direction'`、抽屉/BlockedActions
  `waitingReason==='plan-direction'` 分支（照 plan-ruling 先例）。

触及：web `components/channel/PlanDirectionCard.tsx`、`components/pmo/PlanDirectionDialog.tsx`、
`ChannelMessageItem.tsx`、`BlockedActions.tsx`、`api/workunit.ts` + 测试。

### P4：超时豁免（依开放问题 3 拍板，可独立不做）

若拍板豁免：`autoAbandonStaleBlocked` 对 `waitingReason ∈ {'plan-direction','plan-ruling'}`
的 plan 挂起跳过 24h 自动关闭（decision/spec 豁免先例：#108「可能等关键人多天」）。
30 分钟提醒保持不变（blocked 全覆盖现成机制，零改动）。
触及：timeout-release/workunit.service 死信扫描处 + 测试。

### 开关策略

- **默认规则挂契约文案**（同「无 FOG 不进裁决轮」先例，机制零改动）：存在互斥大方向
  才出方向锁定；无互斥方向、小需求快道不出。大票/小票之分由 agent 按澄清结果自律。
- **显式关闭挂 WU metadata**：派单时 `metadata.directionPick: false` → 契约段提示
  「本单已关闭方向锁定」（prompt-composer 按 metadata 裁剪契约段，INSPECTION_CONTRACT
  变体先例）。默认不设频道级配置（YAGNI：尚无频道差异化需求证据）。

## 验收标准 AC

- AC1：契约文本含方向锁定段（DIRECTION 协议行、候选 2~4、recommended 恰好一个、
  快道豁免条款），无互斥方向时 agent 不出方向锁定。
- AC2：parseDirectionLine 单测覆盖：合法行解析、JSON 损坏跳过、options 越界
  （<2/>4）拒收、recommended 非恰好一个的归一、与 OPTIONS/RULING 行共存。
- AC3：DIRECTION 落档后 WU blocked + waitingReason='plan-direction' + 频道出现
  plan_direction 卡；此时频道自由文本回复仍可通用复活（fallback 不回归）。
- AC4：POST /:id/direction 选定后：map.decisions[] 落「方向：…」结论（幂等不双写）、
  挂起标记清除、同会话复活（sessionId 不变）且回复文本含选定方向、频道里程碑留痕。
- AC5：前端三态可验：推荐方向默认选中可改选、补充说明随提交注入、「都不合适」
  转自由文本路径。
- AC6：非 plan 类型 WU 契约/流程零改动（快照测试或契约 diff 证明）。
- AC7（P4 若做）：waitingReason='plan-direction'/'plan-ruling' 的 blocked plan 超过
  24h 不被自动关闭，30 分钟提醒照常。

## 风险与边界

- **agent 滥用方向锁定**：每票都出方向卡会变成新的人闸负担。契约「存在互斥大方向才出」
  是软约束；先上线观察，滥发再考虑硬闸（如每 plan 限一次）。
- **方向与裁决轮重复**：方向锁定后仍可能有细节待决走 RULING，人操作两次。缓解：
  契约注明方向锁定只问方向，细节留给裁决轮；方向卡不打回到方向以下颗粒度。
- **24h 死信**（P4 未做时）：方向卡挂 24h plan 被自动关闭（#467 裁决轮同病）。
  缓解：30 分钟提醒已覆盖；真发生了人重新派发，成本可接受——故 P4 独立可裁。
- **与 OPTIONS 卡的分工**：OPTIONS（#279）是纯点选无落账；方向锁定要落台账 +
  展示取舍长文，OPTIONS 卡（label+description 两行）承载不了，故新卡不复用。

## 不做清单

- 不动 RULING 裁决轮协议与 PlanRulingDialog。
- 不泛化 review-proposal（不加 direction-select adapter，不改发卡频道）。
- 不做频道级/全局开关配置，不做方向效果度量。
- 不动其他 WU 类型契约；不动旧链 decision-resolution/spec-materialization。

## 开放问题（待拍板）

1. **通道归属**：扩 plan-ruling 人答链路（推荐，理由见设计判断）vs review-proposal
   新增 direction-select adapter。若选后者需先改发卡频道机制，成本高且语义不合。
2. **方向锁定与裁决轮的关系**：前置独立环节（推荐：先方向后细节，两次人闸但各问
   各的）vs 并入裁决轮（方向作为特殊 RULING 题）。并入省一次人闸但混了颗粒度。
3. **24h 死信**：方向/裁决挂起的 plan 豁免自动关闭（推荐，decision/spec 先例「可能等
   关键人多天」；P4 落地）vs 维持现状 24h 自动关闭（P4 不做）。
4. **候选数**：2-3 硬上限（背景口径）vs 允许 4（方案按 2..4 解析、契约写 2~3 推荐）。
5. **推荐标记**：强制恰好一个 recommended（推荐：人无主见时一键采纳，方向卡始终
   有默认推荐位）vs 允许全不推荐。

## 实施时核查项

- PlanRulingCard/PlanRulingDialog 前端组件的确切 props 与抽屉 autoRuling 透传链
  （本文只核到后端与路由，前端组件未逐行读）。
- autoAbandonStaleBlocked 的确切落点与豁免判定代码位置（CONTEXT.md 记述
  decision/spec 豁免，P4 实施时定位）。
- waitingReason 词表登记处（wu-metadata/workunit.types 注释口径）需同步加
  'plan-direction'。
