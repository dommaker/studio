# Studio 工程级语言

跨模块共享的术语与约定。模块级上下文（职责/核心导出/注意事项）散置在各源码目录的 `CONTEXT.md`（#299 撤销 #152 归并，回归散置模型）。

## Language

**对账扫描**:
eventBus 一次性投递 + best-effort 断链的统一修复哲学（#66 ReviewDispatcher / #159 analysis-handoff，2026-08-15）：周期比对「应有 vs 实有」→ 幂等重跑自动补差集 → warning 事件走 #62 告警管线（频道不出声，非终态迁移）。配套幂等哨兵须清单化（记已建子单 id，重跑只补差集）；人工关闭的子单留在清单中，对账不复活。重跑记尝试数，3 次仍败停跑并升 critical。
_Avoid_: 只告警不自愈、按活体数比对复活人工关单、重试无上限

**大文件**:
超过 600 行软上限、触发「是否该拆分」审查的源码文件。审查看职责内聚度，不强制动刀——天然内聚的逻辑允许留在 600–800 行。拆分验收以单一职责为准，行数只是触发器。
_Avoid_: 超大文件、巨型文件、god file

**告警指纹 / 告警冷却**:
探针告警去重的成对机制（#218，2026-08-17；#220 实现修正）：指纹 = `source + subject`，定义「同一条告警」（subject 探针显式填——实例 id / 工具名 / 聚合固定值，回退 `relatedTaskIds[0]`，再回退 source 单车道；message 文本含周期变量，不作指纹）；冷却 = 同指纹 warning 4h / critical 1h 内四出口（事件流/频道/Triage/KnowledgeBus）只出声一次，级别升级立即再出声并重置计时，同级内容漂移压掉，降级不动作。聚合探针（failure_trend/池滞留/in_review 滞留）**并非**天然单车道——其 relatedTaskIds 首位随 churn 轮换会击穿冷却，#220 起显式填固定 subject（failure_trend/review_stagnation=`global`，pool_stagnation=桶 label 保持指名/未指名分车道），failure_trend 两级同 subject 升级重置才生效。恢复静默（无「已恢复」通知），状态为进程内存 Map 不落盘（FileStore 故障本身是告警条件，避免循环依赖），API 重启活跃条件一次性补发一轮为已接受代价。
_Avoid_: message hash 去重、显示侧折叠、恢复通知、冷却落盘、聚合探针拿 relatedTaskIds[0] 当指纹

**量纲保险丝**:
每日 token 预算熔断的语义定位（#216，2026-08-17）：防 token **量级**失控（急性大出血），不防精确成本。口径 = raw billed（input+output+cacheRead+cacheCreation 全量，不加权）——价格比（cache_read ≈ 全价 0.1x）本身是波动量（DeepSeek 2026-08 命中价上调 400%），揉进 token 单位即成不可解读的伪单位；安全阀不需要成本精度，最坏日成本由国产 API 低单价天然兜底。默认值 50M/日 = 目标承载（10 满会话/日 × 3M billed/50-turn 会话）× 安全系数 ~1.7。慢性失控（C3 型 ~34M/日连烧）不归它管，归趋势探针（#62）。
_Avoid_: 成本保险丝、加权口径、eq token

**分层塔**:
studio 存在理由的四层结构（#198，2026-08-16）：① 信任基座（监控/可视化/开销度量，「看得见」）→ ② 无人值守异步执行（「敢放手」：默认自主不用人盯，卡住/拿不准时频道喊人，人答完继续）→ ③ 知识飞轮（沉淀→蒸馏→注入，「越用越聪明」）→ ④ 进化（约束层蒸馏：系统从执行记录自提炼规矩并生效，「自己会进化」）。下层是上层前提；存在理由只锚塔顶两层（③④），①② 是必经路径——自身有现实价值（飞轮死而 studio 仍日用）但不构成存在理由。③④ 分界 = 规矩谁定：知识由人/agent 参考着用是③，系统自己定规矩并生效是④。派任务并入②，是执行的入口动作，不单列。
_Avoid_: 三件事并列、监控当目的层

