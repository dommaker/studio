---
slug: filestore-unification
title: FileStore 统一 — 任务
status: done
version: "1.0"
createdAt: 2026-07-17
---

## 实现步骤

---

### Phase 1: FileStore Markdown 能力 `[safe]`

**文件:** `packages/studio-shared/src/file-store.ts`（扩展）

**改动类型：** 新增方法 + 纯函数

**实现要点：**
1. 导出 `parseFrontmatter(content)`, `serializeFrontmatter(meta, body)` 纯函数
2. 新增 `readDoc(dir, key)`, `writeDoc(dir, key, meta, body)` 实例方法
3. 从 sdd-utils.ts 迁移解析/序列化逻辑，通用化 meta 类型

**契约测试:**
- `describe('FileStore Markdown')` in `file-store.test.ts`

| # | 测试用例 | AC 覆盖 |
|---|---------|---------|
| 1 | `readDoc` 读取有效 markdown，返回 `{meta, body}` | AC-S1 正常路径 |
| 2 | `readDoc` 文件不存在返回 null | AC-S1 边界 |
| 3 | `readDoc` 无 frontmatter 返回 `{meta:{}, body}` | AC-S1 边界 |
| 4 | `readDoc` frontmatter 特殊字符正确解析 | AC-S1 边界 |
| 5 | `readDoc` frontmatter 多行数组值 | AC-S1 边界 |
| 6 | `writeDoc` 写入后 readDoc 读出一致 | AC-S1 正常路径 |
| 7 | `writeDoc` 目录不存在自动创建 | AC-S1 边界 |
| 8 | `parseFrontmatter` 正常 markdown | AC-S1 纯函数 |
| 9 | `parseFrontmatter` 无 `---` fence 返回 null | AC-S1 边界 |
| 10 | `serializeFrontmatter` 往返：`parse(serialize(meta, body))` 一致 | AC-S1 纯函数 |

---

### Phase 2: FileStore 索引能力 `[safe]`

**文件:** `packages/studio-shared/src/file-store.ts`

**改动类型：** 新增方法

**实现要点：**
1. 新增 `buildIndex(dir, fields)`, `queryIndex(dir, field, value)`, `listDocs(dir)`, `findByField(dir, field, value)`
2. `_index.md` 格式兼容 harness KnowledgeIndexGenerator
3. 先写临时文件再 rename 保证原子性

**契约测试:**
- `describe('FileStore Index')` in `file-store.test.ts`

| # | 测试用例 | AC 覆盖 |
|---|---------|---------|
| 1 | `buildIndex` 扫描目录生成 `_index.md`，格式 `filename\|f1\|f2` | AC-S2 正常路径 |
| 2 | `buildIndex` 空目录生成 header-only 索引 | AC-S2 边界 |
| 3 | `buildIndex` 字段缺失输出空字符串 | AC-S2 边界 |
| 4 | `queryIndex` 按 field=value 匹配，返回文件名列表 | AC-S2 正常路径 |
| 5 | `queryIndex` 无匹配返回 `[]` | AC-S2 边界 |
| 6 | `listDocs` 从 `_index.md` 读取，返回文件名列表 | AC-S2 正常路径 |
| 7 | `listDocs` `_index.md` 不存在时降级扫描目录 | AC-S2 边界 |
| 8 | `listDocs` 空目录返回 `[]` | AC-S2 边界 |
| 9 | `findByField` 找到返回文件名 | AC-S2 正常路径 |
| 10 | `findByField` 未找到返回 null | AC-S2 边界 |

---

### Phase 3: FileStore 版本管理能力 `[safe]`

**文件:** `packages/studio-shared/src/file-store.ts`

**改动类型：** 新增方法

**实现要点：**
1. 新增 `bumpVersion(dir, key, changeType, changeDesc)`, `appendChangelog(dir, key, entry)`
2. 从 sdd-utils `appendChangelog` 迁移 CHANGELOG 追加逻辑

