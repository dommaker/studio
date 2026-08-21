# apps/api/src/modules/distill

### 职责

蒸馏主链路：WU done 钩子跑门槛检测（纯确定性计数，零 LLM）-> 命中发 `distill_proposal` 卡到 #系统 -> approve 后 system-executor 执行蒸馏 -> 产物入库 + 原料 `maturity=archived` -> 运行记录 + 事件写 `studio-events.jsonl`。

GC 候选清单：蒸馏运行后按周期计龄--reference/context 层连续 3 周期 `lastReferenced` 未更新 -> `gc_proposal` 卡；approve -> archived（可恢复）；reject -> 不再提案。manual 过审享 3 周期豁免；主区 >200 强制。不读墙钟。

产物三分落地：蒸馏 LLM 产出自带类型分类--skill -> skills 库提案；constraint -> `constraint-drafts.jsonl`（status=pending）；preference/execution-knowledge -> 角色记忆草稿。缺/未知类型或落地失败 -> 回落知识库条目。产物都带原料指针。

存量约束审计：蒸馏产出新约束 -> 审计 custom 约束，白名单闸门（target-gone / reintroduction-sealed）-> `constraint_audit_proposal` 卡；approve -> retire（复用 applier `retireConstraintEntry`，原文保留可恢复）；reject -> 零副作用。不阻塞蒸馏。

### 核心导出

- `distill-threshold.ts` -- 门槛检测纯函数 + 阈值常量（3/5/7/20）
- `distill-service.ts` -- 编排（subscribe/maybePropose/approve/reject）+ prompt + 产出解析 + GC/审计方法
- `distill-landings.ts` -- 三通道落地实现：skills 提案 / 约束草案 / 角色记忆草稿
- `distill-store.ts` / `gc-store.ts` / `audit-store.ts` -- JSONL 持久化（墓碑折叠）
- `distill-proposal-card.ts` / `gc-proposal-card.ts` / `constraint-audit-card.ts` -- 三类提案卡发 #系统
- `gc-candidates.ts` -- GC 周期计龄纯函数 + 常量（3/200）
- `constraint-audit.ts` -- 审计纯函数 + prompt + 判据白名单闸门
- `distill-runtime.ts` -- 懒单例 + 启动订阅（唯一 import knowledge-singletons）
- `distill.routes.ts` -- approve/reject/status 路由（distill/gc/audit 三组）

### 依赖关系

**上游**: `@dommaker/harness`（FileKnowledgeStore）、`@dommaker/studio-shared`（FileStore/eventBus/studioPath）、`knowledge-singletons.ts`（仅 runtime）、`system-executor.ts` + `daily-token-budget.ts`、`channel-message.service.ts` + `studio-events.ts`、`evolution/applier.ts`（retireConstraintEntry）+ `harness/constraints.routes.ts`

**下游**: modules/skills 提案、modules/role-memory 草稿；GC；约束审计

### 运行时约定

- 人审闸门：LLM 批处理永远有人确认。pending 期间不重复发卡；发卡失败标记 `card-failed`（终态不阻塞）。
- 蒸馏即消费：approve 成功且产物 >=1 -> 原料 archived；空产出不消费。失败不阻塞（maybePropose 永不抛，失败推进熔断不推进消费基线）。
- 预算守卫：approve 时查 daily-token-budget；耗尽跳过，提案保持 pending。审计 LLM 同守卫。
- approve 非事务：崩溃可能留半成品（原料部分归档），重跑由新提案覆盖。
