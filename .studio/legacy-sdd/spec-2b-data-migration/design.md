---
status: done
version: "1.0"
---

# Spec 2b: 数据层与配置层表迁移 — 设计文档

## 设计决策

### D1：FileStore 方法公开策略

**决策**：将 `appendJsonl`、`readJsonl`、`readJson`、`writeJson` 从 private 改为 public，不改签名。

**理由**：
- 这些方法已接受绝对路径参数，不依赖 baseDir
- `readDoc`/`writeDoc` 已经是 public，模式一致
- 无需新增包装方法，改动最小
- 现有内部调用者不受影响（private → public 向下兼容）

**不做**：不添加 "domain-specific" 包装（如 `appendAuditLog()`）。FileStore 是通用存储，domain 逻辑留在 service 层。

### D2：jsonl 查询模式

**决策**：jsonl 查询用 `readJsonl<T>()` 全量读取 + 内存过滤，不做索引。

**理由**：
- 本地单用户，12 个表的数据量在 10K-100K 行级别
- grep/内存过滤在本地足够快
- 不做文件索引——减少复杂度，避免与 `_index.md` 格式耦合
- 如需性能优化（未来），可用 `_index.md` 做二级索引

**代价**：全量扫描。可接受（本地场景）。

### D3：Notification "标记已读" 实现

**决策**：使用 jsonl tombstone 模式（追加 `{ id, deleted: true }` 行），与 FileStore ChannelMessage 的 `softDeleteMessage` 一致。

**理由**：
- jsonl append-only，不可修改已写入行
- tombstone 追加后，查询时按 id 去重取最新状态（deleted 行覆盖原行）
- 与 ChannelMessage 模式一致，代码可复用

### D4：OKR 文件格式

**决策**：OKR 用 markdown 文件存储（`~/.studio/okr/{quarter}.md`），frontmatter 存元数据，body 存 objectives/keyResults 列表。

**理由**：
- FileStore 已有 `readDoc`/`writeDoc` 支持 markdown
- frontmatter 可被 `_index.md` 索引
- body 保持 Markdown 可读性
- 与知识条目格式一致，方便统一查询

### D5：EnvironmentSnapshot 文件名格式

**决策**：使用 ISO 8601 不含冒号格式：`{YYYY}-{MM}-{DD}T{HH}{MM}{SS}Z.json`。时间查询 = 扫描目录 + 解析文件名。

**理由**：
- 文件名自带时间戳，无需解析文件内容
- 不含冒号兼容 Windows/NTFS
- ISO 8601 可排序（字符串序 = 时间序）

### D6：Migration 脚本安全性

**决策**：执行前自动备份 SQLite（`cp data.db data.db.bak`），支持 `--dry-run`，要求幂等。

**理由**：
- 14 表迁移不可逆
- dry-run 让操作者在生产前验证
- 幂等保证重复执行安全（去重逻辑在规格中已定义）

---

## 文件映射

### AC Group A：FileStore 公开方法

| AC | 文件 | 改动类型 | 说明 |
|----|------|---------|------|
| AC-A1 | `packages/studio-shared/src/file-store.ts` | modify | 4 个方法 private → public |
| AC-A1 | `packages/studio-shared/src/__tests__/file-store.test.ts` | modify | 添加公开方法直接调用测试 |

### AC Group B：数据层表迁移

| AC | 文件 | 改动类型 | 说明 |
|----|------|---------|------|
| AC-B1 | `packages/studio-audit/src/services/audit-service.ts` | modify | prisma → fileStore jsonl |
| AC-B1 | `packages/studio-audit/src/services/__tests__/audit-service.test.ts` | modify | mock prisma → mock fileStore |
| AC-B1 | `apps/api/src/middleware/audit-logger.ts` | modify | 确认 audit middleware 调用路径 |
| AC-B2 | `apps/api/src/modules/knowledge/knowledge-bus.service.ts` | modify | 6 处 studioEvent.create → appendJsonl |
| AC-B2 | `apps/api/src/modules/knowledge/knowledge-service.ts` | modify | 3 处 studioEvent.create → appendJsonl |
| AC-B2 | `apps/api/src/modules/knowledge/resolution.service.ts` | modify | 1 处 studioEvent.create → appendJsonl |
| AC-B2 | `packages/studio-agent/src/services/session-manager.ts` | modify | 2 处 studioEvent.create → appendJsonl |
| AC-B2 | `packages/studio-agent/src/services/output-capture.ts` | modify | 5 处 studioEvent.create → appendJsonl |
| AC-B2 | `apps/api/src/modules/pmo/okr.service.ts` | modify | prisma.studioEvent → fileStore |
| AC-B2 | `packages/studio-shared/src/event-bus.ts` | modify | 如有 EventBus 写入也需迁移 |
| AC-B3 | `apps/api/src/modules/executions/routes.ts` | modify | prisma → fileStore |
| AC-B3 | `apps/api/src/modules/pmo/okr.service.ts` | modify | prisma.execution → fileStore |
| AC-B3 | `apps/api/src/modules/pmo/routes.ts` | modify | 执行关联逻辑 |
| AC-B4 | `packages/studio-notification/src/services/notification-service.ts` | modify | prisma → fileStore + tombstone |
| AC-B4 | `packages/studio-notification/src/services/__tests__/notification-service.test.ts` | modify | mock 适配 |
| AC-B5 | `apps/api/src/modules/agents/triage-agent.service.ts` | modify | prisma.incident → fileStore |
| AC-B5 | `apps/api/src/modules/pmo/okr.service.ts` | modify | prisma.incident → fileStore |
| AC-B6 | `apps/api/src/modules/knowledge/env-snapper.ts` | modify | prisma.environmentSnapshot → fileStore.writeJson |
| AC-B7 | `apps/api/src/modules/pmo/okr.service.ts` | modify | prisma.kRHistory → fileStore.appendJsonl |
| AC-B7 | `apps/api/src/modules/pmo/okr-anomaly-detector.ts` | modify | KRHistory 读取逻辑 |
| AC-B8 | `apps/api/src/modules/pmo/okr.service.ts` | modify | prisma.oKR → fileStore.readDoc/writeDoc |
| AC-B8 | `apps/api/src/modules/pmo/routes.ts` | modify | OKR API 路由适配 |

