# agent 不可见编排信息（2026-09-22）

> 来源：#616 裁决（治理人闸 2026-09-22 当场通过）；状态：**active**。

## 条文（中版边界）

agent 拿到的所有东西——prompt、工具的输入输出、行协议——里面不出现编排信息：
看不到分支名，不知道自己在流水线第几环、前面后面还有谁。这些信息只留在编排器
（studio）一侧：agent 不需要知道，也不许让它知道。

边界：只管 agent 可见面，不扩张到 agent 产出物纪律（产出物里写什么由别的规矩管）。

## 背景（上下文链）

- 源头：2026-05-23 解耦决策——原约束 `agent_topology_agnostic`（原
  `.harness/custom-constraints.yml`）：Agent 接口不假设分支拓扑，diff/merge 用参数化
  refs（知识库归档 `process-batch_progress_2026_05_23.md` B6）。
- 该约束的保护对象 ReviewAgent / DeployAgent 已于 2026-08-06 随架构删除。
- #586 裁决「迁移知识层 / ADR」；#603 + harness ADR-0029 关停文本注入层后，原样迁移
  不可行。
- #616 改判：原则按新架构实况重写为本 ADR（单落点）；知识条目、agents CONTEXT.md
  落点明示取消。

## 后果

- 本 ADR 是该原则的唯一正本，知识层不再单独承载该条目（腐蚀死条目
  `guideline-rule-guideline_agent_topology_agnostic` 已随 #618 删除）。
- 若未来 agent 可见面出现编排信息泄漏（分支名、流水线位置进入 prompt / 工具输出），
  按本 ADR 判违规。
