---
status: draft
version: "1.0"
---

# Spec 3: 文档系统统一 — 设计文档

## 文件映射表

### AG-1: Project 迁移

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-1.1 | `apps/api/src/modules/pmo/project.service.ts` | **重写** | 所有 `prisma.project.*` → `FileStore.readJSON/writeJSON` |
| AC-1.2 | `apps/api/src/modules/pmo/project.service.ts` | **重写** | `list()` 改为 glob 扫描；`generatePmoNumber()` 改为文件扫描 |
| AC-1.3 | `apps/api/src/modules/pmo/project.service.ts` | **重写** | `calculateProgress()` 改为读 tasks.jsonl |
| AC-1.4 | `apps/api/src/modules/pmo/project.service.ts` | **修改** | `publish()` 中 updateStatus 路径改为 FileStore |
| AC-1.5 | `packages/studio-prisma/prisma/schema.prisma` | **删除** | 删除 `model Project`（含 `@@map("project")`） |
| AC-1.5 | `apps/api/src/modules/pmo/routes.ts` | **修改** | 移除 `companyId` 参数（Spec 1 后已在运行时消除） |
| 全组 | `apps/api/src/modules/mcp/tools.ts` | **修改** | createProject/listProjects/getProjectStatus handler 改 FileStore |
| 全组 | `apps/api/src/modules/pmo/okr.service.ts` | **审查** | 检查 Project 引用，OKR 本身在 Spec 2b 已迁移 |

### AG-2: Task 迁移

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-2.1 | `apps/api/src/modules/executions/routes.ts` | **修改** | Task 读写改为 FileStore jsonl |
| AC-2.2 | `apps/api/src/modules/agents/monitor-agent.service.ts` | **修改** | Task 引用改为文件操作 |
| AC-2.3 | `apps/api/src/modules/mcp/tools.ts` | **修改** | createTask/assignTask/updateTaskStatus/getTaskBoard handler 改 FileStore |
| AC-2.4 | `packages/studio-prisma/prisma/schema.prisma` | **删除** | 删除 `model Task` |

### AG-3: Document 删除

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-3.1 | `apps/api/src/modules/knowledge/routes.ts` | **重写** | 文档读操作改 glob + FileStore.readDoc；搜索改 local-rag |
| AC-3.2 | `apps/api/src/modules/knowledge/knowledge-service.ts` | **修改** | 移除 `prisma.document.*`；保留 KnowledgeStore 逻辑 |
| AC-3.3 | `apps/api/src/modules/knowledge/import.routes.ts` | **修改** | 直接写 `~/.studio/knowledge/*.md` |
| AC-3.3 | `apps/api/src/modules/knowledge/evolution.service.ts` | **重写** | 移除 prisma.document CRUD；micro/meso 改为写 knowledge .md；decayCheck 改为文件扫描 |
| AC-3.4 | `apps/api/src/modules/mcp/tools.ts` | **修改** | storeKnowledge/searchKnowledge 改 KnowledgeStore |
| AC-3.5 | `packages/studio-prisma/prisma/schema.prisma` | **删除** | 删除 `model Document`（含 `@@map("document")`） |

### AG-4: SpecReview 迁移

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-4.1 | `apps/api/src/modules/spec-reviews/spec-review.service.ts` | **重写** | 移除 Prisma；改用 FileStore.readJSON/writeJSON |
| AC-4.2 | `apps/api/src/modules/spec-reviews/spec-review.service.ts` | **重写** | submitApproval 简化为 approve/reject + target apply |
| AC-4.3 | `apps/api/src/modules/mcp/tools.ts` | **修改** | createSpecReview/approveSpec/getSpecStatus/listSpecs 改 FileStore |
| AC-4.4 | `packages/studio-prisma/prisma/schema.prisma` | **删除** | 删除 `model SpecReview` |

### AG-5: SpecReview 子表删除

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-5.1 | `packages/studio-prisma/prisma/schema.prisma` | **删除** | 删除 model SpecReviewApproval, SpecBypass, SpecVersion |
| AC-5.2 | `packages/studio-spec/src/services/spec-version.service.ts` | **删除** | 整文件删除 |
| AC-5.2 | `packages/studio-spec/src/services/spec-bypass.service.ts` | **删除** | 整文件删除 |
| AC-5.2 | `packages/studio-spec/src/index.ts` | **修改** | 移除 SpecBypassService + SpecVersionService export |
| AC-5.3 | `apps/api/src/modules/spec-reviews/routes.ts` | **修改** | 删除 `/bypasses/*` 和 `/:reviewId/versions/*` 路由 |

