---
status: done
version: "1.0"
---

# Spec 2b: 数据层与配置层表迁移 — 任务文档

## 契约测试规划

### AC Group A：FileStore 公开方法

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-A1 | `file-store.test.ts` [exists] | 直接调用 `store.appendJsonl(path, data)` → 文件有新行 |
| AC-A1 | `file-store.test.ts` [exists] | 直接调用 `store.readJsonl<T>(path)` → 返回解析后的数组 |
| AC-A1 | `file-store.test.ts` [exists] | 直接调用 `store.readJson<T>(path)` → 返回解析对象 |
| AC-A1 | `file-store.test.ts` [exists] | 直接调用 `store.writeJson(path, data)` → 文件写入正确 |
| AC-A1 | `file-store.test.ts` [exists] | 损坏 JSON 文件 `readJson` 返回 null（不抛异常） |
| AC-A1 | `file-store.test.ts` [exists] | 不存在文件 `readJson` 返回 null |

### AC Group B：数据层表迁移

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-B1 | `audit-service.test.ts` [exists] | `log()` → jsonl 新增一行，包含所有字段 |
| AC-B1 | `audit-service.test.ts` [exists] | `logBatch()` → 追加 N 行 |
| AC-B1 | `audit-service.test.ts` [exists] | `query({ userId })` → 返回匹配记录 |
| AC-B1 | `audit-service.test.ts` [exists] | `query({ startTime, endTime })` → 时间范围过滤正确 |
| AC-B1 | `audit-service.test.ts` [exists] | `getStats()` → 聚合数据与预期一致 |
| AC-B2 | `knowledge-bus.test.ts` [exists] | studioEvent create → jsonl 有新行，字段完整 |
| AC-B2 | `knowledge-service.test.ts` [exists] | studioEvent create → jsonl 有新行 |
| AC-B2 | `session-manager-stream.test.ts` [exists] | 事件写入 → jsonl 新行 |
| AC-B2 | `output-capture.test.ts` [NEW] | 输出捕获 → jsonl 新行 |
| AC-B2 | `okr-b8.test.ts` [exists] | studioEvent query → 从 jsonl 读取并过滤正确 |
| AC-B3 | `executions/__tests__/routes.test.ts` [NEW] | execution 写入 → jsonl 新行 |
| AC-B3 | `executions/__tests__/routes.test.ts` [NEW] | 查询按 status → 过滤正确 |
| AC-B4 | `notification-service.test.ts` [exists] | 创建通知 → jsonl 有记录 |
| AC-B4 | `notification-service.test.ts` [exists] | 未读查询 → 只返回未标记删除的 |
| AC-B4 | `notification-service.test.ts` [exists] | 标记已读 → 追加 tombstone，查询不再返回 |
| AC-B5 | `triage-agent.test.ts` [exists] | 故障记录写入 → jsonl 新行 |
| AC-B6 | `knowledge/__tests__/env-snapper.test.ts` [NEW] | 快照创建 → 生成 `{timestamp}.json` 文件 |
| AC-B6 | `knowledge/__tests__/env-snapper.test.ts` [NEW] | 按时间查询 → 扫描目录返回匹配文件 |
| AC-B7 | `okr-b8.test.ts` [exists] | syncKRProgress → jsonl 追加 KR 进度行 |
| AC-B7 | `okr-b8.test.ts` [exists] | 按 okrId 查询 → 过滤正确 |
| AC-B8 | `okr-b8.test.ts` [exists] | create OKR → 生成 `{quarter}.md`，frontmatter + body 正确 |
| AC-B8 | `okr-b8.test.ts` [exists] | list OKR → 扫描 okr 目录返回所有 |
| AC-B8 | `okr-b8.test.ts` [exists] | update OKR → frontmatter progress 更新 |
| AC-B8 | `okr-b8.test.ts` [exists] | delete OKR → 文件删除 |
| AC-B8 | `okr-b8.test.ts` [exists] | get OKR → 返回 frontmatter + body |

### AC Group C：配置层表迁移

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-C1 | `environments/__tests__/routes.test.ts` [NEW] | CRUD 操作通过 JSON 文件正确 |
| AC-C1 | `agent-configs/__tests__/routes.test.ts` [NEW] | environment 字段为 name 字符串 |
| AC-C2 | `agent-profile.service.test.ts` [exists] | Agent CRUD → `agents/{id}.json` 正确 |
| AC-C2 | `agent-profile.service.test.ts` [exists] | AgentConfig 字段合并到同一文件 |
| AC-C3 | `agent-configs/__tests__/routes.test.ts` [NEW] | 版本追加 → `versions.jsonl` 新行 |
| AC-C3 | `agent-configs/__tests__/routes.test.ts` [NEW] | 回溯版本历史 → 返回所有版本 |
| AC-C4 | `capability.service.test.ts` [NEW] | CRUD 通过 `capabilities/{name}.json` 正确 |

### AC Group D：知识层迁移

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-D1 | `resolution.service.test.ts` [exists] | `matchResolutions()` → 匹配逻辑与迁移前一致 |
| AC-D1 | `resolution.service.test.ts` [exists] | `createResolution()` → 生成知识条目 md 文件 |
| AC-D1 | `resolution.service.test.ts` [exists] | `verifyResolution()` → verifyCount++ 写入 frontmatter |
| AC-D1 | `resolution.service.test.ts` [exists] | `listPending()` → 返回 maturity=pending 的条目 |
| AC-D1 | `resolution.service.test.ts` [exists] | `ensureSeedResolutions()` → 幂等，生成 2 个知识条目 |
| AC-D1 | `resolution.service.test.ts` [exists] | `getDensityScore()` → 统计与迁移前一致 |