### AC Group C：配置层表迁移

| AC | 文件 | 改动类型 | 说明 |
|----|------|---------|------|
| AC-C1 | `apps/api/src/modules/environments/routes.ts` | modify | prisma.environment → fileStore JSON |
| AC-C1 | `apps/api/src/modules/agent-configs/routes.ts` | modify | environmentId → name 引用 |
| AC-C2 | `apps/api/src/modules/agents/agent-profile.service.ts` | modify | prisma.agent → fileStore JSON |
| AC-C2 | `apps/api/src/modules/agents/agent-profile.routes.ts` | modify | Agent API 适配 |
| AC-C2 | `apps/api/src/modules/agent-configs/routes.ts` | modify | AgentConfig 合并到 agents/{id}.json |
| AC-C3 | `apps/api/src/modules/agent-configs/routes.ts` | modify | 版本历史 → versions.jsonl |
| AC-C4 | `packages/studio-capability/src/services/capability.service.ts` | modify | prisma.capability → fileStore JSON |
| AC-C4 | `packages/studio-capability/src/__tests__/capability.service.test.ts` | modify | mock 适配 |

### AC Group D：知识层迁移

| AC | 文件 | 改动类型 | 说明 |
|----|------|---------|------|
| AC-D1 | `apps/api/src/modules/knowledge/resolution.service.ts` | modify | prisma.resolution → fileStore + 知识条目 |
| AC-D1 | `apps/api/src/modules/knowledge/__tests__/resolution.service.test.ts` | modify | mock 适配 |

### AC Group E：迁移脚本 + 收尾

| AC | 文件 | 改动类型 | 说明 |
|----|------|---------|------|
| AC-E1 | `scripts/migrate-spec2b-to-files.ts` | new | 数据迁移脚本 |
| AC-E2 | `packages/studio-prisma/prisma/schema.prisma` | modify | 删除 14 个 model |
| AC-E2 | `packages/studio-prisma/prisma/migrations/` | new | 新增 migration |

---

## 接口定义

### FileStore 公开方法（AC-A1）

```typescript
// file-store.ts — 访问修饰符变更（private → public）

class FileStore {
  // 现有 public 方法不变
  // readDoc, writeDoc, buildIndex, queryIndex, listDocs, findByField
  // bumpVersion, appendChangelog 等

  // === 以下 4 个方法访问修饰符从 private 改为 public ===

  /** 追加一行 JSONL */
  public async appendJsonl(filePath: string, data: unknown): Promise<void>

  /** 读取全部 JSONL 行（跳过解析失败的行） */
  public async readJsonl<T>(filePath: string): Promise<T[]>

  /** 读取 JSON 文件，不存在或损坏返回 null */
  public async readJson<T>(filePath: string): Promise<T | null>

  /** 写入 JSON 文件 */
  public async writeJson(filePath: string, data: unknown): Promise<void>
}
```

### 路径常量

