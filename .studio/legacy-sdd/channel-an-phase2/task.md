---
status: done
version: "1.0"
---

# Channel × Agent Network Phase 2 — 任务文档

## 契约测试规划

### AC Group A：路由改进

#### AC-A1：@mention 绑定 assigneeId

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `message-routing.test.ts` | `@mention matched agent → WorkUnit.assigneeId = agent.id` | 契约 |
| `message-routing.test.ts` | `@mention no match → WorkUnit.assigneeId = null` | 契约 |
| `message-routing.test.ts` | `@mention agent inactive → assigneeId = null（不匹配 inactive）` | 边界 |
| `message-routing.test.ts` | `@mention agent active but busy（有 active WU）→ 仍绑定 assigneeId` | 边界 |

#### AC-A2：listAgents 过滤在线状态

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `agent-profile.service.test.ts` | `list() 返回结果包含 isOnline 字段` | 契约 |
| `agent-profile.service.test.ts` | `RuntimeInstance status=active → isOnline=true` | 契约 |
| `agent-profile.service.test.ts` | `无 RuntimeInstance → isOnline=false` | 契约 |
| `agent-profile.service.test.ts` | `RuntimeInstance status=idle → isOnline=false` | 边界 |
| `agent-profile.service.test.ts` | `list({ channelId }) 只返回 members 包含该 channel 的 Agent` | 契约 |
| `agent-profile.service.test.ts` | `list({ channelId }) 当 Channel.members=[] → 返回所有 active Agent` | 边界 |

### AC Group B：Channel 成员管理

#### AC-B1：Channel.members 字段

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `channel-members.test.ts` | `prisma validate 通过（schema 无错误）` | 冒烟 |
| `channel-members.test.ts` | `创建 Channel 默认 members = "[]"` | 契约 |
| `channel-members.test.ts` | `创建 Channel 带 members → 正确存储` | 契约 |

#### AC-B2：Channel 成员管理 API

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `channel-members.test.ts` | `PATCH add agent → members 包含该 agent` | 契约 |
| `channel-members.test.ts` | `PATCH remove agent → members 不包含该 agent` | 契约 |
| `channel-members.test.ts` | `PATCH add 已存在的 agent → 幂等（不重复）` | 边界 |
| `channel-members.test.ts` | `PATCH remove 不存在的 agent → 幂等（不报错）` | 边界 |
| `channel-members.test.ts` | `PATCH 空 body → members 不变` | 边界 |

#### AC-B3：Channel 创建时指定成员

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `channel-members.test.ts` | `POST /channels 带 members → members 正确` | 契约 |
| `channel-members.test.ts` | `POST /channels 不带 members → 默认 "[]"` | 边界 |

#### AC-B4：前端 @mention autocomplete 按 Channel 过滤

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| 手动测试 | 不同 Channel 输入 @ 看到不同 Agent 列表 | 手动 |
| 手动测试 | Channel members 为空 → 显示所有 Agent | 手动 |

### AC Group C：Thread 隔离

#### AC-C1：Thread-per-WorkUnit（锚点消息）

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `message-routing.test.ts` | `@mention 创建的消息：workUnitId 非空 && replyToId 为空（锚点）` | 契约 |
| `convert-to-task.test.ts` | `convert 后的消息：workUnitId 非空 && replyToId 为空（锚点）` | 契约 |

#### AC-C2：Agent 消息写入 Thread

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `agent-loop-v2.test.ts` | `postToDiscussionSpace → replyToId = 锚点消息 id` | 契约 |
| `agent-loop-v2.test.ts` | `WorkUnit 有多条消息 → 新消息 replyToId 指向第一条（锚点）` | 契约 |
| `agent-loop-v2.test.ts` | `WorkUnit 无锚点消息（不应发生）→ replyToId = null` | 边界 |

#### AC-C3：Thread 视图渲染

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| 手动测试 | 锚点消息显示为 Thread 头部 + 回复数量 badge | 手动 |
| 手动测试 | 点击 Thread 头部 → 展开/折叠回复 | 手动 |
| 手动测试 | Thread 内回复缩进显示 | 手动 |
| 手动测试 | 非 Thread 消息正常显示（不受影响） | 手动 |

### AC Group D：项目发现与绑定

#### AC-D1：项目发现（扫描本地目录）

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `project-discovery.test.ts` | `mock 目录有 CLAUDE.md → 检测为项目` | 契约 |
| `project-discovery.test.ts` | `mock 目录有 package.json → 检测为项目` | 契约 |
| `project-discovery.test.ts` | `mock 目录有 .git/ → 检测为项目` | 契约 |
| `project-discovery.test.ts` | `mock 目录无标志 → 不检测为项目` | 契约 |
| `project-discovery.test.ts` | `hasClaudeMd 正确标记` | 契约 |
| `project-discovery.test.ts` | `monorepo → 只检测顶层 + 一级子目录` | 边界 |
| `project-discovery.test.ts` | `根目录不存在 → 返回空列表` | 边界 |
| `project-discovery.test.ts` | `缓存：第二次调用不重新扫描（TTL 内）` | 契约 |
| `project-discovery.test.ts` | `缓存过期：TTL 后重新扫描` | 边界 |

#### AC-D2：WorkUnit 关联 Project

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `project-discovery.test.ts` | `prisma validate 通过（WorkUnit.projectPath 字段）` | 冒烟 |
| `workunit.service.test.ts` | `create 带 projectPath → 查询时包含 projectPath` | 契约 |
| `workunit.service.test.ts` | `create 不带 projectPath → projectPath = null` | 边界 |