**薄编排层**:
studio 能力边界面的表述（#201，2026-08-16）：与分层塔互补、各管一面——塔答「为什么存在」（价值分层，存在理由锚飞轮/进化），薄答「做多厚」：只做任务级编排，不复刻 agent CLI 能力（@文件/代码级交互/diff 预览等不做），不堆全功能平台。宪法落点 = vision-2026.md §2 能力边界（「Studio 不是什么」并入，随 §1 重写一并落）；§9 决策摘要 D1 行改为「塔定存在理由 + 薄定能力边界」两面表述，编号不动。
_Avoid_: 用薄替代塔、三件事并列、功能堆叠

**上下文边界**:
单份会话上下文的生命周期边界 = 指称连续性的容器（「上次/改一下这里」能解析到的工作范围），不绑定某个实现概念。当前实现中 = WU（含其线程讨论）；跨边界连续性由角色记忆文件与知识库承载，不由会话续用承载（#79，2026-08-10）。
_Avoid_: 会话边界、续用链

**现场把关 / 全局观测**:
harness 与 studio 的执法/观测分工（#82 D8 事实层裁决，#199 定宪法表述，2026-08-16）：harness 管现场把关——单步动作合规，当场拦截；studio 管全局观测——事件流、token 账本、熔断。不可互换：整体跑偏（如循环空转烧 token）只有全局观测看得见，单步违规（如凭证 diff）只有现场把关拦得住；物理依据 = studio 步内无进程内拦截点，harness 无跨项目车队视角。宪法落点 = vision-2026.md §1 分层塔信任基座旁，随 §1 重写一并落。
_Avoid_: 把熔断/记账塞进 harness、把 checker 塞进 studio 编排层

**token 账本（token ledger）**:
`workunit:tokens` 事件流的写侧累计派生索引（#320，2026-08-24 grilling 定稿）：事件流仍是唯一真源，账本可全量重放重建；per-WU 一行（冗余归属维度 rootId/profileId/triggerId + 全口径 token 字段照抄，读方各取所需、口径分叉不进账本），带 watermark（已入账事件偏移），读方发现落后即增量补扫自愈，账本不存在 = watermark=0 即懒回填；写侧在事件落盘点锁内 RMW（FileStore seam，docs/adr/2026-08-24-cache-seam-decision-rules.md 决策树第 1 问）。归属「全局观测」面，不做拦截。byDay 分桶等窗口查询支持待窗口型读方（/overhead）切换票再加——可重建性使加维度为零迁移操作。
_Avoid_: 账本当真源、单维度（per-tree）累计、口径统一混进账本、为分钟级写上写合并

**蒸馏**:
从沉淀知识中提炼可复用模式的函数——知识飞轮创造复利的核心环节，studio 存在的理由之一。沉淀只是积累，蒸馏让系统变聪明。产物按类型各有落地处：skill（过程性知识）→ skills 库；约束（边界性知识）→ 目标项目自己的 harness 约束实例（公共 harness 包只提供 schema/checker/retire 机器，内容不回填）；角色偏好与执行知识 → 角色记忆文件。触发形态按事件门槛理解（攒够新原料才点火），日历 cron 在原料不足时结构性空转（#80，2026-08-10）。闭环定稿：门槛=可蒸馏性信号（同 topic 新条目≥3 或 manual 过审≥5），矿石（session-summary 沉淀）蒸馏即归档，GC 按蒸馏周期计龄不打分，执行走收尾钩子检测+人审卡+system-executor（#83 D1-D5，2026-08-14）。主链路实现：`apps/api/src/modules/distill/`（#143，2026-08-15；门槛纯函数 + distill_proposal 人审卡 + approve 执行 + runs.jsonl 运行记录）。GC 候选清单同人模块（#144；连续 3 周期零引用 → gc_proposal 人审卡 → approve 归档可恢复，manual 3 周期新生豁免，主区 >200 强制出清单）。
_Avoid_: 知识合成、周报式合成

**注入预算**:
prompt 注入段的 token 定额，职责是防注入劣化（防注入段膨胀挤占对话空间、防噪声稀释信噪比），不是防 CLI 上下文溢出（溢出归反应式策略管）。形态为分段软定额 + 池内余量共享（#79，2026-08-10）。
_Avoid_: 2K 红线、截断保护

