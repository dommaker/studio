---
status: draft
version: "1.0"
---

# Spec 3: 文档系统统一 — 需求定义

## 源项目追溯

| # | 源项目 | 产出类型 | SDD AC Group |
|---|--------|---------|-------------|
| 1 | AC-1: Project 迁移到 `~/.studio/projects/{id}.json` | 代码重构 | AG-1 |
| 2 | AC-2: Task 迁移到 `~/.studio/projects/{id}/tasks.jsonl` | 代码重构 | AG-2 |
| 3 | AC-3: Document 表删除 + knowledge 改造 | 代码重构 | AG-3 |
| 4 | AC-4: SpecReview 简化迁移到 `~/.studio/spec-reviews/{id}.json` | 代码重构 | AG-4 |
| 5 | AC-5: SpecReviewApproval + SpecBypass + SpecVersion 删除 | 删除清理 | AG-5 |
| 6 | AC-6: Spec 文档纳入 FileStore 版本管理 | 代码重构 | AG-6 |
| 7 | AC-7: 数据迁移脚本 | 新增脚本 | AG-7 |
| 8 | AC-8: Prisma migration 生成 | Schema 变更 | AG-8 |

## 前置条件

- Spec 1 完成（Company 已删除，Project/Document/OKR 的 companyId 外键已清理）
- Spec 2a 完成（FileStore 具有 markdown 读写/索引管理/版本管理能力）

---

## AC Group 1: Project 迁移 (covers: [1])

将 Project 运行时状态从 Prisma 迁移到文件存储 `~/.studio/projects/{id}.json`。

### AC-1.1: FileStore JSON 读写 Project

**触发条件**: PMO 调用 Project CRUD API
**预期行为**:
- `project.service.ts` 所有 Prisma 调用替换为 `FileStore.readJSON<T>()` / `FileStore.writeJSON<T>()`
- 数据文件路径: `~/.studio/projects/{id}.json`
- 数据格式参照 spec 中定义的 JSON schema
- `specFilePath` 字段指向 SDD 目录，可为 null

**边界情况**:
- 文件不存在 → 返回 404
- JSON 解析失败 → 返回 500 + log
- 并发写入 → 复用 FileStore flock

**不做项**:
- 不改变 API 响应格式（`projectService.create()` 签名可调整但返回结构不变）
- 不改变 PMO 路由路径 `/api/v1/pmo/project/*`
- 不改变 getLinkedSDDs（已在读文件系统）

### AC-1.2: Project 列表/查询

**触发条件**: 按 status/priority/pmoNumber 查询
**预期行为**:
- `list()`: 扫描 `~/.studio/projects/` 目录 → `glob('*.json')` → 逐个 readJSON → 内存过滤
- `getByPmoNumber()`: 扫描所有 project 文件 → 按 pmoNumber 匹配
- `generatePmoNumber()`: 扫描所有 project 文件 → 找最大 PMO 编号 + 1

**边界情况**:
- 空目录（无项目）→ 返回空数组
- pmoNumber 不存在 → 返回 null
- 大量项目（>1000）→ glob 性能可接受（本地数据量小）

### AC-1.3: 项目进度计算

**触发条件**: PMO 打开项目看板
**预期行为**:
- `calculateProgress()` 不再用 `prisma.task.count()`，改为读 `~/.studio/projects/{id}/tasks.jsonl` → 统计 status=completed 占比
- tasks.jsonl 不存在 → progress = 0
- progress 值域 0-100

### AC-1.4: 项目发布

**触发条件**: PMO 发布项目到 Channel
**预期行为**:
- `publish()` 保持现有 ChannelMessage + WorkUnit 逻辑
- `updateStatus(pending → active)` 操作替换为 FileStore writeJSON
- WorkUnitService 的 prisma 参数已移除（Spec 2a 迁移）

### AC-1.5: Prisma model 删除

**触发条件**: 所有 Project 代码改造完成 + 测试通过
**预期行为**:
- `schema.prisma` 删除 `model Project`
- `SchemaChangeWindow` 确认无残留 Prisma 引用
- `npx tsc --noEmit` 无类型错误

---

## AC Group 2: Task 迁移 (covers: [2])

将 Task 运行时状态从 Prisma 迁移到 `~/.studio/projects/{id}/tasks.jsonl`。

### AC-2.1: Task JSONL 读写

**触发条件**: 任务 create/claim/complete
**预期行为**:
- 所有 Task CRUD 替换为 JSONL 追加 + 内存索引
- 文件路径: `~/.studio/projects/{projectId}/tasks.jsonl`
- 每行一条完整 JSON（见 spec 格式）
- `create` → appendLine; `claim` → appendLine + 更新前一条的 index; `complete` → appendLine + 更新

**边界情况**:
- 目录不存在 → mkdir 创建
- JSONL 为空 → 初始化为空数组索引
- 同一 task 并发 claim → flock 互斥

**不做项**:
- 不实现 JSONL 的随机删除（append-only 设计）
- 不改变 Task API 响应语义（Task CRUD 响应格式不变）

