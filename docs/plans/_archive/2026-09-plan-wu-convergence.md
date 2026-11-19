# #471 派生链收敛：analysis/decision/spec → 单 plan WU 一脉会话

来源：#471 票体 + 两条 Triage 定稿评论（2026-09-09）；形态对齐 #466/#467 票体「讨论定稿」节。
本票只做机制收敛；裁决轮人闸卡（#467）、路由表三档（#466）、role.skills 装牙（#462）各自有票，不在此实现。

## 验收标准（从票体与定稿评论逐条推导）

- AC1 publish 只建一张 `type='plan'` WU（不再建 analysis）；scope 首行钉 `+requirement-clarify +to-tickets`（review-dispatcher `+code-review` 先例）；一脉会话契约文案（澄清→fog 调研→裁决→spec 成文→拆任务清单）；多腿段保留。
- AC2 plan WU 单独额度：步数 PLAN_STEP_LIMIT=60（> implement 15 / review 30），到线 → need_input 挂 blocked 转人（waitingReason='plan-step-limit'），不静默截断、不强制收口 in_review；人回复即续期（allowance += 60 复活回 active）。token：publish 落 metadata.tokenBudget（env STUDIO_PLAN_TOKEN_BUDGET，默认 1_000_000），超限走既有 wu-token-budget 三选熔断。
- AC3 会话连续性：MAX_SESSIONS_PER_WU=5 维持不变——「按人闸续期」已成立（续用路径不吃上限，人回复复活后续用旧会话）；plan 不再调宽。
- AC4 fog 台账保留：plan done（人工确认）且确认文本含 FOG → map-opening 初始化 project.map 台账（destination+fog[]），**不再逐条建 decision WU**；map 段注入（prompt-composer buildPmoMapSection，按 metadata.pmoId 类型无关）使新会话以台账（已裁决结论+未决项）为输入续跑——台账=唯一恢复事实源，零新代码。
- AC5 spec/tasks 落档：plan COMPLETE 时 agent-loop 解析 TASK:/FOG:/DESTINATION: 行落 metadata.analysisTasks/analysisFog/analysisDestination（沿用 analysis 字段名=解析契约单一来源不变）；人工确认走 #463 结构化表单（confirm kind 'plan'，形状同 analysis）；确认后 analysis-handoff 按 TASK 派工（task 子 WU 派生不变）。
- AC6 decision-resolution / spec-materialization 不删代码：存量在飞链继续服务；新链不再产生 decision/spec WU = 自然退役。map-opening 降级为台账记录（建单循环删除）。
- AC7 plan 加入人工验收类豁免面：ReviewDispatcher 路径 A/B 不派自动评审、dispatchReviewNow 拒绝、suggestions isAutoReviewable=false、dispatch-reconciliation 不重派评审、evidence-summary L2 豁免、monitor-probes autoAbandonStaleBlocked 豁免、timeout-release 超时扫描豁免（等裁决可能多天）。plan **不进** PENDING_CONFIRM_TYPES（发布即可认领）、**不进** TYPE_VALID_TRANSITIONS 裁剪状态机（保留 closed——预算三选「放弃」需要）。
- AC8 derivationPending 重写：① map 腿仅当 fog 含 wuId（旧链在飞）且 !specSpawnedAt 才 pending（新台账 fog.wuId 恒 null 不阻断）；② analysis→plan 哨兵判定；③ spec 腿不动（存量）。
- AC9 词表/展示：WU_TYPE_LABELS 加 plan；MCP createWorkUnit enum 加 plan；CONTRACT_TEMPLATES 加 plan 契约段（TASK/FOG 输出协议）。
- AC10 Web：WuGateActions plan 走结构化确认弹窗（复用 AnalysisApproveDialog，confirm kind 'plan'）；DeliveryPanel plan 缺口走弹窗；ChannelDetailPage GATE_WU_TYPES 加 plan（人工闸类不进 NEED_INPUT chip）；ReviewConfirmPayload 加 plan variant。
- AC11 skill 索引去重：selectSkillsForInjection 已按 name 去重（核实为现状，无需改）；plan 钉的两个 skill 经 parseSkillHintsFromScope 既有管线注入。
- AC12 日报表可见性：token 聚合均不按 wu.type 分维度（按 profile/树/WU/天）——plan 消耗经同一归因链自然可见，不加新聚合面（在 resolution 中说明判定）。

## 存量兼容

- 巡检单（default-triggers, metadata.inspection）保持 type='analysis' 不动；analysis-handoff 入口同时吃 analysis+plan（inspection 分支天然只命中 analysis）。
- 存量在飞 analysis/decision/spec WU：所有既有处理器保留，链跑到完。
- 存量 map（fog 带 wuId 的旧链）：derivationPending ① 继续阻断至 specSpawnedAt。

## 实施批次

1. api 核心：workunit.types.ts（PLAN_STEP_LIMIT）、publish、agent-loop（COMPLETE plan 解析 + 步数守卫 + force-close 跳过）、waiting-input（plan-step-limit 续期）、analysis-handoff、map-opening、progress-rollup、review-dispatcher/suggestions/dispatch-reconciliation/evidence-summary/monitor-probes/timeout-release 豁免、confirm-payload、prompt-composer 契约、wu-display、MCP enum。
2. web：WuGateActions / AnalysisApproveDialog kind / DeliveryPanel / ChannelDetailPage / api/workunit.ts。
3. 测试随各批 TDD；CONTEXT.md 同步（pmo、agents、workunit）。
