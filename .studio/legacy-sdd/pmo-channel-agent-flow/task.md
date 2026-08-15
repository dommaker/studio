---
status: "done"
version: 1
---

# Task: PMO → Channel → Agent 流程串联

## 契约测试规划

### AC-1: Trigger EVENT 条件类型

| 测试文件 | 测试用例 |
|---------|---------|
| `trigger.types.test.ts`（或类型检查） | EVENT 条件对象类型正确 |
| | SCHEDULE 条件不受影响 |
| | TriggerCondition 联合类型 discriminated union 工作正常 |

**预估**：~20 行

### AC-2: TriggerScheduler EventBus 集成

| 测试文件 | 测试用例 |
|---------|---------|
| `__tests__/trigger-scheduler.test.ts`（已存在，扩展） | EVENT trigger 注册后，eventBus.publish 触发 executeTrigger |
| | filter 匹配成功 → 触发 |
| | filter 匹配失败 → 不触发 |
| | trigger disabled → 不触发 |
| | deregisterTrigger → 取消订阅，后续事件不触发 |
| | 多 trigger 订阅同一 event → 各自独立触发 |
| | dispose → 所有订阅清理 |
| | 现有 SCHEDULE 测试不受影响 |

**预估**：~120 行

### AC-3: AgentLoop EVENT trigger

| 测试文件 | 测试用例 |
|---------|---------|
| `__tests__/agent-loop.test.ts`（已存在，扩展） | start() 注册 workunit.created EVENT trigger |
| | 事件触发 → observe() 被调用 |
| | stop() 取消 trigger 注册 |
| | SCHEDULE 兜底 trigger 同时存在 |

**预估**：~80 行

### AC-4: WorkUnit 创建事件

| 测试文件 | 测试用例 |
|---------|---------|
| `__tests__/workunit-api.test.ts`（已存在，新增用例） | create() 后 eventBus 收到 workunit.created 事件 |
| | 事件 payload 包含 workunit 对象 |
| | create 返回值不变 |
| | eventBus.publish 异常不影响 create 返回 |

**预估**：~50 行

### AC-5: PMO Publish API

| 测试文件 | 测试用例 |
|---------|---------|
| `pmo/__tests__/publish.test.ts`（新建） | pending PMO publish → 创建 ChannelMessage + WorkUnit + 状态→active |
| | 非 pending PMO → 400 |
| | channelId 不存在 → 400 |
| | WorkUnit metadata 包含 pmold 和 pmoNumber |
| | ChannelMessage meta 包含 pmoId |

**预估**：~80 行

### AC-6: PMO UI 发布按钮

| 测试文件 | 测试用例 |
|---------|---------|
| PMOPage 组件测试 | pending 状态显示发布按钮 |
| | 非 pending 不显示 |
| | 点击发布 → API 调用 → 状态刷新 |

**预估**：~60 行（前端组件测试）

### AC-7: MCP createWorkUnit

| 测试文件 | 测试用例 |
|---------|---------|
| `mcp/__tests__/create-workunit.test.ts`（新建） | createWorkUnit handler 返回正确格式 |
| | type/scope 缺失 → 验证错误 |
| | tool 注册到 registry |

**预估**：~40 行

### AC-8: SDD frontmatter pmoNumber

无代码测试。验证：
- standard_sdd_format.md 包含 pmoNumber 字段定义
- task-planner skill 文件包含 pmoNumber 说明

**预估**：~0 行（文档检查）

### AC-9: SDD 索引生成器

| 测试文件 | 测试用例 |
|---------|---------|
| `index-generator.test.ts` | 扫描有 requirement.md 的目录 → 索引包含条目 |
| | 跳过无 requirement.md 的目录 |
| | 跳过 status: stale 的 SDD |
| | pmoNumber 为空 → 该列留空 |
| | tags 数组 → 逗号分隔字符串 |
| | 目录不存在 → 抛错 |
| | 输出文件 header 格式正确 |
| | slug 排序正确 |

**预估**：~100 行

### AC-10: PMO-SDD 关联查询

