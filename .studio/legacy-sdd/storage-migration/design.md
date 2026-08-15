---
slug: storage-migration
title: 存储迁移 — AN 运行时数据 → 文件
status: draft
createdAt: 2026-07-13
---

## 设计概述

混合架构：运行时数据走文件，知识图谱/安全/OKR 等跨模型关联数据留在 DB。FileStore 类统一文件读写，flock 保障 claim 原子性。

---

## 1. 文件目录结构

```
~/.studio/data/
  agents/{agentProfileId}/
    profile.json               # AgentProfile 字段
    state.json                 # RuntimeInstance（sessionId, status, heartbeat, pid, currentWorkUnitId）
    opencode-sessions/         # opencode session 文件（见 agent-runner-enhancement.md）
      {sessionId}.jsonl
  channels/{channelId}/
    config.json                # Channel 字段
    messages.jsonl             # append-only，每行一条 ChannelMessage
  workunits/
    lock                       # flock 文件，claim 原子性
    events.jsonl               # append-only 事件流
    index.json                 # 当前状态快照，可从 events.jsonl 重建
```

RequirementsDoc 不在 data/ 目录 — 已在 `docs/sdd/<slug>/requirement.md`（SDD 文件）。

---

## 2. FileStore 接口定义

```typescript
interface FileStore {
  // ========== AgentProfile ==========
  getProfile(id: string): Promise<AgentProfile | null>;
  listProfiles(filter?: { status?: string }): Promise<AgentProfile[]>;
  createProfile(data: AgentProfile): Promise<void>;
  updateProfile(id: string, patch: Partial<AgentProfile>): Promise<void>;

  // ========== RuntimeInstance ==========
  getState(agentId: string): Promise<RuntimeState | null>;
  updateState(agentId: string, patch: Partial<RuntimeState>): Promise<void>;

  // ========== Channel ==========
  getChannel(id: string): Promise<Channel | null>;
  listChannels(): Promise<Channel[]>;
  createChannel(data: Channel): Promise<void>;
  updateChannel(id: string, patch: Partial<Channel>): Promise<void>;

  // ========== ChannelMessage (JSONL, append-only) ==========
  appendMessage(channelId: string, msg: ChannelMessage): Promise<void>;
  queryMessages(channelId: string, opts: {
    workUnitId?: string;
    authorType?: string;
    since?: Date;
    limit?: number;
  }): Promise<ChannelMessage[]>;
  countMessages(channelId: string, opts: {
    workUnitId?: string;
    authorType?: string;
  }): Promise<number>;
  softDeleteMessage(channelId: string, messageId: string): Promise<void>;

  // ========== WorkUnit (Event Sourcing) ==========
  appendEvent(event: WorkUnitEvent): Promise<void>;
  getIndex(filter?: WorkUnitFilter): Promise<WorkUnitSnapshot[]>;
  rebuildIndex(): Promise<void>;
  claimWorkUnit(wuId: string, assigneeId: string): Promise<boolean>;
}
```

---

## 3. Claim 原子性机制

单进程本地 server，锁持有 <1ms。`fs.flockSync` 是 POSIX 标准。

```
claim(wuId, assigneeId):
  1. flock(workunits/lock, LOCK_EX)
  2. 读 index.json → 验证 wu.status === 'unassigned'
  3. append events.jsonl: {"type":"claimed","wuId","assigneeId","timestamp"}
  4. 更新 index.json 中该 wu 的 assigneeId + status
  5. 释放锁
```

不依赖 DB 事务，文件锁是唯一同步机制。

---

## 4. 迁移顺序与消费方清单

每步独立验证：替换 Prisma 调用 → 运行该模块测试 → 通过后继续下一步。

### 第一步：AgentProfile（10 文件）

```
apps/api/src/modules/agents/agent-loop.ts
apps/api/src/modules/agents/agent-profile.service.ts
apps/api/src/modules/agents/agent-profile.routes.ts
apps/api/src/modules/agents/agent-instance.service.ts
apps/api/src/modules/monitoring/monitoring.routes.ts
+ 测试文件
```

### 第二步：RuntimeInstance（11 文件）

```
apps/api/src/modules/agents/agent-loop.ts
apps/api/src/modules/agents/agent-instance.service.ts
apps/api/src/modules/agents/agent-instance.routes.ts
apps/api/src/modules/monitoring/monitoring.routes.ts
+ 测试文件
```

### 第三步：ChannelMessage（16 文件）

```
apps/api/src/modules/channels/channel-message.service.ts    # 核心 CRUD
apps/api/src/modules/channels/channel.routes.ts
apps/api/src/modules/channels/message-routing.ts
apps/api/src/modules/agents/agent-loop.ts                   # observe() + postToDiscussionSpace()
apps/api/src/modules/workunit/workunit.service.ts
apps/api/src/modules/workunit/workunit.routes.ts
+ 其他
```

