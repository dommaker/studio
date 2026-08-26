# 人审提案卡生命周期收敛（review-proposal 模块）（2026-08-25）

> 来源：架构评审「studio 代码抽象与复用」（/tmp/architecture-review-20260825-204714.html 候选 1）
> 三轮 grilling 定稿；状态：**active**（随票 1 实施落地）。

## 背景

「pending 提案 → 发审核卡到 #系统 → 人审 approve/reject → 墓碑终态」这条生命周期没有统一实现：
distill 模块内部逐字复印 3 份（distill/GC/审计三胞胎：service 方法、store、proposal-card、routes
各三份），跨模块另有 role-memory、skills、knowledge、auditor 四份近亲变体，前端 5 张审批卡
再复印一遍（每卡约 60 行同构样板）。漂移已发生：状态词汇表三套并存（distill 含 `failed`，
GC 无 `failed`，role-memory 用 `promoted`）；前端「派生已审态」逻辑三种写法。每加一类审核卡
都在复制第 N+1 份。

## 决策

1. **唯一正本 = 新模块 `apps/api/src/modules/review-proposal`**。提案存取（append-only JSONL +
   状态墓碑折叠）、发卡（含 #系统频道解析与 `card-failed` 降级落墓碑）、approve/reject、状态查询
   全部收进该模块。不下沉 studio-shared（packages 无消费方，那是假想 seam）；不升格 distill
   现有实现（其余模块反向依赖蒸馏域，语义倒挂）。
2. **业务方只做 adapter**，向正本注册配置对象：`{ kind, store 命名空间, renderCardContent(proposal),
   onApprove(proposal), onReject?(proposal) }`。各拷贝间真正不同的只有「卡片内容」与「审批后动作」，
   其余全部归正本。
3. **状态词表唯一口径 = `pending | executed | rejected | failed | card-failed`**（distill 超集）。
   role-memory 的 `promoted` 与 `executed` 语义相同（approve 副作用执行成功），读取时归一为
   `executed`；历史 JSONL 行不改写（append-only 不重写历史，同「对账扫描」哲学）。
4. **HTTP 面 = 通用端点** `/api/review-proposals/:kind/:id/{approve,reject,status}`，`kind` 走
   注册表分发到对应 adapter 的副作用。各域不再保留专有审批端点（专有语义在 adapter 配置里表达）。
5. **前端合一**：单一 `ReviewProposalCard` 壳 + `useProposalReview(kind, id)` hook，5 张卡坍缩为
   「条目清单 + 文案」的纯数据配置。`useChannelCardActions` 的同构分支随之坍缩为参数化调用。
6. **卡片状态不实时推送**：保持「打开时查一次」。审批动作当前不发任何 SSE 事件，实时化需要新增
   事件类型 + 前端解析，归 SSE 契约层改造（架构评审候选 2）统一处理，届时本模块只发标准事件。
7. **测试策略**：正本配行为级测试（「建提案→发卡→approve→状态 executed」全链路，以 distill
   现有表现为基准）；distill 三胞胎接线后，直接测旧实现的测试随旧实现删除，删测试前出具新旧
   行为覆盖对照表（过 `no_test_simplification` 闸）。
8. **收敛节奏 = 正本先行、逐个接线**：票 1（#351）= 正本 + distill 三胞胎接线（最近验证场）；票 2（#352）=
   前端合一（依赖 #351）；role-memory / skills / knowledge / auditor 各一小票并行（#353–#356，依赖 #351）。
   中间态规矩：新提案类型必须走正本，禁止再抄第 N+1 份。

## 已排除的备选

- 基类继承（adapter 形态）：暴露面扩到方法级，引入实例化时序问题。
- 只共享工具函数、生命周期各域自持：正是现状的病根——工具被抄而不是被调。
- 一次性全收敛：单票横跨 7 个后端模块 + 前端，违反 `incremental_progress`。
- 各域保留专有路由作薄转发：同构样板从实现层挪到路由层，浅层没消失。
- 重写存量 JSONL 统一词汇：append-only 存储不动历史，一处读侧归一即可。
- 前端保留 5 张独立卡壳：卡间 diff 只剩条目与文案，留壳 = 留 5 份继续漂移的拷贝。

## 范围外

- `listChannels({name:'#系统'})` 全仓 21 处中，仅「提案发卡」用途收进正本；告警管线等其余用途不动。
- 卡片状态实时推送（见决策 6）。
