---
status: done
version: "1.0"
source: docs/specs/db-removal/spec-2b-data-migration.md
---

# Spec 2b: 数据层与配置层表迁移 — 需求规格

将 14 个数据层/配置层表从 Prisma/SQLite 迁移到 FileStore 文件存储。复用 Spec 2a 建立的 FileStore 能力。

## 依赖与约束

### 前置依赖

- Spec 1（死代码表删除）完成
- Spec 2a（FileStore 统一能力）完成

### 组间依赖

- AC Group B（数据层迁移）依赖 AC Group A（FileStore 公开方法）
- AC Group C（配置层迁移）的 AC-C2（Agent+AgentConfig）依赖 AC-C1（Environment name 引用就绪）
- AC Group E（收尾）依赖所有前组完成

### 约束

- 所有文件编码 UTF-8
- jsonl 每行一条完整 JSON，追加写入后不可修改已写入行
- 迁移脚本必须幂等
- 目录结构以 `~/.studio/` 为根
- FileStore 现有公共接口不变，只新增公开方法

## 源项目清单

| # | 源项目 | 产出类型 | AC Group | 说明 |
|---|--------|---------|----------|------|
| 1 | FileStore 公开方法 | 代码修改 | A | appendJsonl/readJsonl/readJson/writeJson 改为 public |
| 2 | AuditLog 迁移 | 代码修改 | B | audit-service 改用 jsonl |
| 3 | StudioEvent 迁移 | 代码修改 | B | 17 处 prisma.studioEvent.create → jsonl |
| 4 | Execution 迁移 | 代码修改 | B | execution 改用 jsonl |
| 5 | Notification 迁移 | 代码修改 | B | notification 改用 jsonl |
| 6 | Incident 迁移 | 代码修改 | B | incident 改用 jsonl |
| 7 | EnvironmentSnapshot 迁移 | 代码修改 | B | env-snapper 改用 json 文件 |
| 8 | KRHistory 迁移 | 代码修改 | B | OKR progress history 改用 jsonl |
| 9 | OKR 迁移 | 代码修改 | B | OKR CRUD 改用 md 文件 |
| 10 | Environment 迁移 | 代码修改 | C | environmentId → name 引用 |
| 11 | Agent+AgentConfig 迁移 | 代码修改 | C | 合并为单个 json 文件 |
| 12 | AgentConfigVersion 迁移 | 代码修改 | C | 版本历史改为 jsonl |
| 13 | Capability 迁移 | 代码修改 | C | capability 改为 json 文件 |
| 14 | Resolution 迁移 | 代码修改 | D | Resolution 转为知识条目 md |
| 15 | 数据迁移脚本 | 新文件 | E | SQLite → 文件导出 |
| 16 | Prisma 清理 | Schema 修改 | E | 删除 14 model + migration |

## AC Group A：FileStore 公开方法

covers: [源项目 1]

### AC-A1：FileStore JSON/JSONL 方法公开

- **触发**：服务层需要直接调用 json/jsonl 文件操作
- **预期**：
  1. `appendJsonl(filePath: string, data: unknown): Promise<void>` 改为 public
  2. `readJsonl<T>(filePath: string): Promise<T[]>` 改为 public
  3. `readJson<T>(filePath: string): Promise<T | null>` 改为 public
  4. `writeJson(filePath: string, data: unknown): Promise<void>` 改为 public
  5. 现有内部调用不变（private → public 向下兼容）
  6. 方法签名不变，仅改访问修饰符
- **验证**：TypeScript 编译通过 + FileStore 现有测试全通过
- **边界**：无（纯访问修饰符变更）
- **不做**：不添加新方法，不修改现有方法签名

**涉及文件:**
- `packages/studio-shared/src/file-store.ts`

## AC Group B：数据层表迁移

covers: [源项目 2, 3, 4, 5, 6, 7, 8, 9]

### AC-B1：AuditLog 迁移