**三层存储**:
文档/状态归属的唯一裁决（#118 第三轮，2026-08-12）：流转态 → PMO（工单/地图/状态/依赖图的唯一系统）；项目私有冻结/缓变文档 → 业务仓 `.studio/`（入 git，唯一正本：`specs/`、`CONTEXT.md`、`memory/`、`research/`、`prototypes/`；**ADR 例外**：决策记录是工单无关永久导航件，归各仓 `docs/adr/`——2026-08-21 裁决，原 `.studio/adr/` 约定废止，library 聚合面适配完成（#305））；全局/跨项目 → `~/.studio/`（项目注册、跨项目知识库、配置日志）。两个读层：library = 阅览室（按项目路由聚合读，不写作正本），Monitoring 面板 = 运行读层。一个过程留痕：频道线程（讨论过程，不作正本）。归属冲突时按此裁决，不设第四存储。
_Avoid_: 多正本、library 落正本

**library（阅览室）**:
跨项目 `.studio/` 文档面（specs/、research/、CONTEXT.md）+ 各仓 `docs/adr/`（ADR 例外，#305 适配）的聚合只读层（#127 T5 / #155，2026-08-15）：缺省聚合全部有 gitRepo 的 PMO 项目，`?project=` 收窄，无写路径（变更历史 = git 历史），legacy-sdd 遗产打标记只读展示。旧称 **wiki**——凡历史文档/代码注释出现 wiki 即指 library。**概念面收敛 = 2**：library 读人写文档（业务仓 `.studio/`），knowledge 引擎管机器蒸馏知识（`~/.studio/knowledge/`），两者不混。
_Avoid_: wiki、文档中心、第三概念面

**documents / wiki（墓碑）**:
documents（document-store，#149 T11 退役）与 wiki（#155 改名 library）均已注销，不再作为概念使用：文档正本归业务仓 `.studio/`（library 只读聚合），机器知识归 knowledge 引擎。docs/ 仅为目录惯例，不构成概念。

**生效范围**:
文档落点的唯一判别轴（2026-08-21，docs/adr/2026-08-21-agent-docs-three-kinds.md）：内容对「任何 clone 这个仓的人」有效力 → 公共面，入库（AGENTS.md / docs/adr/）；只对「这台机器」有效力 → 本机面，gitignore（CLAUDE.md 薄身）。配套内容三分：**项目说明书**（结构/命令/模块索引，机器可再生）、**治理契约**（改仓必守的规矩，人写）、**本机运维簿**（本机部署/路径/事故史）——「入口文档」一词作废。
_Avoid_: 入口文档、治理锁本机、运维细节入库

**入口文档（墓碑）**:
旧称已作废（2026-08-21 内容三分，docs/adr/2026-08-21-agent-docs-three-kinds.md）：原指 CLAUDE.md / AGENTS.md 里混居的全部 agent 导读内容，拆为项目说明书 / 治理契约 / 本机运维簿，落点判别见「生效范围」词条。凡历史文档出现「入口文档」即指此旧称。

**工单绑定产物**:
有归属工单、随工单生灭归档的产物（2026-08-21，docs/adr/2026-08-21-agent-docs-placement-model.md）：spec 归需求工单（`.studio/specs/`）、research 归 analysis 工单（`.studio/research/`）、决策结论记于工单。判别反例 = ADR：决策单关闭后仍约束未来决策者，不随工单死，故不落 `.studio/`，归 `docs/adr/`。
_Avoid_: ADR 落 .studio/、产物无归属工单

**工单类型**:
工单的唯一分类词表（#118 第三轮，2026-08-12）：需求 / 决策单 / spec单 / 任务单 / implement / review / analysis。**增删类型 = 治理变更**，须先过治理流程（AGENTS.md「治理变更流程」节，#166）再改词表。操作载体 = PMO 工单类型字段（单一权威）；本条目是词表的文档化；GitHub label 仅 studio 自研特例，不构成第二平面（用户工程可能是任意 git 托管，流程信息零外泄，远端只见分支名/commit 指针）。agent 只见工单不见机制：类型决定默认方法论与产出契约（见 AGENTS.md 工单类型索引表），派单/解锁/打回等流转由机制承载。**类型认领属性（#126 T4，2026-08-15）**：扩范围类型（需求=feature / 任务单=task / spec单=spec）创建落「待确认」（pending），人工确认才进 frontier 可认领；圈内类型（implement / review / analysis / 决策单 / bug）创建即可认领——机制载体 = workunit.types.ts `PENDING_CONFIRM_TYPES` + `resolveInitialStatus`。**变体不增类型（#128 T6 / #130 T8）**：类型内的用途变体用显式 metadata 标记表达（原型单 `prototype: true`、巡检单 `inspection: true`），不隐式判定、不进词表。**触发器人闸（#130 T8，2026-08-15）**：无人在环的自动触发（定时/事件）模型调用单，建单显式 `status='pending'` 待人确认才执行（按来源不按类型，不动 PENDING_CONFIRM_TYPES；doc-semantic-review 自周五自动跑改为建单待人确认）。**WU 级 token 预算（#162 T8-E1，2026-08-15）**：任何类型工单可带显式 `metadata.tokenBudget` 数值上限，对照 `_cumulativeTokens`（billed 口径）超线即暂停待人三选（追加预算 / 现有产出收尾 / 放弃）；首个消费 = 巡检单。
_Avoid_: 自创类型、label 当词表载体、隐式判定变体

