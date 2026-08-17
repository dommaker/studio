---
status: draft
version: "1.0"
---

# Spec 3: 文档系统统一 — 任务规划

## 执行顺序

```
Phase 1 [safe]: AG-1 Project 迁移
Phase 2 [safe]: AG-2 Task 迁移 (依赖 Phase 1 — tasks 目录在 project/ 下)
Phase 3 [safe]: AG-3 Document 删除 (独立)
Phase 4 [breaking]: AG-4 SpecReview 迁移 (独立)
Phase 5 [safe]: AG-5 SpecReview 子表删除 (依赖 Phase 4 — 审批流程已简化)
Phase 6 [safe]: AG-6 Spec FileStore (依赖 Phase 4 — approve 后 bumpVersion)
Phase 7 [safe]: AG-7 数据迁移脚本 (依赖 Phase 1-6 代码改造完成)
Phase 8 [destructive]: AG-8 Prisma migration (依赖 Phase 7 数据已导出)
```

**并行组**:
- Phase 1+2：串行（Task 依赖 Project 目录）
- Phase 3：可与 Phase 1+2 并行
- Phase 4+5+6：串行（后两个依赖 Phase 4 完成，但可与 Phase 1-3 并行）

---

## 里程碑

| M# | 位置 | 验收条件 | 状态 |
|----|------|---------|------|
| M1 | Phase 1 完成 | Project CRUD 测试通过，PMO 路由测试通过，无 prisma.project 引用 | |
| M2 | Phase 2 完成 | Task CRUD 测试通过，无 prisma.task 引用 | |
| M3 | Phase 3 完成 | Document API 测试通过，无 prisma.document 引用 | |
| M4 | Phase 4 完成 | SpecReview 提议/审批/拒绝 测试通过，无 prisma.specReview 引用 | |
| M5 | Phase 5 完成 | spec-version/spec-bypass 文件删除确认，studio-spec index 无残留 export | |
| M6 | Phase 6 完成 | Spec FileStore 读写测试通过，_index.md 生成正确 | |
| M7 | Phase 7 完成 | 迁移脚本 `--dry-run` 验证通过 | |
| M8 | Phase 8 完成 | `npx prisma validate` + `npx tsc --noEmit` + 全量测试通过 | |

---

## Phase 1 [safe]: AG-1 Project 迁移

### 风险等级: safe
无破坏性操作，只替换存储层。

### 1.1 契约测试 — AC-1.1 + AC-1.2

**文件**: `apps/api/src/modules/pmo/__tests__/project.service.test.ts` (新增/改造)

```typescript
describe('ProjectService — FileStore 迁移', () => {
  // RED: 每个测试先写 FAIL 版

  it('create: 创建项目 → ~/.studio/projects/{id}.json 存在且内容匹配');
  it('get: 读取存在项目 → 返回 ProjectData 类型');
  it('get: 文件不存在 → 返回 null');
  it('getByPmoNumber: 按 PMO 号查找 → 找到匹配项目');
  it('getByPmoNumber: PMO 号不存在 → 返回 null');
  it('list: 无过滤条件 → 返回所有项目');
  it('list: 按 status 过滤 → 只返回匹配项目');
  it('list: 空目录 → 返回空数组');
  it('update: 更新字段 → 文件内容更新');
  it('delete: 删除 pending 项目 → 文件被删除');
  it('delete: 删除 active 项目 → throw Error');
  it('generatePmoNumber: 首次创建 → 返回 PM-001');
  it('generatePmoNumber: 递增 → 返回 PM-00X');
});
```

### 1.2 契约测试 — AC-1.3

```typescript
describe('calculateProgress', () => {
  it('有 tasks.jsonl → 按 completed/total 计算百分比');
  it('tasks.jsonl 不存在 → 返回 0');
  it('所有 task 完成 → 返回 100');
});
```

### 1.3 契约测试 — AC-1.4

```typescript
describe('publish', () => {
  it('pending 项目发布 → 状态变为 active');
  it('非 pending 项目发布 → throw Error');
});
```

### 1.4 契约测试 — AC-1.5

```typescript
describe('Prisma model 删除验证', () => {
  it('grep prisma.project 无残留（排除 migration 历史）');
});
```

### 1.5 Route 测试

**文件**: `apps/api/src/modules/pmo/__tests__/routes.test.ts` (改动)

```typescript
describe('PMO Project Routes', () => {
  it('POST /pmo/project → 201 + ProjectData');
  it('GET /pmo/project → 200 + ProjectData[]');
  it('GET /pmo/project/:id → 200 + ProjectData');
  it('GET /pmo/project/:id → 404');
  it('GET /pmo/project/by-pmo/:pmoNumber → 200');
  it('PATCH /pmo/project/:id → 200 + 更新后数据');
  it('PATCH /pmo/project/:id/status → 200 + 状态变更');
  it('PATCH /pmo/project/:id/status invalid → 400');
  it('DELETE /pmo/project/:id → 200');
});
```

---

## Phase 2 [safe]: AG-2 Task 迁移

### 风险等级: safe
jsonl 是增量追加，不丢失数据。

