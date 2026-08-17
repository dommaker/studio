---
slug: storage-migration
title: 存储迁移 — AN 运行时数据 → 文件
status: draft
createdAt: 2026-07-13
---

## 实现步骤

按 model 依赖顺序迁移：AgentProfile → RuntimeInstance → ChannelMessage → WorkUnit → Channel。RequirementsDoc 删除在最后独立执行。

---

### Step 1: FileStore 基类实现

**文件:** `packages/studio-shared/src/file-store.ts` (新建)

**关键接口:**
```typescript
export class FileStore {
  private baseDir: string;

  constructor(baseDir?: string);  // 默认 ~/.studio/data/

  // AgentProfile
  async getProfile(id: string): Promise<AgentProfile | null>;
  async listProfiles(filter?: { status?: string }): Promise<AgentProfile[]>;
  async createProfile(data: AgentProfile): Promise<void>;
  async updateProfile(id: string, patch: Partial<AgentProfile>): Promise<void>;

  // RuntimeInstance
  async getState(agentId: string): Promise<RuntimeState | null>;
  async updateState(agentId: string, patch: Partial<RuntimeState>): Promise<void>;

  // Channel
  async getChannel(id: string): Promise<Channel | null>;
  async listChannels(): Promise<Channel[]>;
  async createChannel(data: Channel): Promise<void>;
  async updateChannel(id: string, patch: Partial<Channel>): Promise<void>;

  // ChannelMessage
  async appendMessage(channelId: string, msg: ChannelMessage): Promise<void>;
  async queryMessages(channelId: string, opts: QueryOpts): Promise<ChannelMessage[]>;
  async countMessages(channelId: string, opts: CountOpts): Promise<number>;
  async softDeleteMessage(channelId: string, messageId: string): Promise<void>;

  // WorkUnit (Event Sourcing)
  async appendEvent(event: WorkUnitEvent): Promise<void>;
  async getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]>;
  async rebuildIndex(): Promise<void>;
  async claimWorkUnit(wuId: string, assigneeId: string): Promise<boolean>;
}
```

**完成标准:**
- 所有方法实现，支持 baseDir 注入（方便测试）
- 单元测试覆盖：创建/读取/更新/软删除/列表/查询/count
- 目录不存在时自动创建
- JSONL append-only 写入正确
- index.json 重建逻辑正确
- flock claim 测试：2 并发 claim，仅 1 成功

---

### Step 2: AgentProfile 迁移

**消费方改接（10 文件）:**
- `apps/api/src/modules/agents/agent-loop.ts` — 通过 FileStore 读写 profile
- `apps/api/src/modules/agents/agent-profile.service.ts` — 替换 Prisma 调用
- `apps/api/src/modules/agents/agent-profile.routes.ts` — 路由层无感知
- `apps/api/src/modules/agents/agent-instance.service.ts` — 改走 FileStore
- `apps/api/src/modules/monitoring/monitoring.routes.ts` — 改走 FileStore
- 相关测试文件

**完成标准:**
- 所有 consumer 不再调 `prisma.agentProfile.*`
- agent-profile 模块测试通过

---

### Step 3: RuntimeInstance 迁移

**消费方改接（11 文件）:**
- `apps/api/src/modules/agents/agent-loop.ts` — 通过 FileStore 读写 state
- `apps/api/src/modules/agents/agent-instance.service.ts` — 替换 Prisma 调用
- `apps/api/src/modules/agents/agent-instance.routes.ts` — 改走 FileStore
- `apps/api/src/modules/monitoring/monitoring.routes.ts` — 改走 FileStore
- 相关测试文件

**完成标准:**
- 所有 consumer 不再调 `prisma.runtimeInstance.*`
- agent-instance 模块测试通过

---

### Step 4: ChannelMessage 迁移

**消费方改接（16 文件）:**
- `apps/api/src/modules/channels/channel-message.service.ts` — 核心 CRUD 改接 FileStore
- `apps/api/src/modules/channels/channel.routes.ts` — 无感知
- `apps/api/src/modules/channels/message-routing.ts` — 改走 FileStore
- `apps/api/src/modules/agents/agent-loop.ts` — observe() + postToDiscussionSpace() 改接
- `apps/api/src/modules/workunit/workunit.service.ts` — 改接
- `apps/api/src/modules/workunit/workunit.routes.ts` — 改接
- 其他 + 测试文件