**频道相关工程**:
频道交互（@文件补全、文件引用渲染等）的候选工程集（#249，2026-08-19）= 频道默认工程 ∪ 本频道需求挂接 PMO 的全部工程 ∪ 杂务 PMO 工程，去重、频道内最近使用优先。性质 = UX 划界（收窄补全候选），**非安全边界**——安全边界在 agent CLI 权限层。其中「频道默认工程」自 #272（决策 #251 Q2'）起 = `channel.defaultPath`（本地 repo）；legacy `defaultWorkspaceId`（远程执行机器）解析根仍保留为候选来源。
_Avoid_: 全量扫描工程当候选、把候选集当权限边界

**默认工程 / 默认执行机器（分家）**:
「哪个 repo」与「在哪跑」是两个概念，术语自此分家（#251 Q2'，2026-08-19；#272 落地）：**默认工程** = 本地 repo 路径，落 `channel.defaultPath`，顶栏下拉数据源 = `/projects/discover` 本地工程发现（非 Admin 可用），归属链 rung 在文件引用之后、执行机器之前（`source=channel-default-path`）；**默认执行机器** = 远程 Workspace（`channel.defaultWorkspaceId`），Admin 概念，正名挪设置区（#286）。旧顶栏「默认工程」下拉绑的是 Workspace，系语义张冠李戴，已拆除。
_Avoid_: 用 defaultWorkspaceId 表达工程归属、顶栏混摆两个概念

**文件引用（频道）**:
频道消息里指向频道相关工程内文件的结构化轻引用（#249，2026-08-19）：只记「哪个工程 + 仓内路径」，agent 按需读文件本体；不含内容快照、无行范围。归属语义 = 用户显式指向的工程信号：全部引用同仓时参与工程归属（位于需求继承之后、频道默认工程之前），跨仓不参与、按只读预期。mention 仍是纯文本不结构化（#254 备查）。
_Avoid_: 附件/上传语义、内容快照、引用当权限授权

**事件负载契约**:
SSE 事件作为状态同步 interface 的设计规矩（2026-08-24，docs/adr/2026-08-24-sse-event-payload-contract.md）：凡事件必带 ①归属身份（channelId/聚合 id，答「归谁」）②就地更新所需的足量负载（答「变了什么」），消费端不得 REST 补拉；演进一律 additive（只加字段不改语义）；事件不回放，断线由消费端重连时一次性 refetch 对齐（同「对账扫描」哲学）。反例形态 = **门铃事件**：负载只够通知「有事发生」，每条事件撬起 N 个 REST 补拉，事件总线杠杆为负。
_Avoid_: 门铃事件、改现有字段语义、序号/校验回放机制

## 大文件治理

**拆分模式**: 整块原样抽出 + 原文件门面 re-export（导出面不变）+ 测试零改动；验收后按需对重模块定向回填直接单测，不要求每个抽出的轻模块/类型文件配同名测试。

**TDD 门禁豁免**: `.git/hooks/pre-commit` 的 TDD 段要求新增源文件配同名测试。纯移动拆分 commit 用 `PURE_MOVE=1 git commit ...` 豁免——仅跳过 TDD 段，credential 扫描 / plan 覆盖 / tsc-gate 仍执行。适用条件：整块抽出、门面 re-export、测试零改动，且 commit body 注明拆分来源文件。含任何新逻辑的代码不得使用（2026-08-04 立法；此前 8 个拆分 commit 以 HARNESS_NO_CHECK=1 临时覆盖落地，先例见 `0aca188b..edbddcdc`）。