### AC Group E：迁移脚本 + 收尾

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-E1 | 手动验证（非自动化） | `--dry-run` 输出预览正确 |
| AC-E1 | 手动验证 | 正式执行后文件生成 |
| AC-E1 | 手动验证 | 重复执行幂等 |
| AC-E2 | 全量测试 | `npx prisma validate` 通过 |
| AC-E2 | 全量测试 | `npx tsc --noEmit` 无错误 |
| AC-E2 | 全量测试 | `pnpm test` 全量通过 |

---

## 执行顺序

### Phase 1: FileStore 扩展 [safe]
- AC-A1: `file-store.ts` 4 个方法 private → public
- 独立，无依赖
- 验证: file-store 测试通过

### Phase 2: 独立数据层服务 [safe]（4 文件可并行）
- AC-B1: `audit-service.ts`
- AC-B4: `notification-service.ts`
- AC-B6: `env-snapper.ts`
- AC-C4: `capability.service.ts`
- 均独立于其他模块
- 验证: 各自测试通过

### Phase 3: Knowledge 模块 [safe]（3 文件可并行）
- AC-B2 (knowledge-bus.service): 6 处 studioEvent.create
- AC-B2 (knowledge-service): 3 处 studioEvent.create
- AC-B2 (resolution.service): 1 处 studioEvent.create
- 同模块不同文件，修改不冲突
- 验证: knowledge 模块测试通过

### Phase 4: Agent 模块 [safe]（3 文件可并行）
- AC-B2 (session-manager): 2 处 studioEvent.create
- AC-B2 (output-capture): 5 处 studioEvent.create
- AC-B5 (triage-agent): incident migration
- 验证: agent 模块测试通过

### Phase 5: OKR + Execution 模块 [safe]
- AC-B8 (okr.service): OKR CRUD → FileStore
- AC-B7 (okr.service): KRHistory → jsonl
- AC-B3 (executions/routes + okr.service): Execution → jsonl
- AC-B3 (pmo/routes): Execution 关联
- 顺序: AC-B8 → AC-B7 → AC-B3（共享同一 service）
- 验证: PMO 模块测试通过

### Phase 6: 配置层 [safe]
- AC-C1 (environments/routes): Environment → JSON
- AC-C1 (agent-configs/routes): environmentId → name 引用
- AC-C2 (agent-profile.service + routes): Agent + AgentConfig 合并
- AC-C3 (agent-configs/routes): AgentConfigVersion → jsonl
- 顺序: AC-C1 先 → AC-C2/AC-C3 后（依赖 name 引用）
- 验证: agent + environment 模块测试通过

### Phase 7: Resolution 知识库迁移 [safe]
- AC-D1 (resolution.service): Resolution → 知识条目 md
- 依赖: 知识库已有索引能力（Spec 2a）
- 验证: resolution 测试通过

### Phase 8: 迁移脚本 [safe]
- AC-E1: `scripts/migrate-spec2b-to-files.ts`
- 独立新文件
- 验证: `--dry-run` 输出正确

### Phase 9: Schema 清理 + 全量验证 [destructive]
- AC-E2: Prisma schema 删除 14 model + migration
- 全量 `pnpm test` + `npx tsc --noEmit` + `npx prisma validate`
- **⚠️ DESTRUCTIVE**: 删除 14 个 Prisma model 不可逆（可通过 migration rollback 恢复）
- 验证: 所有检查通过

---

## 里程碑

| 里程碑 | 完成标志 | 风险 |
|--------|---------|------|
| M1: FileStore 就绪 | AC-A1 done | safe |
| M2: 数据层迁移完成 | AC-B1~B8 done | safe |
| M3: 配置层迁移完成 | AC-C1~C4 done | safe |
| M4: 知识层迁移完成 | AC-D1 done | safe |
| M5: 迁移脚本就绪 | AC-E1 done | safe |
| M6: Schema 清理 + 验证 | AC-E2 done | destructive |

---

## Implementation Readiness

implementationReady: false

| # | 条件 | 满足 | 证据 |
|---|------|------|------|
| 1 | design.md 有精确 file:line 引用 | ❌ | 未标注行号——AC-B2 有 17 处具体行号，其他 AC 只有文件路径 |
| 2 | 非平凡变更有 before/after 代码块 | ❌ | design.md 只有 AuditService 接口变更示例，OKR 格式示例；其他 10+ 个 service 无 before/after |
| 3 | 消费方覆盖（谁 import 受影响文件） | ⚠️ | design.md 有调用链（代码依赖图），但 import 关系未穷举 |
| 4 | 测试断言具体（不只是"测试通过"） | ⚠️ | task.md 有测试用例列表但断言值未具体化（如 "过滤正确" 未写期望行数） |
| 5 | 接口定义完整（签名+参数+返回值） | ⚠️ | FileStore 公开方法签名完整，AuditService 变更签名完整；OKR/Notification/Resolution 签名未列出 |

**缺口**: 条件 1-5 未全满足。tdd-implement 使用默认模型设置。
**建议**: Phase 1 (FileStore) 满足条件 1/5，可先行实现；其他 Phase 在 tdd-implement 中逐个细化。