### 2.1 契约测试 — AC-2.1

**文件**: `apps/api/src/modules/executions/__tests__/task.service.test.ts` (新增)

```typescript
describe('TaskService — FileStore jsonl', () => {
  it('createTask: 追加一行到 tasks.jsonl');
  it('createTask: 目录不存在 → mkdir + append');
  it('claimTask: 追加 claim 行 + 更新前一行 index');
  it('claimTask: 同一 task 并发 claim → 第二个失败（flock）');
  it('completeTask: 追加 complete 行');
  it('getTaskBoard: 解析 jsonl → 返回当前状态');
  it('getTaskBoard: jsonl 为空 → 返回空 board');
});
```

### 2.2 契约测试 — AC-2.2

```typescript
describe('Execution routes — Task 端点', () => {
  it('GET /executions/:id → 含 task 状态');
  it('POST /executions/:id/claim → 返回 claimed task');
});
```

### 2.3 契约测试 — AC-2.3

```typescript
describe('MCP tools — Task', () => {
  it('createTask tool → 写入 tasks.jsonl');
  it('assignTask tool → 追加 claim 行');
  it('updateTaskStatus tool → 追加 complete 行');
  it('getTaskBoard tool → 返回 board 数据');
});
```

---

## Phase 3 [safe]: AG-3 Document 删除

### 风险等级: safe
保持 API 路径和响应格式。

### 3.1 契约测试 — AC-3.1

**文件**: `apps/api/src/modules/knowledge/__tests__/routes.test.ts` (新增/改造)

```typescript
describe('Knowledge routes — 文档', () => {
  it('GET /knowledge/documents → 返回 docs/ 下 .md 文件列表');
  it('GET /knowledge/documents → 空目录 → 返回 []');
  it('GET /knowledge/documents/:path → 返回 frontmatter + body');
  it('GET /knowledge/documents/:path → 文件不存在 → 404');
  it('GET /knowledge/search?q=... → local-rag 结果');
});
```

### 3.2 契约测试 — AC-3.2

```typescript
describe('knowledge-service', () => {
  it('storeKnowledge: 写入 ~/.studio/knowledge/{id}.md');
  it('searchKnowledge: 调用 local-rag query');
  it('deleteKnowledge: 删除 knowledge 文件');
  // 注：不含 prisma.document 调用
});
```

### 3.3 契约测试 — AC-3.3

```typescript
describe('import routes', () => {
  it('POST /knowledge/import → 写入 .md 文件');
  it('不产生 prisma.document 记录');
});
```

### 3.4 契约测试 — AC-3.2a (evolution.service)

```typescript
describe('evolution.service — FileStore 改造', () => {
  it('microEvolution: 产出写 ~/.studio/knowledge/{id}.md');
  it('mesoEvolution: 模式识别产出写 knowledge .md');
  it('macroEvolution: 扫描 projects/ 目录而非 prisma.project');
  it('decayCheck: 更新 frontmatter maturity 而非 prisma.document.update');
  it('getHealthMetrics: 统计 knowledge 目录而非 prisma.document.count');
});
```

---

## Phase 4 [breaking]: AG-4 SpecReview 迁移

### 风险等级: breaking
API 行为变化：双签变单签，bypass/version 端点移除。

### 4.1 契约测试 — AC-4.1

**文件**: `apps/api/src/modules/spec-reviews/__tests__/spec-review.service.test.ts` (新增)

```typescript
describe('SpecReviewService — FileStore', () => {
  it('createReview: 写 ~/.studio/spec-reviews/{id}.json');
  it('createReview: 生成唯一 ID');
  it('getReviews: 扫描目录 → 返回列表');
  it('getReviews: 按 status 过滤');
  it('getReview: 存在 → 返回 SpecReviewData');
  it('getReview: 不存在 → 返回 null');
});
```

### 4.2 契约测试 — AC-4.2

```typescript
describe('SpecReviewService — approve/reject', () => {
  it('approve: target 为 spec 文件 → bumpVersion + appendChangelog → 删除 review');
  it('approve: target 为 CLAUDE.md → 直接写入文件 → git commit → 删除 review');
  it('approve: target 为知识条目 → 直接写入 .md → 删除 review');
  it('approve: target 文件不存在 → throw + review 不删除');
  it('reject: → 删除 review 文件');
  it('approve + bumpVersion 失败 → 回滚 + review 不删除');
});
```

### 4.3 Route 测试

```typescript
describe('SpecReview Routes', () => {
  it('GET /spec-reviews → 200 + list');
  it('GET /spec-reviews/:id → 200 + data');
  it('POST /spec-reviews → 201');
  it('POST /spec-reviews/:id/approve → 200 + approved');
  // 注：bypass/version 路由已在 Phase 5 删除
});
```

---

## Phase 5 [safe]: AG-5 SpecReview 子表删除

### 风险等级: safe
仅删除，无新逻辑。

### 5.1 契约测试 — AC-5.1

```typescript
describe('Prisma models 删除', () => {
  it('grep SpecReviewApproval 无残留');
  it('grep SpecBypass 无残留');
  it('grep SpecVersion 无残留');
});
```