### AC-2.2: 执行模块 Task 迁移

**触发条件**: execution/agent 模块操作 Task
**预期行为**:
- `apps/api/src/modules/executions/routes.ts` 中 Task 相关代码改为 FileStore jsonl 操作
- `apps/api/src/modules/agents/monitor-agent.service.ts` 中 Task 引用改为文件操作

### AC-2.3: MCP tools Task 迁移

**触发条件**: MCP tool createTask/assignTask/updateTaskStatus/getTaskBoard 调用
**预期行为**:
- 所有 MCP Task tool handler 改为 FileStore jsonl 操作
- 接口定义（参数/返回值）不变

### AC-2.4: Prisma model 删除

**触发条件**: 所有 Task 代码改造完成 + 测试通过
**预期行为**:
- `schema.prisma` 删除 `model Task`
- `npx tsc --noEmit` 无类型错误

---

## AC Group 3: Document 表删除 (covers: [3])

删除 Prisma Document 表，knowledge API 改读文件系统。

### AC-3.1: Knowledge routes 改文件系统

**触发条件**: `/api/knowledge/*` 请求
**预期行为**:
- 文档列表：`glob('docs/{sdd,specs}/**/*.md')` + frontmatter 解析 → 返回列表
- 文档读取：`FileStore.readDoc(path)` → 返回 frontmatter + body
- 搜索：委托 `local-rag` 向量搜索
- API 路径保持不变

**边界情况**:
- `docs/sdd/_index.md` 不存在 → 生成或返回空列表
- 扫描目录不存在 → 返回空数组
- 二进制文件被 glob 匹配 → 按 `.md` 扩展名过滤

**不做项**:
- 不拆分 API 路径（`/api/documents/*` 不在本 spec 范围）

### AC-3.2: knowledge-service 职责拆分

**触发条件**: knowledge-service 调用
**预期行为**:
- `knowledge-service.ts` 移除所有 `prisma.document.*` 调用
- 文档操作逻辑移到文件系统扫描
- 保留知识操作逻辑（KnowledgeStore 读写）

### AC-3.2a: evolution.service 改造

**触发条件**: 进化引擎需要查询/创建/更新 Document
**预期行为**:
- `evolution.service.ts` 移除所有 `prisma.document.*` 调用（含 microEvolution/mesoEvolution/macroEvolution/decayCheck/getHealthMetrics）
- micro/meso 进化产出的知识条目改为直接写 `~/.studio/knowledge/*.md` + KnowledgeBus.recordPattern
- macro 进化的 `prisma.project.findMany` 改为扫描 `~/.studio/projects/` 目录
- decayCheck 的 batch update 改为逐文件更新 frontmatter maturity 字段
- getHealthMetrics 的 count/groupBy 改为扫描 knowledge 目录统计

### AC-3.3: import.routes 改文件系统

**触发条件**: 知识导入请求
**预期行为**:
- `import.routes.ts` 直接写 `~/.studio/knowledge/*.md` 文件
- 不再同步到 Prisma Document 表

### AC-3.4: MCP tools 改造

**触发条件**: MCP storeKnowledge/searchKnowledge 调用
**预期行为**:
- 文档相关 tool（readDocument/listDocuments）→ 读文件系统
- 知识相关 tool（storeKnowledge/searchKnowledge）→ KnowledgeStore

### AC-3.5: Prisma model 删除

**触发条件**: 所有 Document 代码改造完成 + 测试通过
**预期行为**:
- `schema.prisma` 删除 `model Document`
- `npx tsc --noEmit` 无类型错误

---

## AC Group 4: SpecReview 简化迁移 (covers: [4])

SpecReview 保留 P0 约束审核闸门功能，实现改为 FileStore。

### AC-4.1: SpecReview JSON 存储

**触发条件**: Agent 通过 MCP createSpecReview 提议或人通过 API 创建/查看审查
**预期行为**:
- `spec-review.service.ts` 移除所有 Prisma 依赖
- read/write: `FileStore.readJSON/writeJSON` 操作 `~/.studio/spec-reviews/{id}.json`
- JSON schema 按 spec 定义（target/type/currentContent/proposedContent/reason/status/reviewer/reviewedAt/createdAt）

**边界情况**:
- 文件不存在 → 返回 404
- 目录不存在 → mkdir 创建

### AC-4.2: approve 流程

**触发条件**: 人审批 spec review（approve/reject）
**预期行为**:
- approve → 按 target 类型应用变更（spec 文件用 bumpVersion+appendChangelog，CLAUDE.md/rules 直接写文件，知识条目直接写文件）
- 变更应用后删除 `~/.studio/spec-reviews/{id}.json`
- reject → 直接删除 review 文件

**边界情况**:
- target 文件不存在 → 报错，不删除 review
- bumpVersion 失败 → 回滚，不删除 review

### AC-4.3: MCP tools 改造

**触发条件**: MCP createSpecReview/approveSpec/getSpecStatus/listSpecs 调用
**预期行为**:
- handler 改为 FileStore 操作
- 接口定义不变

