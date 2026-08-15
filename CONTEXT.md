# Studio 工程级语言

跨模块共享的术语与约定。模块级上下文见各 `apps/api/src/modules/*/CONTEXT.md`。

## Language

**大文件**:
超过 600 行软上限、触发「是否该拆分」审查的源码文件。审查看职责内聚度，不强制动刀——天然内聚的逻辑允许留在 600–800 行。拆分验收以单一职责为准，行数只是触发器。
_Avoid_: 超大文件、巨型文件、god file

**上下文边界**:
单份会话上下文的生命周期边界 = 指称连续性的容器（「上次/改一下这里」能解析到的工作范围），不绑定某个实现概念。当前实现中 = WU（含其线程讨论）；跨边界连续性由角色记忆文件与知识库承载，不由会话续用承载（#79，2026-08-10）。
_Avoid_: 会话边界、续用链

**蒸馏**:
从沉淀知识中提炼可复用模式的函数——知识飞轮创造复利的核心环节，studio 存在的理由之一。沉淀只是积累，蒸馏让系统变聪明。产物按类型各有落地处：skill（过程性知识）→ skills 库；约束（边界性知识）→ 目标项目自己的 harness 约束实例（公共 harness 包只提供 schema/checker/retire 机器，内容不回填）；角色偏好与执行知识 → 角色记忆文件。触发形态按事件门槛理解（攒够新原料才点火），日历 cron 在原料不足时结构性空转（#80，2026-08-10）。闭环定稿：门槛=可蒸馏性信号（同 topic 新条目≥3 或 manual 过审≥5），矿石（session-summary 沉淀）蒸馏即归档，GC 按蒸馏周期计龄不打分，执行走收尾钩子检测+人审卡+system-executor（#83 D1-D5，2026-08-14）。主链路实现：`apps/api/src/modules/distill/`（#143，2026-08-15；门槛纯函数 + distill_proposal 人审卡 + approve 执行 + runs.jsonl 运行记录）。GC 候选清单同人模块（#144；连续 3 周期零引用 → gc_proposal 人审卡 → approve 归档可恢复，manual 3 周期新生豁免，主区 >200 强制出清单）。
_Avoid_: 知识合成、周报式合成

**注入预算**:
prompt 注入段的 token 定额，职责是防注入劣化（防注入段膨胀挤占对话空间、防噪声稀释信噪比），不是防 CLI 上下文溢出（溢出归反应式策略管）。形态为分段软定额 + 池内余量共享（#79，2026-08-10）。
_Avoid_: 2K 红线、截断保护

**三层存储**:
文档/状态归属的唯一裁决（#118 第三轮，2026-08-12）：流转态 → PMO（工单/地图/状态/依赖图的唯一系统）；项目私有冻结/缓变文档 → 业务仓 `.studio/`（入 git，唯一正本：`specs/`、`CONTEXT.md`、`adr/`、`memory/`、`research/`、`prototypes/`）；全局/跨项目 → `~/.studio/`（项目注册、跨项目知识库、配置日志）。两个读层：wiki = 阅览室（按项目路由聚合读，不写作正本），Monitoring 面板 = 运行读层。一个过程留痕：频道线程（讨论过程，不作正本）。归属冲突时按此裁决，不设第四存储。
_Avoid_: 多正本、wiki 落正本

**工单类型**:
工单的唯一分类词表（#118 第三轮，2026-08-12）：需求 / 决策单 / spec单 / 任务单 / implement / review / analysis。**增删类型 = 治理变更**，须先过治理流程再改词表。操作载体 = PMO 工单类型字段（单一权威）；本条目是词表的文档化；GitHub label 仅 studio 自研特例，不构成第二平面（用户工程可能是任意 git 托管，流程信息零外泄，远端只见分支名/commit 指针）。agent 只见工单不见机制：类型决定默认方法论与产出契约（见 CLAUDE.md 工单类型索引表），派单/解锁/打回等流转由机制承载。**类型认领属性（#126 T4，2026-08-15）**：扩范围类型（需求=feature / 任务单=task / spec单=spec）创建落「待确认」（pending），人工确认才进 frontier 可认领；圈内类型（implement / review / analysis / 决策单 / bug）创建即可认领——机制载体 = workunit.types.ts `PENDING_CONFIRM_TYPES` + `resolveInitialStatus`。**变体不增类型（#128 T6 / #130 T8）**：类型内的用途变体用显式 metadata 标记表达（原型单 `prototype: true`、巡检单 `inspection: true`），不隐式判定、不进词表。**触发器人闸（#130 T8，2026-08-15）**：无人在环的自动触发（定时/事件）模型调用单，建单显式 `status='pending'` 待人确认才执行（按来源不按类型，不动 PENDING_CONFIRM_TYPES；doc-semantic-review 自周五自动跑改为建单待人确认）。
_Avoid_: 自创类型、label 当词表载体、隐式判定变体

## 大文件治理

**拆分模式**: 整块原样抽出 + 原文件门面 re-export（导出面不变）+ 测试零改动；验收后按需对重模块定向回填直接单测，不要求每个抽出的轻模块/类型文件配同名测试。

**TDD 门禁豁免**: `.git/hooks/pre-commit` 的 TDD 段要求新增源文件配同名测试。纯移动拆分 commit 用 `PURE_MOVE=1 git commit ...` 豁免——仅跳过 TDD 段，credential 扫描 / plan 覆盖 / tsc-gate 仍执行。适用条件：整块抽出、门面 re-export、测试零改动，且 commit body 注明拆分来源文件。含任何新逻辑的代码不得使用（2026-08-04 立法；此前 8 个拆分 commit 以 HARNESS_NO_CHECK=1 临时覆盖落地，先例见 `0aca188b..edbddcdc`）。
