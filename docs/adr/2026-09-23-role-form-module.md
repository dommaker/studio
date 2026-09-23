# 角色表单合一与编辑面补全（2026-09-23）

> 来源：架构评审「角色域」候选 1（2026-09-23）grilling 定案。
> 状态：**accepted**（已落地，#630）。

## 背景

「角色」的创建/编辑界面散在三个弹框里，各管一段、字段高度重叠：

- `CreateRoleModal`（手动创建）：多 CLI 批量勾选创建，provider 清单走组件内联拉取 + 内联去重（`useDetectedProviders` 的退化版）；中途失败已建的不回滚。
- `FirstRoleSetupModal`（首用引导）：provider 走 `useDetectedProviders`（信息最全，含「未登录」徽标），创建后接「加入频道」两步流，创建失败静默关窗。
- `StudioRoleSetupModal`：只补 studio 角色的 provider。

编辑面残缺且不对称：服务端 `PATCH /agent-profiles/:id` 支持 name/description/provider/status/skills，UI 只暴露 skills（RoleSkillsModal）一处；角色建错名字只能删了重建。RoleCard 卡面零操作位（#397 §6.1 当时决议），任何修改意图都要离开列表上下文。

两个与本轮决策相关的运行时事实：

- **provider 变更不发事件**：`AgentProfileService.update` 只在 status 迁移时发布 `agent-profile.updated`；`AgentLoop` 吃构造期 profile 快照，改 provider 后已挂载 loop 继续用旧 CLI，直到进程重启或 status 切非 active 再切回。
- **删除能力服务端早已完整**（清频道成员与路由指名、卸载 loop），但 UI 无入口；「停用」反之——UI 画得出「已停用」状态，却没有任何入口能把角色停用。

## 决策

1. **表单芯合一，壳保留**。新模块 `components/monitoring/RoleFormModal.tsx` 承载表单域全部逻辑：provider 候选（唯一来源 = `useDetectedProviders`）、校验、提交、错误行、pending 锁存。界面 = `{ mode: 'create' | 'edit', lockProvider?, initial?, onSaved }`。CreateRoleModal / FirstRoleSetupModal / StudioRoleSetupModal 三个壳保留各自语境（自动触发、dismiss、加入频道两步流），壳内表单全部换成该模块；FirstRoleSetupModal 的失败语义归一为正本「内联报错留窗」，不再静默关窗。
2. **创建收窄为单角色**：一个 name + 一个 provider Select（`useDetectedProviders` + `buildProviderOptions` 链路，未检测到的内置 CLI 列禁用项、auth=failed 带「⚠ 未登录」徽标）。多 CLI 批量勾选形态删除（生产数据中全部角色同 provider，批量从未被真实使用，且部分创建不回滚是半成品缺陷）。
3. **编辑模式暴露 name / description / provider 三项**。skills 不进表单——RoleSkillsModal 是技能编辑正本，同一字段不设第二入口。name 唯一性维持服务端 409 内联报错。编辑 provider 时表单内 inline 提示「正在运行的实例将在重启或停用再启用后使用新 CLI」（对应背景事实一）；provider 变更即刻生效（发事件 + registry 重挂）列为独立 follow-up 票，不在本轮。
4. **不做停用/启用入口**。唯一说得通的场景（让角色停接新活但留配置）实践中可由删除+重建覆盖；闲置角色本身零成本。UI 的「已停用」展示层保留（兼容存量数据）。
5. **做删除入口**。删除确认框列出该角色在途任务（标题 + 状态词 + 所属 PMO 项目名，无归属显示「未归属」，点击跳任务详情），有在途任务允许删除但警告「这些任务会中断，等待系统自动回收」。历史任务认领展示有 assigneeRoleId 快照兜底，不受影响。
6. **编辑入口落两处**：AgentDetailPage 右栏新增「资料」卡（沿用「技能」卡头 + 按钮模式）；RoleCard 卡头加悬停 ⋯ 菜单（编辑资料 / 编辑技能 / 删除），菜单行形态复用 ChannelTopbarMenu 的类名体系。**本条修订 #397 redesign §6.1「卡面无操作位」决议**——该决议制定时没有任何编辑能力可放，如今能力齐备，操作位以悬停 ⋯ 的克制形态落地。
7. **后端过滤口径修正（决策 5 的依赖）**：`GET /workunits?assigneeId=` 的过滤扩为「assigneeId 或 assigneeRoleId 任一命中」。claim 会把 assigneeId 改写为实例 id（认领快照留在 assigneeRoleId），只认 assigneeId 恰好漏掉正在执行的那批——删除确认框的在途清单依赖修正后的口径。

## 否决的备选（勿再提）

- **连壳合一**（一个 Modal 四种 mode 切首用/管理/补配/编辑）：壳的差异是产品语境不是重复代码，合一后一个模块背四套互斥生命周期，界面反而变宽。
- **保留批量多选创建**：无人使用的形态，删掉；未来多 CLI 场景再议。
- **编辑模式不收 provider**：会把「CLI 选错只能删了重建」的痛点留在原地。
- **provider 变更本轮顺带修后端**：动 loop 生命周期是另一个硬度的票，本轮范围是表单合一。
- **删除时禁删有在途任务的角色**：系统已有租约过期 + 对账回收兜底，禁删把人卡在手动收拾任务上。
- **skills 并入统一表单**：RoleSkillsModal 的候选合并逻辑（MANIFEST + 防静默丢声明）是独立深度，不值得揉进通用表单。

## 落点清单

- 新增 `apps/web/src/components/monitoring/RoleFormModal.tsx`（唯一正本）+ 同名测试。
- 改造 `CreateRoleModal.tsx` / `FirstRoleSetupModal.tsx` / `StudioRoleSetupModal.tsx` 为壳（表单段换正本）。
- `AgentDetailPage.tsx` 右栏「资料」卡；`RoleCard.tsx` 悬停 ⋯ 菜单。
- `apps/api/src/modules/workunit/workunit.service.ts` assigneeId 过滤口径扩展 + 测试。
- `apps/web/src/api/channel.ts` 补 `deleteAgent`（DELETE /agent-profiles/:id 既有端点的客户端封装）。
- 样式：RoleCard 菜单样式入 `styles/agent-dashboard.css`（agd-* 族）；表单类走全局类/既有表单类，不新增页面级 CSS 依赖。