### AG-6: Spec FileStore 版本管理

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-6.1 | `packages/studio-spec/src/services/` | **修改** | Spec 读写改为 FileStore.readDoc/writeDoc |
| AC-6.2 | `packages/studio-shared/src/file-store.ts` | **修改** | `generateIndex()` 支持 specs 目录 |
| AC-6.2 | `apps/api/src/modules/spec-reviews/spec-review.service.ts` | **修改** | approve 后调用 bumpVersion + appendChangelog |

### AG-7: 迁移脚本

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-7.1 | `scripts/migrate-spec3-to-files.ts` | **新增** | 数据导出脚本 |
| AC-7.2 | dommaker.cn | **验证** | 线上执行 + 验证 |

### AG-8: Prisma migration

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-8.1 | `packages/studio-prisma/prisma/migrations/` | **新增** | migration SQL |
| AC-8.1 | `packages/studio-prisma/prisma/schema.prisma` | **验证** | 确认 7 个 model 全部删除 |

---

## 接口定义

### ProjectService (重构后)

```typescript
// apps/api/src/modules/pmo/project.service.ts

import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';

const PROJECTS_DIR = path.join(os.homedir(), '.studio', 'projects');

export interface ProjectData {
  id: string;
  pmoNumber: string;
  name: string;
  status: 'active' | 'paused' | 'completed';
  priority: 'P0' | 'P1' | 'P2';
  progress: { total: number; done: number };
  gitBranch: string | null;
  specFilePath: string | null;
  createdAt: string;
  updatedAt: string;
}

// 无 companyId（Spec 1 已删除）

export const projectService = {
  create(input: CreateProjectInput): Promise<ProjectData>;
  get(projectId: string): Promise<ProjectData | null>;
  getByPmoNumber(pmoNumber: string): Promise<ProjectData | null>;
  list(options?: ProjectListOptions): Promise<ProjectData[]>;
  update(projectId: string, input: UpdateProjectInput): Promise<ProjectData>;
  updateStatus(projectId: string, status: string): Promise<ProjectData>;
  delete(projectId: string): Promise<{ success: boolean }>;
  calculateProgress(projectId: string): Promise<number>;
  publish(input: { projectId: string; channelId: string }): Promise<...>;
};
```

### TaskService (jsonl 操作)

```typescript
// 内联在 executions/routes.ts 或新建 task.service.ts

interface TaskData {
  id: string;
  projectId: string;
  assignee: string;
  status: 'pending' | 'claimed' | 'in_progress' | 'done';
  claimedBy: string | null;
  claimedAt: string | null;
  dependsOn: string[];
  acceptanceCriteria: string[];
  executionId: string | null;
  testEvidence: string | null;
  createdAt: string;
  updatedAt: string;
}

// 操作
function createTask(projectId: string, input: CreateTaskInput): Promise<TaskData>;
function claimTask(projectId: string, taskId: string, agentId: string): Promise<TaskData>;
function completeTask(projectId: string, taskId: string, evidence: string): Promise<TaskData>;
function getTaskBoard(projectId: string): Promise<TaskBoard>;
```

### SpecReviewService (重构后)

```typescript
// apps/api/src/modules/spec-reviews/spec-review.service.ts

import { FileStore } from '@dommaker/studio-shared';

const REVIEWS_DIR = path.join(os.homedir(), '.studio', 'spec-reviews');

interface SpecReviewData {
  target: string;           // "CLAUDE.md#no_test_simplification" 或 "docs/specs/xxx"
  type: 'iron_law' | 'guideline' | 'constraint';
  currentContent: string;
  proposedContent: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewer: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export class SpecReviewService {
  createReview(input: CreateReviewInput): Promise<SpecReviewData>;
  getReviews(options?: { status?: string }): Promise<SpecReviewData[]>;
  getReview(reviewId: string): Promise<SpecReviewData | null>;
  approve(reviewId: string, reviewer: string): Promise<void>;
  reject(reviewId: string, reviewer: string, reason?: string): Promise<void>;
}
```

### Knowledge API (改造后)

```typescript
// apps/api/src/modules/knowledge/routes.ts — 文档端点

// GET /api/v1/knowledge/documents → glob('docs/{sdd,specs}/**/*.md') + frontmatter 解析
// GET /api/v1/knowledge/documents/:path → FileStore.readDoc(path)

// apps/api/src/modules/knowledge/knowledge-service.ts — 知识端点

// POST /api/v1/knowledge → KnowledgeStore.write(filePath, frontmatter, body)
// GET /api/v1/knowledge/search?q= → local-rag query
// DELETE /api/v1/knowledge/:id → KnowledgeStore.delete(id)
```