- **触发**：审计事件（create/update/delete/execute/login 等）
- **预期**：
  1. `audit-service.ts` 的 `log()` 和 `logBatch()` 改为 `fileStore.appendJsonl(auditJsonlPath, data)`
  2. `query()` 改为 `fileStore.readJsonl<AuditLogRow>(auditJsonlPath)` + 内存过滤
  3. `getStats()` 改为基于 jsonl 流式数据计算（不再用 SQL 聚合）
  4. `cleanup()` 改为按行过滤 + 重写文件（移除过期行）
  5. `export()` 改为 `fileStore.readJsonl()` 全量读取
  6. `getById()` 改为 jsonl 中按 id 查找
  7. Prisma schema 删除 `model AuditLog`
  8. `AuditService` 构造函数改为接受 `FileStore` 替代 `ExtendedPrismaClient`（保留 prisma 参数兼容，但 audit 操作不再用 DB）
- **验证**：log 后文件追加一行；query 能按 userId/action/resource 过滤；时间范围查询正确；stats 聚合结果与迁移前一致
- **边界**：jsonl 文件不存在 → 空结果；jsonl 行损坏 → 跳过该行
- **不做**：不优化查询性能（本地场景数据量小）

**涉及文件:**
- `packages/studio-audit/src/services/audit-service.ts`
- `apps/api/src/middleware/audit-logger.ts`

### AC-B2：StudioEvent 迁移

- **触发**：事件记录（knowledge:consumption, knowledge:injected, deploy.completed 等）
- **预期**：
  1. 17 处 `prisma.studioEvent.create` 全部改为 `fileStore.appendJsonl(eventsJsonlPath, data)`
  2. 涉及文件：`knowledge-bus.service.ts`（6 处）、`knowledge-service.ts`（3 处）、`resolution.service.ts`（1 处）、`session-manager.ts`（2 处）、`output-capture.ts`（5 处）
  3. 现有 StudioEvent 查询（如 `prisma.studioEvent.findMany`）改为 `fileStore.readJsonl()` + 内存过滤
  4. `okr.service.ts` 中所有 `prisma.studioEvent.count/findMany` 改为 jsonl 读取
  5. Prisma schema 删除 `model StudioEvent`
- **验证**：每个改造点 write 后 jsonl 有新行；query 按 type/timestamp 过滤正确；count 聚合结果正确
- **边界**：已有 `~/.studio/events/studio.jsonl` 数据由 AC-E1 合并；jsonl 行损坏 → 跳过

**涉及文件:**
- `apps/api/src/modules/knowledge/knowledge-bus.service.ts`
- `apps/api/src/modules/knowledge/knowledge-service.ts`
- `apps/api/src/modules/knowledge/resolution.service.ts`
- `packages/studio-agent/src/services/session-manager.ts`
- `packages/studio-agent/src/services/output-capture.ts`
- `apps/api/src/modules/pmo/okr.service.ts`
- `packages/studio-shared/src/event-bus.ts`

### AC-B3：Execution 迁移

- **触发**：执行记录（WorkUnit create/complete/update）
- **预期**：
  1. `apps/api/src/modules/executions/routes.ts` 改用 `fileStore.appendJsonl/readJsonl`
  2. `okr.service.ts` 中 `prisma.execution.count` 改为 jsonl 计数
  3. Task 的 `executionId` 引用改为文件路径或保持 id 字符串（不做外键约束）
  4. Prisma schema 删除 `model Execution`
- **验证**：execution 写入/查询正确；按 status/projectId 过滤有效
- **边界**：jsonl 文件不存在 → 空列表

**涉及文件:**
- `apps/api/src/modules/executions/routes.ts`
- `apps/api/src/modules/pmo/routes.ts`
- `apps/api/src/modules/pmo/okr.service.ts`

### AC-B4：Notification 迁移

- **触发**：通知创建/查询/标记已读
- **预期**：
  1. `notification-service.ts` 改用 `fileStore.appendJsonl/readJsonl`
  2. "标记已读"通过追加 tombstone 行（`{ id, deleted: true }`）实现，与 ChannelMessage 模式一致
  3. Prisma schema 删除 `model Notification`
- **验证**：新增通知可读；未读查询过滤；标记已读后查询不返回
- **边界**：批量标记已读时并发写安全（单进程 jsonl 追加 + flock）

**涉及文件:**
- `packages/studio-notification/src/services/notification-service.ts`

### AC-B5：Incident 迁移

- **触发**：故障记录（triage agent 检测到问题）
- **预期**：
  1. `triage-agent.service.ts` 改用 `fileStore.appendJsonl/readJsonl`
  2. `okr.service.ts` 中 `prisma.incident.count` 改为 jsonl 读取
  3. Prisma schema 删除 `model Incident`