**契约测试:**
- `describe('FileStore Version')` in `file-store.test.ts`

| # | 测试用例 | AC 覆盖 |
|---|---------|---------|
| 1 | `bumpVersion` version +1，changeType/changeDesc 写入，updatedAt 更新 | AC-S3 正常路径 |
| 2 | `bumpVersion` version 非数字初始化为 1 | AC-S3 边界 |
| 3 | `bumpVersion` 文档不存在 throw Error | AC-S3 边界 |
| 4 | `appendChangelog` 追加条目，格式 `\n## {ISO}\n\n{entry}\n` | AC-S3 正常路径 |
| 5 | `appendChangelog` 文件不存在自动创建 # CHANGELOG header | AC-S3 边界 |
| 6 | `appendChangelog` 多次追加不覆盖旧条目 | AC-S3 正常路径 |

---

### Phase 4: sdd-utils 精简 `[safe]`

**文件:** `packages/studio-shared/src/utils/sdd-utils.ts`

**改动类型：** 重构（函数体替换，签名加 async）

**实现要点：**
1. 所有 I/O 函数 body 改为调用 FileStore 实例方法
2. 函数签名加 `async`，返回值类型包 `Promise`
3. `parseSddFrontmatter` 内部调用 `FileStore.parseFrontmatter` + 类型断言
4. `stringifySddFrontmatter` 内部调用 `FileStore.serializeFrontmatter`
5. 不再直接 import `fs`（readFileSync/writeFileSync/existsSync/mkdirSync/readdirSync）
6. 保留 `SddFrontmatter` 类型、`toKebab`、`parseTaskDocContractTests`、`parseTaskDocTestFiles`

**契约测试:**
- `describe('sdd-utils with FileStore')` in `sdd-utils.test.ts`（修改现有测试为 async）

| # | 测试用例 | AC 覆盖 |
|---|---------|---------|
| 1 | `readSddDoc` 正常读取 | AC-S4 行为不变 |
| 2 | `writeSddDoc` + `readSddDoc` 往返一致 | AC-S4 行为不变 |
| 3 | `listSddDocs` 列出所有 slug | AC-S4 行为不变 |
| 4 | `findSddDocById` 找到返回 slug | AC-S4 行为不变 |
| 5 | `findSddDocById` 未找到返回 null | AC-S4 行为不变 |
| 6 | `appendChangelog` 追加条目 | AC-S4 行为不变 |
| 7 | `updateSddFrontmatter` 合并 patch | AC-S4 行为不变 |
| 8 | `toKebab` 中文转换（行为不变） | AC-S4 保留函数 |
| 9 | `parseTaskDocContractTests` 解析（行为不变） | AC-S4 保留函数 |
| 10 | `SddFrontmatter` 类型导出不变 | AC-S4 保留类型 |

**消费方适配：** 6 个 `scripts/*.ts` 中的调用加 `await`（不改逻辑）

---

### Phase 5: 知识库索引统一 `[safe]`

**文件:**
- `harness/src/knowledge/index-generator.ts`（重构）
- `harness/src/cli/commands/knowledge.ts`（调用适配）
- `harness/package.json`（新增依赖）

**改动类型：** 重构 + 依赖新增

**实现要点：**
1. `harness/package.json` 新增 `"@dommaker/studio-shared": "^0.1.0"`
2. `KnowledgeIndexGenerator`:
   - 构造函数新增 `this.store = new FileStore(baseDir)`
   - `generateIndexLines()` 改为调 `this.store.buildIndex(...)` 或逐文件 `this.store.readDoc(...)`
   - `parseFile()` 改为调 `FileStore.parseFrontmatter()` 替代 `js-yaml`
   - 删除 `import * as yaml from 'js-yaml'`
3. `knowledgeIndex()` 函数不变（仍调 `gen.regenerate()`）

**契约测试:**
- 修改 `harness/src/cli/commands/__tests__/knowledge.test.ts`

