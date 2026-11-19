# WorkUnit 关闭单口 + 迁移类写路径统一落库尾部（#550）

来源：2026-09-15 架构评审候选 C2；依赖 #537/#538（均已 CLOSED）。

## 目标（票体 AC）

1. 所有关闭路径（手工 PATCH、24h 死信、2.5h 强杀、频道「关闭」指令、Web 关闭按钮、Discord abandon）经同一个状态机校验入口；wu-closure 直写快照不存在。
2. 系统关闭发布 `workunit.status_changed`（走统一尾部自然带出）。
3. `workunit:closed` 文件事件 payload 与频道说明行为不变（best-effort 语义保留）。
4. decision/spec 关闭仍被拒绝且有频道说明，守卫不依赖调用方手写查表。
5. 已 closed 的 WU 调 `close()` 幂等返回，不重复发事件。
6. transitionStatus / markMergeConflict / blockForManualRelease / blockForAllUnfit 共用扩展后的 persistSnapshot，不再各自手写 commitSnapshot + publish + aggregate 尾巴。
7. 不变式（closedAt/completedAt/blockedAt 落锚、事件发布、父聚合、reopen thaw）一处断言全路径生效。

## 设计

- `workunit.types.ts`：归置 `WORKUNIT_CLOSED_EVENT_TYPE`、`WorkUnitClosedBy`、`CloseWorkUnitOptions`（自 wu-closure.ts 迁入）。
- `workunit.service.ts`：
  - `persistSnapshot` 扩为唯一迁移尾部：status 覆盖 + completedAt（markCompleted）+ closedAt 落锚/清除规则 + reopen thaw + 父聚合（status ∈ active/blocked/done/closed 时 fire-and-forget）+ status_changed 发布。新增 `patch` 选项承载 assigneeId/claimedAt 清空（blockForManualRelease）。
  - 新增 `close(id, opts)`：已 closed → 幂等返回现状；状态机校验（resolveValidTransitions 含 closed，decision/spec 裁剪机天然拒绝）→ persistSnapshot(eventType=completed, status=closed, markCompleted) → workunit:closed 结构化事件（payload 不变：reason/closedBy/blockedAt?/closedAt，source=wu-closure，level=warning）→ 频道里程碑说明（message ?? reason，best-effort）。
  - transitionStatus / markMergeConflict / blockForManualRelease / blockForAllUnfit 迁入 persistSnapshot，各自只留策略（守卫、metadata、事件类型、expandRoutingHead 级联）。
- 调用方迁移：monitor-probes 两处、waiting-input closeOnHumanCommand、discord closeWorkUnit 改调 `close()`；删除 wu-closure.ts。
  - waiting-input 的手写 resolveValidTransitions 守卫删除：close() 抛 `Invalid status transition` 时发拒绝说明并返回 rejected-no-closed-state（行为保留）。
- Out of scope：状态机表不动；前端不动；#537/#538 的工作不重复。

## 步骤

1. 测试先行：新建 `workunit-close.test.ts`（close 行为：三件套 + status_changed + 幂等 + decision/spec 拒绝 + 父聚合）与 `workunit-migration-tail.test.ts`（不变式一处断言覆盖全部迁移路径）→ FAIL。
2. 实现 types + persistSnapshot 扩展 + close() + 四方法迁移 → GREEN；跑既有 workunit 测试防回归。
3. 调用方迁移 + 删 wu-closure.ts；改写 wu-closure.test.ts（删，由 workunit-close.test.ts 替代）、workunit-closedat.test.ts、discord routes.test.ts、monitor-probes.test.ts。
4. 全量受影响测试 + typecheck + lint。
5. 更新 workunit/CONTEXT.md（wu-closure 条目、写单口条目、closedAt 条目）。

## 验证

- `pnpm --filter @dommaker/studio-api test`（workunit / discord / agents monitor 相关套件）
- `pnpm typecheck`、`pnpm lint`