```typescript
// 各服务内部定义的路径常量
import * as path from 'node:path';
import * as os from 'node:os';

const STUDIO_DIR = path.join(os.homedir(), '.studio');

// 数据层
const AUDIT_JSONL      = path.join(STUDIO_DIR, 'logs', 'audit.jsonl');
const EVENTS_JSONL     = path.join(STUDIO_DIR, 'logs', 'studio-events.jsonl');
const EXECUTIONS_JSONL = path.join(STUDIO_DIR, 'logs', 'executions.jsonl');
const NOTIFICATIONS_JSONL = path.join(STUDIO_DIR, 'logs', 'notifications.jsonl');
const INCIDENTS_JSONL  = path.join(STUDIO_DIR, 'logs', 'incidents.jsonl');
const SNAPSHOTS_DIR    = path.join(STUDIO_DIR, 'snapshots');
const OKR_DIR          = path.join(STUDIO_DIR, 'okr');

// 配置层
const ENVIRONMENTS_JSON  = path.join(STUDIO_DIR, 'environments.json');
const AGENTS_DIR         = path.join(STUDIO_DIR, 'agents');
const CAPABILITIES_DIR   = path.join(STUDIO_DIR, 'capabilities');

// 知识层
const KNOWLEDGE_DIR      = path.join(STUDIO_DIR, 'knowledge');
```

### AuditService 接口变更（AC-B1）

```typescript
// Before
class AuditService {
  constructor(private prisma: ExtendedPrismaClient) {}
  async log(input: AuditLogInput): Promise<AuditLog> { ... }
}

// After
class AuditService {
  constructor(private fileStore: FileStore) {}
  async log(input: AuditLogInput): Promise<void> {
    const entry = { id: generateId(), ...input, createdAt: new Date().toISOString() };
    await this.fileStore.appendJsonl(AUDIT_JSONL, entry);
  }
}
```

### OKR 文档格式（AC-B8）

```markdown
---
status: "active"
progress: 75
title: "2026-Q3 OKR"
quarter: "2026-Q3"
createdAt: "2026-07-01T00:00:00Z"
updatedAt: "2026-07-15T12:00:00Z"
---

# 2026-Q3 OKR

## Objectives

### O1: 提升代码质量
...

## Key Results

| KR | Target | Current | Status |
|----|--------|---------|--------|
| KR1 | 100 | 75 | on_track |
```

### Notification tombstone（AC-B4）

```typescript
// 标记已读 = 追加 tombstone 行
async markAsRead(notificationId: string): Promise<void> {
  await this.fileStore.appendJsonl(NOTIFICATIONS_JSONL, {
    id: notificationId,
    deleted: true,
    deletedAt: new Date().toISOString(),
  });
}

// 查询时过滤已删除
async getUnread(): Promise<Notification[]> {
  const rows = await this.fileStore.readJsonl<NotificationRow>(NOTIFICATIONS_JSONL);
  const latest = new Map<string, NotificationRow>();
  for (const row of rows) latest.set(row.id, row);
  return Array.from(latest.values()).filter(r => !r.deleted);
}
```

---

## 代码依赖图

```
scripts/migrate-spec2b-to-files.ts (new) ── 独立，无依赖

FileStore (packages/studio-shared)
  │
  ├── audit-service.ts (AC-B1) ── 独立
  ├── notification-service.ts (AC-B4) ── 独立
  ├── capability.service.ts (AC-C4) ── 独立
  │
  ├── env-snapper.ts (AC-B6) ── 独立
  │
  ├── executions/routes.ts (AC-B3) ── 依赖 okr.service
  ├── okr.service.ts (AC-B7, AC-B8) ── 独立
  │     ├── okr-anomaly-detector.ts (AC-B7)
  │     └── pmo/routes.ts (AC-B8)
  │
  ├── knowledge-bus.service.ts (AC-B2) ── 独立
  ├── knowledge-service.ts (AC-B2) ── 独立
  ├── resolution.service.ts (AC-B2, AC-D1) ── 独立
  │
  ├── triage-agent.service.ts (AC-B5) ── 独立
  │
  ├── session-manager.ts (AC-B2) ── 独立
  ├── output-capture.ts (AC-B2) ── 独立
  │
  ├── environments/routes.ts (AC-C1) ── 独立
  │     └── agent-configs/routes.ts (AC-C1, AC-C2, AC-C3) ── 依赖 environments
  │
  ├── agent-profile.service.ts (AC-C2) ── 独立
  └── agent-profile.routes.ts (AC-C2) ── 依赖 agent-profile.service
```

### 并行执行分组

| Phase | 文件 | 可并行 |
|-------|------|--------|
| P1: FileStore | `file-store.ts` | — |
| P2: 独立数据层 | audit-service, notification-service, capability.service, env-snapper | 4 可并行 |
| P3: knowledge 模块 | knowledge-bus.service, knowledge-service, resolution.service | 3 可并行（同模块但不同文件） |
| P4: agent 模块 | session-manager, output-capture, triage-agent | 3 可并行 |
| P5: OKR 模块 | okr.service, okr-anomaly-detector, executions/routes, pmo/routes | 串行（okr.service 是核心） |
| P6: 配置层 | environments/routes, agent-configs/routes, agent-profile.service, agent-profile.routes | environments 先，其他依赖 environments 完成后 |
| P7: 迁移脚本 | migrate-spec2b-to-files.ts | 独立 |
| P8: Schema | schema.prisma + migration | 所有代码改造完成后 |
| P9: 全量验证 | type check + tests | P8 完成后 |