#### AC-D3：项目发现 API

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `project-discovery.test.ts` | `GET /projects/discover → 返回项目列表` | 契约 |
| `project-discovery.test.ts` | `GET /projects/discover?search=xxx → 模糊匹配` | 契约 |
| `project-discovery.test.ts` | `无项目 → 返回空数组` | 边界 |

### AC Group E：Convert to Task

#### AC-E1：Convert to Task API

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `convert-to-task.test.ts` | `正常 convert → WorkUnit 创建 + 消息关联 workUnitId` | 契约 |
| `convert-to-task.test.ts` | `消息已有 workUnitId → 400` | 边界 |
| `convert-to-task.test.ts` | `消息不存在 → 404` | 边界 |
| `convert-to-task.test.ts` | `convert 后消息成为锚点（workUnitId 非空，replyToId 为空）` | 契约 |
| `convert-to-task.test.ts` | `带 assigneeId → WorkUnit.status = 'active'` | 契约 |
| `convert-to-task.test.ts` | `不带 assigneeId → WorkUnit.status = 'unassigned'` | 边界 |

#### AC-E2：LLM 预填建议

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| `convert-to-task.test.ts` | `正常 suggest → 返回 LLM 建议` | 契约 |
| `convert-to-task.test.ts` | `消息为空 → 返回空建议` | 边界 |
| `convert-to-task.test.ts` | `LLM 调用失败 → 返回空建议（不阻断）` | 边界 |
| `convert-to-task.test.ts` | `超时 5s → 返回空建议` | 边界 |

#### AC-E3：前端 Convert to Task UI

| 测试文件 | 测试用例 | 类型 |
|---------|---------|------|
| 手动测试 | `hover 消息 → 显示「转为任务」按钮` | 手动 |
| 手动测试 | `点击 → 弹出对话框 → 自动获取 LLM 建议预填` | 手动 |
| 手动测试 | `确认 → 消息变为 Thread 锚点 → UI 刷新` | 手动 |
| 手动测试 | `已有 workUnitId 的消息 → 不显示「转为任务」按钮` | 手动 |

---

## 执行顺序

```
Task 1 (T1): Schema migration
  ├── Channel.members String @default("[]")
  └── WorkUnit.projectPath String?
  依赖：无
  可并行：无（所有后续任务的前置）
  验证：prisma validate + prisma migrate dev

Task 2 (T2): AC-A1 @mention assigneeId
  ├── message-routing.ts 改动
  └── message-routing.test.ts 新增测试
  依赖：无（不依赖 schema 改动）
  可并行：T3, T4, T5, T6

Task 3 (T3): AC-A2 listAgents 在线状态
  ├── agent-profile.service.ts 改动
  ├── agent-profile.routes.ts 改动
  └── agent-profile.service.test.ts 新增测试
  依赖：无
  可并行：T2, T4, T5, T6

Task 4 (T4): AC-D1+D3 项目发现服务 + API
  ├── project-discovery.service.ts 新文件
  ├── project.routes.ts 新文件
  └── project-discovery.test.ts 新文件
  依赖：无
  可并行：T2, T3, T5, T6

Task 5 (T5): AC-C2 Agent 消息写入 Thread
  ├── agent-loop.ts postToDiscussionSpace 改动
  └── agent-loop-v2.test.ts 新增测试
  依赖：无
  可并行：T2, T3, T4, T6

Task 6 (T6): AC-B1+B2+B3 Channel 成员管理
  ├── channel.routes.ts 改动（PATCH members + POST members）
  └── channel-members.test.ts 新文件
  依赖：T1（schema Channel.members）
  可并行：T7（T7 也依赖 T1）

Task 7 (T7): AC-D2 WorkUnit.projectPath 使用
  ├── workunit.service.ts 改动
  ├── agent-loop.ts agentStep cwd 改动
  └── workunit.service.test.ts 扩展
  依赖：T1（schema WorkUnit.projectPath）
  可并行：T6

Task 8 (T8): AC-E1+E2 Convert to Task 后端
  ├── channel.routes.ts 新增端点
  ├── convert-to-task.service.ts 新文件
  └── convert-to-task.test.ts 新文件
  依赖：T4（项目发现 API）, T1（WorkUnit.projectPath）
  可并行：T9

Task 9 (T9): AC-B4+AC-C3+AC-E3 前端
  ├── channel.ts API client 改动
  ├── ChannelInput.tsx 改动
  ├── ChannelDetailPage.tsx 改动
  ├── ChannelMessageItem.tsx 改动
  └── ConvertToTaskDialog.tsx 新文件
  依赖：T6（members API）, T8（convert API）
  可并行：无（最后一个任务）
```

### 依赖图 (DAG)

```
T1 (schema) ─────→ T6 (members API) ──┐
                 ─→ T7 (projectPath)    │
                                        ├→ T9 (frontend)
T2 (mention) ────────────────────────── │
T3 (listAgents) ────────────────────── │
T4 (discovery) ──→ T8 (convert) ──────┘
T5 (thread) ──────────────────────────
```

### 并行策略

```
Batch 1（并行）: T1 + T2 + T3 + T4 + T5
Batch 2（并行）: T6 + T7（依赖 T1）
Batch 3:         T8（依赖 T1 + T4）
Batch 4:         T9（依赖 T6 + T8）
```

### 里程碑

| 里程碑 | 包含 Task | 验证标准 |
|--------|----------|---------|
| M1: Schema 就绪 | T1 | prisma validate + migrate 通过 |
| M2: 后端核心 | T2 + T3 + T4 + T5 | 单元测试全过 |
| M3: 后端扩展 | T6 + T7 + T8 | 单元测试全过 |
| M4: 前端完成 | T9 | 手动测试全过 + 类型检查通过 |
| M5: 全量验证 | all | pnpm test + tsc --noEmit + 手动验证 |
