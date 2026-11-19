# #318 useWorkUnitEvents 剩余消费面负载直更

> 来源：issue #318（agent brief 为契约正本）+ 母计划 `2026-08-sse-event-payload-deepening.md` + ADR `2026-08-24-sse-event-payload-contract.md`（D1 负载契约 / D2 additive / D3 重连 refetch 不回放）。
> 本文 = 实现切批与取舍记录，随实现推进更新。

## 切批（每批独立 RED→GREEN + phase commit）

### 批 1：ExecutionSteps —— `workunit.execution.step` 负载 append（零字段缺口）

- 现状：`ExecutionSteps.tsx` eventTick 自增 → effect 重拉 `workunitApi.listExecutionStepEvents(workUnitId)`。
- 目标：SSE `workunit.execution.step` data 直接经 `parseExecutionStepEvents([{payload: msg.data}], workUnitId)` 解析，按 step 有序插入 + 去重；SSE 重连经 `onReconnect` 一次性 refetch 对齐（ADR D3）。REST 卡片落位后 live 区让位机制保留。
- 边界：Layer B（`useWorkUnitStreamEvents` 步内流式）不动。

### 批 2：WorkUnitListPage —— status_changed/created 负载驱动行更新

- 现状：`useWorkUnitEvents(() => loadWorkUnits())` 整页重拉（store `workunitStore.ts`）。
- 目标：`workunit.status_changed` 负载直替已有行；`workunit.created` 负载合成新行；与当前过滤不符的行就地移除。
- 缺口取舍：
  - `claimable`（仅列表项有、服务端计算）——additive 加入 `workunit.status_changed` 快照（后端 `snapshotToData` 出口处补，计算逻辑复用列表路由的依赖未了结判定）。
  - 分页 total/页边界无事件语义——**取舍 a：近似维护**。行插入/移除时本地 ±1 调整 total；页边界不追齐。本页无轮询兜底（list 页从未接过 useGatedPoll，评审修正措辞），自愈靠 SSE 重连 refetch、过滤切换/创建/审查等操作触发的 loadWorkUnits 与路由重进首拉。
  - **取舍 c（code-review Spec 轴补记）**：`status_changed` 未知行（不在当前页）即使新进当前过滤集也不插入——服务端过滤 + 分页下无法判定页内归属，插入会跨页重复；自愈路径同取舍 a。此缺口为服务端过滤固有，brief AC「行进出过滤集均由负载驱动」对「进集」只能覆盖「出」侧与本页内直替。

### 批 3：AgentDetailPage —— instance status_changed additive + wu 就地更新

- 现状：`useWorkUnitEvents(() => load(true))` 全量重拉约 5 接口。
- 目标：静态数据（profile、频道名）首拉；`agent.instance.status_changed` additive 补 `pmo` 快照与 `startedAt` 后就地更新实例状态（useAgentRoster 已有契约注释位）；`workunit.status_changed`（含 assigneeId/status/completedAt）就地更新历史任务已有行。
- 缺口取舍：历史任务「最近 20 条 + total」窗口——新完成 WU 进榜/窗口排序/total 计数无事件语义支撑，**取舍：保留事件驱动的低频重拉**（防抖窗口拉长，仅历史任务区一个接口，不再整页 5 接口）。记录于此与 CONTEXT.md。

### 批 4：收尾 —— hook 删除评估 + 文档沉淀（已完成）

- `useWorkUnitEvents` 评估结论：**删除**。三处迁完后生产消费方清零（CompanySection 仅注释提及、WorkUnitDrawer/WorkUnitDetailPage 测试仅 vestigial mock），hook 与其测试文件已删，测试 mock 清理（WorkUnitDrawer 的 onEvent 捕获改多订阅者广播——批 1 后内嵌 ExecutionSteps 也订阅，单 handler 覆盖导致决策 8 两例红，已修广播）。
- CONTEXT.md「SSE 负载消费约定·批 4」落 web 约定 + 两处取舍；api 侧 workunit（claimable 事件负载）/ agents（instance additive）/ monitoring（current-wu-context 共享出口）三处同步。
- 最终验证：`vitest run --changed origin/master` + typecheck。

## 测试 seam（已确认，2026-08-24 用户拍板）

1. ExecutionSteps 组件 seam：mock `onEvent` 注入 SSE 消息 + mock workunitApi，断言不重拉即出新步卡片、乱序/重复去重。
2. workunitStore seam：直接调 store 的负载处理方法，断言行直替/插入/移除/total 近似。
3. 后端负载 seam：`workunit.status_changed` 发射处快照含 `claimable`；`agent.instance.status_changed` 发射处含 `pmo`/`startedAt`。
4. useAgentRoster / AgentDetailPage seam：负载驱动就地更新，不再整页 load。