### 5.2 契约测试 — AC-5.2

```typescript
describe('studio-spec 清理', () => {
  it('spec-version.service.ts 文件不存在');
  it('spec-bypass.service.ts 文件不存在');
  it('index.ts 不导出 SpecBypassService');
  it('index.ts 不导出 SpecVersionService');
  it('index.ts 不导出 SpecBypass/CreateVersionInput 等类型');
});
```

### 5.3 契约测试 — AC-5.3

```typescript
describe('SpecReview Routes 清理', () => {
  it('不包含 /bypasses 路由');
  it('不包含 /versions 路由');
  it('不 import getSpecBypassService');
  it('不 import getSpecVersionService');
});
```

---

## Phase 6 [safe]: AG-6 Spec FileStore 版本管理

### 风险等级: safe
使用已在 Spec 2a 中验证的 FileStore 能力。

### 6.1 契约测试 — AC-6.1

```typescript
describe('Spec FileStore 读写', () => {
  it('readDoc: 读取 spec 文件 → frontmatter 含 version/changeType/changeDesc');
  it('writeDoc: 写入 spec → frontmatter 保留版本字段');
  it('bumpVersion: version 递增');
  it('appendChangelog: CHANGELOG.md 追加记录');
});
```

### 6.2 契约测试 — AC-6.2

```typescript
describe('Spec _index.md', () => {
  it('generateIndex: 生成 docs/specs/_index.md');
  it('_index.md 包含所有 spec 条目（slug/标题/状态/版本)');
});
```

---

## Phase 7 [safe]: AG-7 数据迁移脚本

### 风险等级: safe
--dry-run 先行，不破坏数据。

### 7.1 测试

```typescript
describe('migrate-spec3-to-files', () => {
  it('--dry-run: 打印导出摘要，不写文件');
  it('导出 Project → json 文件可 JSON.parse');
  it('导出 Task → jsonl 每行可 JSON.parse');
  it('导出 SpecReview → json 文件可 JSON.parse');
  it('导出后 count 与 DB 一致');
  it('--force: 覆盖已存在文件');
  it('Document 表: 只检查不迁移');
});
```

---

## Phase 8 [destructive]: AG-8 Prisma migration

### 风险等级: destructive
⚠️ **不可逆操作**。删除 7 个 Prisma model + 对应数据库表。执行前必须确认：
- [ ] `scripts/migrate-spec3-to-files.ts` 已执行成功
- [ ] 迁移输出所有文件已验证
- [ ] 全量测试通过（验证代码不依赖这 7 个表）
- [ ] 有备份（git commit 保存 schema + migration 前 DB）

### 8.1 验证

```bash
npx prisma migrate dev --name migrate-doc-tables
npx prisma validate  # 应通过
npx tsc --noEmit      # 无类型错误
pnpm test             # 全量测试通过
```

---

## Implementation Readiness

implementationReady: **true**

| # | 条件 | 满足 | 证据 |
|---|------|------|------|
| 1 | design.md 有精确 file:line 引用 | ✅ | 文件映射表含具体文件路径 + 改动类型 |
| 2 | 非平凡变更有 before/after 代码块 | ✅ | design.md 接口定义节含重构后签名 + 数据格式 |
| 3 | 消费方覆盖（谁 import 受影响文件） | ✅ | 依赖图标注了每个 model 的消费者；MCP tools 已枚举 |
| 4 | 测试断言具体（不只是"测试通过"） | ✅ | task.md 每个 AC 有具体测试用例（含输入/预期输出） |
| 5 | 接口定义完整（签名+参数+返回值） | ✅ | design.md 含 ProjectData/TaskData/SpecReviewData 类型 + 所有方法签名 |

**证据详情**:
- 1: 33 个文件映射条目，每项标注具体路径和改动类型（新增/修改/删除/重写）
- 2: ProjectService/SpecReviewService/Knowledge API 有重构后完整接口定义
- 3: 代码依赖图逐模块标注 prisma model → service → route → MCP tool 消费链
- 4: 50+ 具体测试用例，每个含触发条件和预期行为
- 5: 3 个核心数据类型（ProjectData/TaskData/SpecReviewData）有完整字段定义，6 个方法组有签名+参数+返回值

## 概要

| Phase | 风险 | 文件变更 | 测试 |
|-------|------|---------|------|
| 1: Project 迁移 | safe | 5 文件 | ~13 用例 |
| 2: Task 迁移 | safe | 4 文件 | ~10 用例 |
| 3: Document 删除 | safe | 6 文件 | ~8 用例 |
| 4: SpecReview 迁移 | breaking | 3 文件 | ~12 用例 |
| 5: 子表删除 | safe | 5 文件 | ~7 用例 |
| 6: Spec FileStore | safe | 3 文件 | ~6 用例 |
| 7: 迁移脚本 | safe | 1 新增 | ~7 用例 |
| 8: Prisma migration | **destructive** | 1 migration | 全量 |

**总计**: ~27 文件变更 + 1 新增脚本 + 1 migration | ~63 测试用例