- **验证**：故障记录写入；按 status 查询；triageLog 更新通过追加新行
- **边界**：已有 `events/incidents.jsonl` 数据由 AC-E1 合并

**涉及文件:**
- `apps/api/src/modules/agents/triage-agent.service.ts`
- `apps/api/src/modules/pmo/okr.service.ts`

### AC-B6：EnvironmentSnapshot 迁移

- **触发**：环境快照创建/查询
- **预期**：
  1. `env-snapper.ts` 改用 `fileStore.writeJson(snapshotPath, data)`——每快照一文件
  2. 文件名 `~/.studio/snapshots/{ISO8601}.json`（如 `2026-07-15T143052Z.json`）
  3. 按时间查询 = 扫描 `~/.studio/snapshots/` 目录 + 解析文件名时间
  4. Prisma schema 删除 `model EnvironmentSnapshot`
- **验证**：快照创建生成新文件；按时间范围扫描正确
- **边界**：snapshots 目录不存在 → 空结果

**涉及文件:**
- `apps/api/src/modules/knowledge/env-snapper.ts`

### AC-B7：KRHistory 迁移

- **触发**：KR 进度记录（每次 syncKRProgress）
- **预期**：
  1. `okr.service.ts` 的 `syncKRProgress()` 中 `prisma.kRHistory.createMany` 改为 `fileStore.appendJsonl(krHistoryPath, data)`
  2. 按 okrId/krId 查询 = jsonl 读取 + 过滤
  3. Prisma schema 删除 `model KRHistory`
- **验证**：进度追加；按 quarter+okrId 查询；按 krId 过滤
- **边界**：历史文件不存在 → 空数组

**涉及文件:**
- `apps/api/src/modules/pmo/okr.service.ts`
- `apps/api/src/modules/pmo/okr-anomaly-detector.ts`

### AC-B8：OKR 迁移

- **触发**：OKR CRUD 操作
- **预期**：
  1. `okr.service.ts` 的 create/update/delete/list/get 全部改为 `fileStore.readDoc/writeDoc`
  2. 目标路径：`~/.studio/okr/{quarter}.md`
  3. frontmatter 字段：`status`, `progress`, `title`, `quarter`, `createdAt`, `updatedAt`
  4. body 内容：objectives 和 keyResults 的 Markdown 列表
  5. Company 已删除（Spec 1），`companyId` 相关逻辑移除
  6. Prisma schema 删除 `model OKR`
- **验证**：CRUD 全流程正确；progress 更新后 frontmatter 反映新值；按 quarter 查询正确
- **边界**：同 quarter 多个 OKR → 按 creation time 追加或覆盖（quarter 唯一）

**涉及文件:**
- `apps/api/src/modules/pmo/okr.service.ts`
- `apps/api/src/modules/pmo/routes.ts`

## AC Group C：配置层表迁移

covers: [源项目 10, 11, 12, 13]

### AC-C1：Environment 迁移

- **触发**：环境模板 CRUD
- **预期**：
  1. `environments/routes.ts` 改用 `fileStore.readJson/writeJson(environmentsPath, data)`
  2. 目标文件 `~/.studio/environments.json`，结构 `[{ name, template }]`
  3. Prisma schema 删除 `model Environment`
  4. 迁移脚本生成 `environmentId → name` 映射表
- **验证**：CRUD 正确；AgentConfig 的 environment 字段为 name 字符串

**涉及文件:**
- `apps/api/src/modules/environments/routes.ts`
- `apps/api/src/modules/agent-configs/routes.ts`

### AC-C2：Agent + AgentConfig 合并

- **触发**：Agent CRUD
- **预期**：
  1. `agents/` 目录和 `agent-configs/routes.ts` 改用 `fileStore.readJson/writeJson`
  2. 目标文件 `~/.studio/agents/{id}.json`，合并 Agent 和 AgentConfig 字段
  3. JSON 结构：
     ```json
     {
       "id": "string", "name": "string", "role": "string",
       "model": "string", "systemPrompt": "string",
       "environment": "string", "capabilities": ["string"],
       "config": { "temperature": 0.7, "maxTokens": 4096 }
     }
     ```
  4. Prisma schema 删除 `model Agent`, `model AgentConfig`