JSONL 特殊处理：物理删除 → 软删除（append tombstone event）；count → 扫描文件（数据量 <10000 OK）。

### 第四步：WorkUnit（62 文件，范围最大）

```
核心:
  apps/api/src/modules/workunit/workunit.service.ts
  apps/api/src/modules/workunit/workunit.routes.ts
Agent 模块:
  apps/api/src/modules/agents/agent-loop.ts
  apps/api/src/modules/agents/monitor-agent.service.ts
  apps/api/src/modules/agents/auditor-agent.service.ts
  apps/api/src/modules/agents/triage-agent.service.ts
  apps/api/src/modules/agents/session-summary-agent.service.ts
  apps/api/src/modules/agents/requirement-gate.ts
  apps/api/src/modules/agents/default-triggers.ts
PMO/OKR 模块:
  apps/api/src/modules/pmo/project.service.ts
  apps/api/src/modules/pmo/okr.service.ts
  apps/api/src/modules/pmo/routes.ts
其他模块:
  apps/api/src/modules/mcp/tools.ts
  apps/api/src/modules/triggers/trigger-action.ts
  apps/api/src/modules/knowledge/decision-chain-extractor.ts
  apps/api/src/modules/monitoring/monitoring.service.ts
  apps/api/src/modules/skills/skill-extraction.service.ts
  apps/api/src/modules/harness/evolution.service.ts
  apps/api/src/modules/discord/command-runner.ts
+ 30+ 测试文件
```

### 第五步：Channel（29 文件）

Channel 被 knowledge-agent、auditor、ops、PMO、MCP、skills 等模块引用。这些模块的其他数据（Knowledge、Project）留在 DB → 允许跨存储引用（FileStore + Prisma 混用）。

### 最终：RequirementsDoc 删除 DB model

消费方已通过 `findSddDocById()` + `readSddDoc()` 读 SDD 文件。`prisma.requirementsDoc.*` 调用改为直接走 SDD 文件读写（`updateSddFrontmatter` 已有）。

---

## 5. 留在 DB 的模型清单及理由

| 类别 | 模型 | 理由 |
|------|------|------|
| 知识图谱 | Resolution, DecisionChain, DecisionAudit, StudioEvent, InteractionPattern, BusinessRule 等 | 跨模型 JOIN 查询（unified-query.ts） |
| OKR/PMO | Project, Task, Execution, OKR | 多表关联 + 聚合统计 |
| Auth | User, Session, OAuthAccount, RefreshToken 等 | 安全敏感，文件实现风险高 |
| Spec/Workspace 等 | SpecReview, Workspace 等 | 后续可迁，不阻塞 |

---

## 6. 数据模型映射

| Prisma Model | 文件格式 | 目标路径 | 备注 |
|-------------|---------|---------|------|
| AgentProfile | JSON | `~/.studio/data/agents/{id}/profile.json` | 独立文件，按 id 存取 |
| RuntimeInstance | JSON | `~/.studio/data/agents/{id}/state.json` | 独立文件，按 agentId 存取 |
| Channel | JSON | `~/.studio/data/channels/{id}/config.json` | 独立文件，按 id 存取 |
| ChannelMessage | JSONL | `~/.studio/data/channels/{id}/messages.jsonl` | append-only 流，不支持物理删除 |
| WorkUnit | JSONL + JSON | `~/.studio/data/workunits/events.jsonl` + `index.json` | Event Sourcing：events.jsonl 是全量日志，index.json 是当前快照 |

---

## 7. 数据迁移脚本设计

```typescript
// scripts/migrate-storage-to-file.ts
// 功能:
//   1. 从 SQLite 读取 5 个 model 全部数据
//   2. 按文件目录结构写入 ~/.studio/data/
//   3. 幂等：已存在的文件跳过（或覆盖，由 flag 控制）
//   4. 输出迁移报告（迁移数量、错误数）
//
// 执行: npx tsx scripts/migrate-storage-to-file.ts
// 前置条件: Prisma 迁移尚未执行（model 仍存在），数据已在 DB
```

---

## 8. 破损引用修复清单

| 文件 | 行 | 引用 | 操作 |
|------|-----|------|------|
| `packages/studio-agent/src/services/output-capture.ts` | L210 | `prisma.goalExecution.update()` | 删除该行 |
| `packages/studio-prisma/src/index.ts` | L18-20 | JSON_FIELDS 中 Goal/GoalPlan/GoalExecution/RoleMemoryEntry | 删除陈旧条目 |