| # | 测试用例 | AC 覆盖 |
|---|---------|---------|
| 1 | `knowledgeIndex` JSON 输出格式不变 | AC-S5 行为不变 |
| 2 | `knowledgeIndex` entries 计数正确 | AC-S5 行为不变 |
| 3 | `_index.md` 生成内容格式与原一致 | AC-S5 格式兼容 |
| 4 | 知识库目录为空 → 生成 header-only 索引 | AC-S5 边界 |

---

## 执行顺序

```
Phase 1 ──┐
           ├──> Phase 4 ──> 完成
Phase 2 ──┤              (sdd-utils depends on S1+S2+S3)
           │
Phase 3 ──┘

Phase 2 ──> Phase 5 ──> 完成
           (harness depends on S2)
```

- **并行组 1**: Phase 1, Phase 2, Phase 3（三个独立能力，无交叉依赖）
- **串行组 2**: Phase 4（依赖 1 + 2 + 3 完成）、Phase 5（依赖 2 完成）
- **并行组 2**: Phase 4, Phase 5（互不依赖）

---

## 风险标注

| Phase | 风险等级 | 说明 |
|-------|---------|------|
| Phase 1 | `[safe]` | 纯增量，新增方法不改现有 API |
| Phase 2 | `[safe]` | 纯增量，新增方法 |
| Phase 3 | `[safe]` | 纯增量，新增方法 |
| Phase 4 | `[safe]` | 重构：函数签名加 async，body 替换为 FileStore 调用。sdd-utils 测试覆盖充分，行为不变验证容易 |
| Phase 5 | `[safe]` | harness 新增依赖，不改 Studio 核心逻辑。`_index.md` 格式保持兼容 |

无 `[breaking]` 或 `[destructive]` 操作。

---

## 里程碑

| 节点 | 完成标准 | 依赖 |
|------|---------|------|
| M1 | Phase 1+2+3 测试通过（FileStore 新增 26 tests） | — |
| M2 | Phase 4 测试通过，sdd-utils 全量 test 通过（46 tests 适配为 async） | M1 |
| M3 | Phase 5 测试通过，harness knowledge CLI 正常 | M1 |
| M4 | `npx tsc --noEmit` 零类型错误，`pnpm test` 全量通过 | M2 + M3 |

---

## 测试文件规划

| 测试文件 | Phase | 新增/修改 |
|---------|-------|----------|
| `packages/studio-shared/src/__tests__/file-store.test.ts` | P1-P3 | 新增 3 个 describe 块（Markdown/Index/Version），约 26 tests |
| `packages/studio-shared/src/utils/__tests__/sdd-utils.test.ts` | P4 | 修改现有 46 tests 为 async（调用加 await） |
| `harness/src/cli/commands/__tests__/knowledge.test.ts` | P5 | 修改 mock，验证格式兼容 |

---

## Implementation Readiness

implementationReady: true

| # | 条件 | 满足 | 证据 |
|---|------|------|------|
| 1 | design.md 有精确 file:line 引用 | ✅ | 每个接口标注参考 sdd-utils.ts L行号（readDoc→L188-L193, parse→L102-L133 等） |
| 2 | 非平凡变更有 before/after 代码块 | ✅ | design.md §2.2 有 before/after 对比；§3.2 有 KnowledgeIndexGenerator 改造对比 |
| 3 | 消费方覆盖（谁 import 受影响文件） | ✅ | AC-S4 列出 6 个 scripts 文件；AC-S5 列出 harness 3 文件；barrel export 追踪到 utils/index.ts |
| 4 | 测试断言具体（不只是"测试通过"） | ✅ | task.md 每个 Phase 有测试表格，26+46+4 tests 每项有具体 AC 覆盖标注 |
| 5 | 接口定义完整（签名+参数+返回值） | ✅ | design.md §1.1-1.3 每个新方法有完整 TypeScript 签名 + 实现逻辑说明 |
