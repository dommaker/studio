---
name: research
description: "analysis 工单调研方法论：针对待决问题查高可信一手来源（官方文档/源码/spec/一方 API，不抄二手转述），调研报告落业务仓 .studio/research/ 并回挂来源工单链接。阅读外包给后台 agent，主会话继续推进。不用于需求澄清（用 requirement-clarify）、结论沉淀进 CONTEXT（用 exploration-sediment）、纸面裁不动的设计问题（用 prototype）。"
agentTypes: [analysis]
triggers: [调研, 查一下, 研究, research, 调查, 资料收集, 文档调研, API 调研, 一手来源]
status: published
---

# 调研（analysis 工单方法论）

蓝本 matt 同名 skill；产出契约改指系统载体（T3/#125）。适用场景：analysis 工单的待决问题依赖**仓外知识**——第三方文档、API 事实、外部系统行为。仓内代码探索不走本 skill（直接 explore，结论沉淀走 exploration-sediment）。

## 方法

起一个**后台 agent** 做调研，主会话继续推进其他事——阅读外包，不占主会话上下文。

后台 agent 的职责：

1. 对着**一手来源**查证——官方文档、源码、spec、一方 API——不引用二手转述。每个论断回溯到拥有它的来源。
2. 结论写成一份 Markdown 调研报告，每条论断标注来源链接。
3. 报告落**业务仓 `.studio/research/`**（入 git，项目私有冻结文档正本之一，三层存储归属裁决 T1/#122）。文件名按主题命名，如 `.studio/research/<主题>.md`。

## 产出契约

- 报告落 `.studio/research/` 后，在**来源工单**回挂报告链接（评论一行：结论 gist + 报告路径）。
- 本 skill 产报告，不产决策——决策回到来源工单上走（决策单 → grilling）。
- 后续 analysis 工单经 `blocked_by` 挂进工单图依赖本调研时，引用的是报告路径，不是会话记录。

## 约束

- token 预算熔断适用（T8 通用能力，#130）：调研 agent 受预算约束，耗尽即停并汇报已得结论与缺口，不无限深挖。
- 一次调研回答一个问题；问题发散时拆多张 analysis 工单，不做摊大饼式调研。