### MCP Tools (改造后)

```typescript
// apps/api/src/modules/mcp/tools.ts — 受影响 tool handler

// createProject → projectService.create()
// listProjects → projectService.list()
// getProjectStatus → projectService.get()
// getTaskBoard → TaskService.getTaskBoard()
// createTask → TaskService.createTask()
// assignTask → TaskService.claimTask()
// updateTaskStatus → TaskService.completeTask()
// createSpecReview → SpecReviewService.createReview()
// approveSpec → SpecReviewService.approve()
// getSpecStatus → SpecReviewService.getReview()
// listSpecs → SpecReviewService.getReviews()
// storeKnowledge → KnowledgeStore.write()
// searchKnowledge → KnowledgeStore.search()
```

---

## 代码依赖图

```
Prisma schema (schema.prisma)
  ├── model Project ─── project.service.ts ─── routes.ts (PMO)
  │                                           └── tools.ts (MCP)
  │                                           └── okr.service.ts (审查)
  ├── model Task ────── executions/routes.ts
  │                    └── tools.ts (MCP)
  │                    └── monitor-agent.service.ts
  ├── model Document ── knowledge/routes.ts
  │                    └── knowledge-service.ts
  │                    └── import.routes.ts
  │                    └── evolution.service.ts
  │                    └── tools.ts (MCP)
  ├── model SpecReview ─ spec-review.service.ts ─── routes.ts (spec-reviews)
  │                                           └── tools.ts (MCP)
  ├── model SpecReviewApproval ─ spec-review.service.ts
  │                             └── schema.prisma (SpecReview 关联)
  ├── model SpecBypass ── spec-bypass.service.ts ── routes.ts (spec-reviews /bypasses)
  │                                               └── schema.prisma (SpecReview 关联)
  └── model SpecVersion ─ spec-version.service.ts ── routes.ts (spec-reviews /versions)
                                                    └── schema.prisma (SpecReview 关联)

FileStore (studio-shared)
  └── readJSON/writeJSON → Project, SpecReview
  └── jsonl append/query  → Task
  └── readDoc/writeDoc    → Spec
  └── bumpVersion         → Spec (on SpecReview approve)
  └── appendChangelog     → Spec (on SpecReview approve)
  └── generateIndex       → Spec _index.md
```

### 依赖图（模块间）

```
                ┌──────────┐
                │  AC-7    │ (数据迁移，需 DB 仍在)
                │  迁移脚本 │
                └──────────┘
                     │
                     ▼ (迁移后执行 AC-8)
                ┌──────────┐
                │  AC-8    │ (Prisma migration — 删除 7 个 model)
                │  schema  │
                └──────────┘

代码改造阶段（并行）:
┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
│  AG-1  │  │  AG-2  │  │  AG-3  │  │  AG-4  │
│Project │  │ Task   │  │Document│  │SpecRev │
│  迁移   │  │  迁移   │  │  删除   │  │  迁移   │
└───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘
    │ 依赖      │ Task 放在   │ 独立     │ 独立
    │ (dir)     │ project/    │          │
    └───────────┘ 下          │          │
                              │     ┌────┘
                              │     ▼
                              │  ┌────────┐  ┌────────┐
                              │  │  AG-5  │  │  AG-6  │
                              │  │子表删除 │  │ Spec   │
                              │  │        │  │FileStore│
                              │  └────────┘  └────────┘
```

**并行组**: AG-1+AG-2（Task 依赖 Project 目录结构） | AG-3 | AG-4+AG-5+AG-6（串行）

---

## 模块边界

```
apps/api/src/modules/pmo/
  边界: PMO 项目生命周期管理（创建/状态/发布）
  存储: ~/.studio/projects/{id}.json
  不负责: Task 执行（由 executions 模块负责）

apps/api/src/modules/executions/
  边界: 任务执行跟踪（claim/complete）
  存储: ~/.studio/projects/{projectId}/tasks.jsonl
  不负责: PMO 项目管理

apps/api/src/modules/knowledge/
  边界: 文档读取（文件系统）+ 知识查询（KnowledgeStore+local-rag）
  不负责: SDD 写入（由 sdd-review-skill 负责）

apps/api/src/modules/spec-reviews/
  边界: P0 约束审核闸门（提议/审批/应用）
  存储: ~/.studio/spec-reviews/{id}.json
  不负责: Spec 版本管理（由 FileStore bumpVersion 负责）

packages/studio-spec/src/
  保留: ChangeAnalyzerService, ChangeHistoryService, GateCheckerService, SpecValidatorService
  删除: SpecBypassService, SpecVersionService
```