| 测试文件 | 测试用例 |
|---------|---------|
| `pmo/__tests__/sdd-query.test.ts`（新建） | 有匹配 SDD → 返回条目 |
| | 无匹配 → 空数组 |
| | 索引文件不存在 → 空数组 |
| | PMO 不存在 → 404 |

**预估**：~50 行

---

## 执行顺序

### Batch 1: 基础层（并行）

```
┌─ AC-1: trigger.types.ts         ─┐
├─ AC-4: workunit.service.ts      ├─→ 全部完成后进入 Batch 2
└─ AC-9: index-generator.ts + CLI ─┘
```

**改动文件**：
- `trigger.types.ts` — 新增 EVENT 类型（~10 行）
- `workunit.service.ts` — create() 加 eventBus.publish（~15 行）
- `harness/src/sdd/index-generator.ts` — 新建（~100 行）
- `harness/src/commands/sdd.ts` — 新建 CLI 命令（~30 行）
- `workunit-api.test.ts` — 新增 create() 事件发布用例（~50 行）

**checkpoint**: `npx tsc --noEmit` + `pnpm test` 通过

### Batch 2: TriggerScheduler（依赖 Batch 1）

```
AC-2: trigger-scheduler.ts + trigger-registry.ts + 测试
```

**改动文件**：
- `trigger-scheduler.ts` — 注入 EventBus + EVENT 处理（~60 行）
- `trigger-registry.ts` — 工厂函数传入 eventBus（~5 行）
- `__tests__/trigger-scheduler.test.ts` — 扩展 EVENT 条件测试（~120 行）

**checkpoint**: `npx tsc --noEmit` + `pnpm test` 通过

### Batch 3: AgentLoop + MCP（依赖 Batch 2）

```
┌─ AC-3: agent-loop.ts     ─┐
└─ AC-7: tools.ts           ─┘
```

**改动文件**：
- `agent-loop.ts` — 注册 EVENT trigger + handler（~50 行）
- `agent-loop.test.ts` — 扩展 EVENT trigger 测试（~80 行）
- `tools.ts` — 新增 createWorkUnit（~40 行）
- `mcp/__tests__/create-workunit.test.ts` — 新建测试（~40 行）

**checkpoint**: `npx tsc --noEmit` + `pnpm test` 通过

### Batch 4: PMO Publish + SDD 标准（依赖 Batch 3）

```
┌─ AC-5: PMO publish API          ─┐
└─ AC-8: SDD frontmatter 标准更新  ─┘
```

**改动文件**：
- `project.service.ts` — publish() 方法（~50 行）
- `routes.ts` — publish 路由（~20 行）
- `pmo/__tests__/publish.test.ts` — 新建测试（~80 行）
- `standard_sdd_format.md` — 加 pmoNumber 字段
- `task-planner.md` — Skill 支持 pmoNumber

**checkpoint**: `npx tsc --noEmit` + `pnpm test` 通过

### Batch 5: UI + 查询（依赖 Batch 4）

```
┌─ AC-6: PMO UI 发布按钮     ─┐
└─ AC-10: SDD 查询 API       ─┘
```

**改动文件**：
- `PMOPage.tsx` — 列表页发布按钮 + Channel 选择（~50 行）
- `routes.ts` — SDD 查询路由（~25 行）
- `pmo/__tests__/sdd-query.test.ts` — 新建测试（~50 行）

**checkpoint**: `npx tsc --noEmit` + `pnpm test` 通过

---

## 里程碑

| 里程碑 | 批次 | 验证标准 |
|--------|------|---------|
| M1: 事件基建 | Batch 1-2 | Trigger EVENT 注册+触发测试通过 |
| M2: Agent 事件驱动 | Batch 3 | AgentLoop workunit.created 事件触发 observe |
| M3: PMO 发布链路 | Batch 4 | PMO publish → ChannelMessage + WorkUnit 创建 |
| M4: 全链路完成 | Batch 5 | UI 发布 + SDD 索引 + 查询可用 |

## 总工作量

| 类别 | 预估代码行数 |
|------|------------|
| 实现代码 | ~450 行 |
| 测试代码 | ~640 行 |
| **总计** | **~1090 行** |