- **验证**：Agent CRUD 正确；config 字段读写正确

**涉及文件:**
- `apps/api/src/modules/agents/`
- `apps/api/src/modules/agent-configs/routes.ts`

### AC-C3：AgentConfigVersion 迁移

- **触发**：Agent 配置变更
- **预期**：
  1. `agent-configs/routes.ts` 改用 `fileStore.appendJsonl`
  2. 目标文件 `~/.studio/agents/{id}/versions.jsonl`
  3. 每行 `{ version, config, changedAt, changedBy }`
  4. Prisma schema 删除 `model AgentConfigVersion`
- **验证**：版本追加；按 agentId 回溯历史

**涉及文件:**
- `apps/api/src/modules/agent-configs/routes.ts`

### AC-C4：Capability 迁移

- **触发**：能力定义 CRUD
- **预期**：
  1. `capability.service.ts` 改用 `fileStore.readJson/writeJson`
  2. 目标文件 `~/.studio/capabilities/{name}.json`
  3. Prisma schema 删除 `model Capability`
- **验证**：CRUD 正确；按 type 查询正确

**涉及文件:**
- `packages/studio-capability/src/services/capability.service.ts`

## AC Group D：知识层迁移

covers: [源项目 14]

### AC-D1：Resolution 迁移到知识库

- **触发**：Resolution 错误模式匹配/创建/验证
- **预期**：
  1. `resolution.service.ts` 的 CRUD 操作改为基于知识库 md 文件
  2. 每条 Resolution → `~/.studio/knowledge/resolution-{id}.md`
  3. frontmatter: type=resolution, status/maturity 映射见 spec
  4. body: title + fix 内容（Markdown）
  5. 错误模式匹配：`matchResolutions()` 改为遍历知识条目 + 正则/子串匹配
  6. 验证（verifyResolution）：修改 frontmatter verifyCount + maturity
  7. `listPending()` / `formatForPrompt()` / `getDensityScore()` 改为文件系统查询
  8. `ensureSeedResolutions()` 改为创建知识条目 md 文件
  9. `autoVerifyFromBehavior()` 改为文件系统更新
  10. `getCrossSessionStats()` 改为统计知识条目
  11. Prisma schema 删除 `model Resolution`
- **验证**：match 逻辑一致；CRUD 正确；seed 幂等；verifyCount/maturity 更新；stats 计数准确
- **边界**：知识库 `_index.md` 需包含 Resolution 条目；text search 使用知识库现有查询（不再 SQL LIKE）

**涉及文件:**
- `apps/api/src/modules/knowledge/resolution.service.ts`

## AC Group E：迁移脚本 + 收尾

covers: [源项目 15, 16]

### AC-E1：数据迁移脚本

- **触发**：部署前执行一次性迁移
- **预期**：
  1. 新建 `scripts/migrate-spec2b-to-files.ts`
  2. 从 SQLite 导出 14 表数据到对应文件
  3. 合并已有文件数据（`events/studio.jsonl`, `events/incidents.jsonl`）：按 id 去重，保留 createdAt 最新的行；无 id 的表按整行 hash 去重
  4. Environment: 构建 `id → name` 映射，替换所有 AgentConfig 的 environmentId 为 name；无匹配时保留旧值 + 输出 warning
  5. 支持 `--dry-run`（输出预览不写文件）
  6. 幂等：重复执行不产生重复数据
  7. 执行前自动备份：`cp data.db data.db.bak`
- **验证**：dry-run 输出预览正确；正式执行后文件生成；重复执行幂等

**涉及文件:**
- `scripts/migrate-spec2b-to-files.ts` (new)

### AC-E2：Prisma migration + 全量验证

- **触发**：所有代码改造完成后
- **预期**：
  1. 运行 `npx prisma migrate dev --name migrate-data-config-tables` 删除 14 个 model
  2. `npx prisma validate` 通过
  3. `npx tsc --noEmit` 无类型错误
  4. 全量测试通过
  5. Agent 相关 3 个 model 的 migration 已在前步完成（AC-C2, AC-C3 后）
- **验证**：所有验证命令无错误

**涉及文件:**
- `packages/studio-prisma/prisma/schema.prisma`
- 全量测试文件