**特殊处理:**
- 物理删除 → 软删除（append tombstone event）
- count → 扫描文件（数据量 <10000 OK）

**完成标准:**
- 所有 consumer 不再调 `prisma.channelMessage.*`
- channel-message 模块测试通过
- softDeleteMessage + countMessages 通过单独测试

---

### Step 5: WorkUnit 迁移（最大范围，62 文件）

**消费方改接:**
- 核心: `workunit.service.ts`, `workunit.routes.ts`
- Agent 模块: `agent-loop.ts`, `monitor-agent.service.ts`, `auditor-agent.service.ts`, `triage-agent.service.ts`, `session-summary-agent.service.ts`, `requirement-gate.ts`, `default-triggers.ts`
- PMO/OKR: `project.service.ts`, `okr.service.ts`, `routes.ts`
- 其他: `mcp/tools.ts`, `triggers/trigger-action.ts`, `knowledge/decision-chain-extractor.ts`, `monitoring/monitoring.service.ts`, `skills/skill-extraction.service.ts`, `harness/evolution.service.ts`, `discord/command-runner.ts`
- 30+ 测试文件

**Event Sourcing 模式:**
- `appendEvent()` → JSONL 写入
- `getIndex()` → 读 index.json 快照
- `rebuildIndex()` → 遍历 events.jsonl 重建快照
- `claimWorkUnit()` → flock 保护

**完成标准:**
- 所有 consumer 不再调 `prisma.workUnit.*`
- workunit 模块测试通过
- claim 并发测试通过

---

### Step 6: Channel 迁移

**消费方改接（29 文件）:**
- knowledge-agent, auditor, ops, PMO, MCP, skills 等模块中的 Channel 读取/更新
- 消费方可混用 FileStore + Prisma（其他数据仍在 DB）

**完成标准:**
- 所有 consumer 不再调 `prisma.channel.*`
- Channel 相关测试通过

---

### Step 7: RequirementsDoc DB model 删除

**操作:**
- 审计所有 `prisma.requirementsDoc.*` 调用
- 替换为 `findSddDocById()` / `readSddDoc()` / `updateSddFrontmatter()`
- 确认 `requirement-gate.ts` 和 `evolution.service.ts` 等已使用文件 API

**完成标准:**
- `prisma.requirementsDoc.*` 零引用
- 消费方测试通过

---

### Step 8: 破损引用修复

| 文件 | 操作 |
|------|------|
| `packages/studio-agent/src/services/output-capture.ts` L210 | 删除 `prisma.goalExecution.update()` 行 |
| `packages/studio-prisma/src/index.ts` L18-20 | 删除 JSON_FIELDS 中 Goal/GoalPlan/GoalExecution/RoleMemoryEntry |

**完成标准:**
- 两文件编译通过，无陈旧 Prisma 引用

---

### Step 9: Prisma schema 变更

**操作:**
- `schema.prisma` 删除 6 个 model: AgentProfile, RuntimeInstance, Channel, ChannelMessage, WorkUnit, RequirementsDoc
- 运行 `npx prisma migrate dev --name storage-migration`

**完成标准:**
- schema 无已迁移 model
- migrate 成功执行

---

### Step 10: 数据迁移脚本

**文件:** `scripts/migrate-storage-to-file.ts` (新建)

**功能:**
- SQLite SELECT 读取 5 个 model 全部数据
- 按目标目录结构写入文件
- 幂等：覆盖写入或跳过（flag 控制）

**完成标准:**
- 脚本执行后 `~/.studio/data/` 目录结构与 Section 三一致
- 文件内容与 DB 数据一致

---

### Step 11: 全量验证

**操作:**
- 全量测试: `pnpm test`
- 类型检查: `npx tsc --noEmit`
- End-to-end: 启动 API 验证核心功能

**完成标准:**
- 所有测试通过
- 类型检查无错误
- lint 无新增警告
