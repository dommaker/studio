---
slug: storage-migration
title: 存储迁移 — AN 运行时数据 → 文件
status: done
createdAt: 2026-07-13
---

## 需求概述

将 Agent Network 运行时数据（5 个 Prisma Model）从 SQLite 迁移到文件存储，保留知识图谱/安全/OKR 等跨模型 JOIN 数据在 DB。RequirementsDoc 模型直接删除（主存储已是 SDD 文件）。

相关 spec: `docs/specs/arch/storage-migration.md`

---

## 验收标准

### AC-S1: FileStore 类实现，有测试覆盖

FileStore 类实现完整的 JSON/JSONL 文件读写、flock 锁、索引重建能力。单元测试覆盖正常路径、边界条件、错误处理。

**涉及文件:**
- `packages/studio-shared/src/file-store.ts` (新建)
- `packages/studio-shared/src/__tests__/file-store.test.ts` (新建)
- `packages/studio-prisma/src/index.ts` (FileStore 不依赖 Prisma)

### AC-S2: AgentLoop 通过 FileStore 读写 5 个 model，不调 Prisma

`agent-loop.ts` 是跨 5 个 model 消费的核心文件。迁移后不再通过 Prisma 读写 AgentProfile、RuntimeInstance、Channel、ChannelMessage、WorkUnit。

**涉及文件:**
- `apps/api/src/modules/agents/agent-loop.ts`

### AC-S3: flock claim 机制正确（并发测试）

并发测试验证: 2 个进程同时 claim 同一个 WorkUnit，仅 1 个成功。claim 操作在 `fs.flockSync(LOCK_EX)` 保护下执行读-验证-写三步。

**涉及文件:**
- `packages/studio-shared/src/file-store.ts` (claimWorkUnit 方法)
- `packages/studio-shared/src/__tests__/file-store.test.ts` (并发测试用例)

### AC-S4: 数据迁移脚本可用

SQLite SELECT 导出 5 个 model 数据 → 按目标格式写入文件。支持幂等运行。

**涉及文件:**
- `scripts/migrate-storage-to-file.ts` (新建)
- `packages/studio-prisma/schema.prisma` (参考)

### AC-S5: Prisma schema 删除 5 model + RequirementsDoc

Prisma schema 移除 AgentProfile、RuntimeInstance、Channel、ChannelMessage、WorkUnit、RequirementsDoc 共 6 个 model。运行 `prisma migrate` 生成迁移文件。

**涉及文件:**
- `packages/studio-prisma/schema.prisma`
- `packages/studio-prisma/migrations/` (新增迁移)

### AC-S6: RequirementsDoc 消费方改走 SDD 文件读写

`prisma.requirementsDoc.*` 调用改为调用已有的 `findSddDocById()`、`readSddDoc()`、`updateSddFrontmatter()` 等文件读写函数。

**涉及文件:**
- `apps/api/src/modules/agents/requirement-gate.ts`
- `apps/api/src/modules/harness/evolution.service.ts`
- 其他引用 `prisma.requirementsDoc` 的文件

### AC-S7: 破损引用修复

删除已移除表的陈旧 Prisma 引用。

| 引用 | 操作 |
|------|------|
| `packages/studio-agent/src/services/output-capture.ts` L210 `prisma.goalExecution.update()` | 删除该行 |
| `packages/studio-prisma/src/index.ts` L18-20 JSON_FIELDS 中 Goal/GoalPlan/GoalExecution/RoleMemoryEntry | 删除陈旧条目 |

**涉及文件:**
- `packages/studio-agent/src/services/output-capture.ts`
- `packages/studio-prisma/src/index.ts`

### AC-S8: ChannelMessage 软删除 + count 实现

FileStore 提供 `softDeleteMessage()`（append tombstone event）和 `countMessages()`（扫描文件统计）。`channel-message.service.ts` L192 的 count 调用改接 FileStore。

**涉及文件:**
- `packages/studio-shared/src/file-store.ts` (softDeleteMessage, countMessages)
- `apps/api/src/modules/channels/channel-message.service.ts`

### AC-S9: 按 model 逐个迁移，每个 model 迁移后相关测试通过

按 AgentProfile → RuntimeInstance → ChannelMessage → WorkUnit → Channel 顺序迁移。每步替换该 model 的所有 Prisma 调用，运行该模块测试通过后继续下一步。

**涉及文件 (按 model):**

- **AgentProfile (10 文件):** `agent-loop.ts`, `agent-profile.service.ts`, `agent-profile.routes.ts`, `agent-instance.service.ts`, `monitoring.routes.ts` + 测试文件
- **RuntimeInstance (11 文件):** `agent-loop.ts`, `agent-instance.service.ts`, `agent-instance.routes.ts`, `monitoring.routes.ts` + 测试文件
- **ChannelMessage (16 文件):** `channel-message.service.ts`, `channel.routes.ts`, `message-routing.ts`, `agent-loop.ts`, `workunit.service.ts`, `workunit.routes.ts` + 其他 + 测试文件
- **WorkUnit (62 文件):** `workunit.service.ts`, `workunit.routes.ts`, `agent-loop.ts`, 7 agent 文件, PMO/OKR 模块, MCP tools, trigger-action, monitoring, skills, harness/evolution, discord + 30+ 测试文件
- **Channel (29 文件):** knowledge-agent, auditor, ops, PMO, MCP, skills 等模块 + 测试文件