### AC-4.4: Prisma model 删除

**触发条件**: 所有 SpecReview 代码改造完成 + 测试通过
**预期行为**:
- `schema.prisma` 删除 `model SpecReview`
- `npx tsc --noEmit` 无类型错误

---

## AC Group 5: SpecReview 子表删除 (covers: [5])

删除 SpecReviewApproval + SpecBypass + SpecVersion 三个子表及相关代码。

### AC-5.1: Prisma models 删除

**触发条件**: SpecReview 已迁移到 FileStore，不再需要子表
**预期行为**:
- `schema.prisma` 删除 model SpecReviewApproval、SpecBypass、SpecVersion
- 关联字段清理（SpecReview 的 SpecBypass?/SpecReviewApproval[]/SpecVersions[] 已在 AC-4 中随 model 一起删）

### AC-5.2: studio-spec 代码删除

**触发条件**: 子表删除后相关 service 成为死代码
**预期行为**:
- `packages/studio-spec/src/services/spec-version.service.ts` 删除（版本管理由 FileStore + CHANGELOG.md 替代）
- `packages/studio-spec/src/services/spec-bypass.service.ts` 删除
- `packages/studio-spec/src/index.ts` 移除 SpecBypassService 和 SpecVersionService 的 export

**注**: `change-approver.service.ts` 已在 Spec 1 中删除，无需额外操作。

### AC-5.3: SpecReview 路由清理

**触发条件**: Bypass + Version 路由不再可用
**预期行为**:
- `apps/api/src/modules/spec-reviews/routes.ts` 删除所有 `/bypasses/*` 和 `/:reviewId/versions/*` 路由
- 移除 `getSpecBypassService` / `getSpecVersionService` 的 import

### AC-5.4: 测试更新

**触发条件**: 删除后全量测试
**预期行为**:
- spec-bypass.service.test.ts 和 spec-version.service.test.ts（如存在）删除
- spec-reviews route 测试更新（移除 bypass/version 端点测试）
- 全量测试通过

---

## AC Group 6: Spec 文档纳入 FileStore 版本管理 (covers: [6])

Spec 文档（`docs/specs/`）使用 FileStore markdown 能力，统一 SDD 模式。

### AC-6.1: Spec 读写改造

**触发条件**: Spec 文件的读写操作
**预期行为**:
- Spec 文件读写使用 `FileStore.readDoc(path)` / `FileStore.writeDoc(path, frontmatter, body)`
- frontmatter 增加 `version`/`changeType`/`changeDesc` 字段（与 SDD 统一）

### AC-6.2: Spec 索引生成

**触发条件**: Spec 目录变更
**预期行为**:
- `docs/specs/` 下生成 `_index.md`（格式参照 SDD 的 `_index.md`）
- 索引内容：spec slug、标题、状态、版本、分类

### AC-6.3: SpecReview 版本联动

**触发条件**: SpecReview approve 且 target 在 `docs/specs/`
**预期行为**:
- 调用 `FileStore.bumpVersion(specPath)` + `FileStore.appendChangelog(specPath, changeDesc)`

---

## AC Group 7: 数据迁移脚本 (covers: [7])

从 DB 导出存量数据到文件系统。

### AC-7.1: 脚本实现

**触发条件**: 所有代码改造完成，准备运行 Prisma migration 前执行
**预期行为**:
- `scripts/migrate-spec3-to-files.ts`：
  - 从 DB `SELECT * FROM project` → 写 `~/.studio/projects/{id}.json`（每项目一个文件）
  - 从 DB `SELECT * FROM Task` → 按 projectId 分组 → 写 `~/.studio/projects/{projectId}/tasks.jsonl`
  - 从 DB `SELECT * FROM SpecReview JOIN SpecVersion ON ...` → 写 `~/.studio/spec-reviews/{id}.json`
  - Document 表：扫描 `docs/` 目录，确认内容重叠，不迁移
- `--dry-run` 模式：只打印会生成的文件，不写磁盘
- 输出迁移统计：导出 N 个 Project、M 个 Task、K 个 SpecReview

**边界情况**:
- 目标目录已存在同名文件 → 交互式确认（--force 跳过确认）
- DB 有数据但 Project 的 companyId 已删除（Spec 1 后）→ companyId 字段不写入 JSON

### AC-7.2: 线上验证

**触发条件**: 在 dommaker.cn 执行迁移
**预期行为**:
- `--dry-run` 先验证
- 实际迁移后验证文件完整性（JSON parse、count 对比）
- 验证后执行 Prisma migration 删除表

---

## AC Group 8: Prisma migration 生成 (covers: [8])

生成并运行 Prisma migration，完成最终清理。

### AC-8.1: Migration 生成与验证

**触发条件**: 所有代码改造 + 数据迁移完成
**预期行为**:
- `npx prisma migrate dev --name migrate-doc-tables` 生成 migration
- `npx prisma validate` 通过
- `npx tsc --noEmit` 无类型错误
- 全量测试通过
