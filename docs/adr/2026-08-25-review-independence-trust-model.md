# review 独立性与信任模型决策冻结（2026-08-25）

> 来源：#338；推导过程与实施记录见 `docs/plans/2026-07-28-builtin-roles-trust-model-analysis.md`
> （F4 / R2 / R3 / 决策 5 / 决策 10，2026-07-28 所有者逐项确认），本文只冻结结论，不复制推导。
> 状态：**accepted**（D1/D3 已随 F4/R3 落地，commit `54799423` / `8a8c84bf`；D4 的 provider 偏好约束未实施，为优化项）。

## 背景

review 架构的这组承重决策此前只活在 plans 过程文档与代码注释（review-dispatcher、agent-loop）
里，每个问「要不要独立 reviewer」的后来者都要重新挖一遍推导。按三层存储裁决，约束未来决策
者的内容归 ADR，故冻结于此。plans 文档保留为推导出处，本 ADR 引用它而非吸收它。

## 决策

### D1 review 独立性三机制

评审独立性由三层机制保障，缺一不可：

1. **独立会话**：评审 = 独立评审子 WU = 独立 CLI session，上下文隔离天然获得，不依赖纪律。
2. **excludeAssignee 排除实现者**：评审子 WU 建为 `unassigned + type='review'`，WU 上挂
   `excludeAssignee=<实现者>` 约束走认领涌现；agent-loop observe 侧做排除过滤。找不到合格
   认领者不再静默——发频道提醒。
3. **diff-only 输入契约**：评审子 WU 的输入只有 diff + `+code-review` skill 点名，不给实现
   叙述；上下文地图失效时 verdict=needs-info → 转人工，不猜不硬判；`metadata.reviewInput`
   落档备查。

### D2 角色身份不承重（决策 10）

认领纯涌现：unassigned WU 由频道空闲成员认领，**不过滤类型**。`acceptedTypes` 取 profile
显式字段（决策 9），description 关键词解析已退役。评审不再锚定 "reviewer" 角色名或描述
子串——约束挂在活（WU）上，不挂在角色上。内置三角色的 seed 逻辑已随之删除，角色模板走
`.agents/roles/*.yaml` preset。

### D3 自评兜底 + 双升级（决策 5）

单角色频道（排除实现者后无人可领评审 WU）的评审策略：

- 衔接顺序定死：先排除实现者建 WU → 若频道内除实现者外无其他 active 成员 → 不加排除约束、
  `metadata.selfReview=true`、仍发频道提醒（提醒给人看，自评保流转，二者不冲突）。
- 默认自评并标记 `self-review`，人类待办查询（`done ∧ ¬l3`）天然捞出。
- 双升级路径：频道可配评审 provider 偏好，或强制人工；self-review 率进指标。

### D4 独立 profile 唯一增量 = 换 provider（R2）

独立 reviewer profile 唯一真正买到的是「换个模型/provider 审」（判断多样性）。解锚后该
能力由评审 WU 上的 provider 偏好约束承载（约束在活上），否则单 profile 频道退化为同模型
自评。**实施状态：未落地**，决策 5 已留频道配置方向，为优化项。

## 后果

- 后来者评估「要不要独立 reviewer」时以本 ADR 为准；推导细节回 plans 文档。
- 任何弱化 D1 三机制、恢复角色锚点、或取消自评标记的改动 = 治理变更，需先过决策再动手。
