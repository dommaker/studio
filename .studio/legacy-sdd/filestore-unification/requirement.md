---
slug: filestore-unification
title: FileStore 统一 — Markdown/索引/版本管理
status: done
version: "1.0"
createdAt: 2026-07-17
spec: docs/specs/db-removal/spec-2a-filestore-unification.md
---

## 需求概述

扩展 FileStore 为统一存储抽象，新增 markdown 读写、索引管理、版本管理三个能力。精简 sdd-utils.ts，底层 I/O 下沉到 FileStore。harness 知识库索引接入 FileStore.buildIndex/queryIndex。

---

## 验收标准

### AC-S1: FileStore Markdown 能力 `[covers: AC-1]`

**触发条件：** 任何模块需要读写 markdown 文件时

**预期行为：**
- `FileStore.readDoc(dir, key)` 读取 `{dir}/{key}.md`，解析 YAML frontmatter，返回 `{ meta: Record<string, unknown>, body: string }`
- `FileStore.writeDoc(dir, key, meta, body)` 序列化 frontmatter + body 写入 `{dir}/{key}.md`
- `FileStore.parseFrontmatter(content)` 纯函数：`string -> { meta, body }`
- `FileStore.serializeFrontmatter(meta, body)` 纯函数：`(Record<string, unknown>, string) -> string`
- 所有方法为 async（`fs.promises`），与现有 FileStore 一致

**边界情况：**
- 文件不存在 → `readDoc` 返回 `null`
- 空 frontmatter（`---\n---\nbody`）→ meta 为 `{}`
- frontmatter 中特殊字符（`:`, `"`, `[`, `]`, `#`）→ 正确解析
- 多行 frontmatter 值（如 `tags: [a, b]`）→ 正确解析
- 目录不存在 → `writeDoc` 自动创建
- 非 markdown 文件（无 `---` fence）→ `parseFrontmatter` 返回 `null`

**涉及文件:**
- `packages/studio-shared/src/file-store.ts`（扩展）
- `packages/studio-shared/src/__tests__/file-store.test.ts`

---

### AC-S2: FileStore 索引能力 `[covers: AC-2]`

**触发条件：** 任何模块需要跨文档查询/索引时

**预期行为：**
- `FileStore.buildIndex(dir, fields)` 扫描 `dir/` 下所有 `.md` 文件，提取 frontmatter 字段，生成 `_index.md`。格式：`filename|field1|field2|...`
- `FileStore.queryIndex(dir, field, value)` grep `_index.md`，返回匹配行对应的文件名列表
- `FileStore.listDocs(dir)` 优先读 `_index.md` 提取文件名列表，不存在时 `fs.readdir` 扫描
- `FileStore.findByField(dir, field, value)` 从索引查找匹配文件名，不扫描全目录

**边界情况：**
- `_index.md` 不存在 → `listDocs`/`findByField` 降级为目录扫描
- `_index.md` 存在但过期（有文件未被索引）→ 调用方先调 `buildIndex` 重建
- 空目录 → `buildIndex` 生成空索引（只有 header）；`listDocs` 返回 `[]`
- frontmatter 缺少索引字段 → 该字段输出空字符串
- 索引重建期间并发读取 → 先写后 rename 保证原子性

**涉及文件:**
- `packages/studio-shared/src/file-store.ts`
- `packages/studio-shared/src/__tests__/file-store.test.ts`

---

### AC-S3: FileStore 版本管理能力 `[covers: AC-3]`

**触发条件：** SDD/Spec 文档需要版本递增时

**预期行为：**
- `FileStore.bumpVersion(dir, key, changeType, changeDesc)` 读取 frontmatter，`version + 1`，回写 `changeType` 和 `changeDesc`
- `FileStore.appendChangelog(dir, key, entry)` 追加 CHANGELOG.md 条目（`## {ISO timestamp}\n\n{entry}\n`）
- 从 sdd-utils.ts 迁移逻辑，保持行为一致

**边界情况：**
- `version` 字段非数字 → 初始化为 `1`
- 文档不存在 → `bumpVersion` throw `Error`
- CHANGELOG.md 不存在 → 自动创建，写入 `# CHANGELOG` header
- 并发 bumpVersion → 上层 flock 保护，FileStore 本身不做锁

**涉及文件:**
- `packages/studio-shared/src/file-store.ts`
- `packages/studio-shared/src/__tests__/file-store.test.ts`

---

### AC-S4: sdd-utils.ts 精简 `[covers: AC-4]`

**触发条件：** AC-S1/S2/S3 完成后

**预期行为：**
- `readSddDoc()` 改为调用 `FileStore.readDoc(getSddBaseDir(), slug+layer)`
- `writeSddDoc()` 改为调用 `FileStore.writeDoc(getSddBaseDir(), slug+layer, meta, body)`
- `listSddDocs()` 改为调用 `FileStore.listDocs(getSddBaseDir())`
- `findSddDocById()` 改为调用 `FileStore.findByField(getSddBaseDir(), 'id', value)`
- `appendChangelog()` 改为调用 `FileStore.appendChangelog(getSddBaseDir(), slug, entry)`
- sdd-utils 函数签名改为 async（返回 `Promise`），参数不变
- 保留 `SddFrontmatter` 类型、`toKebab`、`parseTaskDocContractTests`、`parseTaskDocTestFiles`
- `parseSddFrontmatter`/`stringifySddFrontmatter` 改为调用 `FileStore.parseFrontmatter`/`serializeFrontmatter`
- 现有 sdd-utils 测试全部通过（调用处改为 `await`）

**消费方适配（5 文件）：**
- `scripts/migrate-sdd-from-db.ts`
- `scripts/split-sdd-layers.ts`
- `scripts/patch-sdd-changelog.ts`
- `scripts/patch-sdd-files-section.ts`
- `scripts/extract-historical-sdd.ts`

> `sdd-freshness-check.ts` 动态 import `sdd-freshness.service`，不直接调 sdd-utils，无需适配。
> `packages/studio-shared/src/utils/index.ts` 是 barrel re-export，无需适配。

**涉及文件:**
- `packages/studio-shared/src/utils/sdd-utils.ts`
- `packages/studio-shared/src/utils/__tests__/sdd-utils.test.ts`
- `scripts/*.ts`（6 个脚本）

---

### AC-S5: 知识库索引统一 `[covers: AC-5]`

**触发条件：** AC-S2 完成后

**预期行为：**
- `harness/src/knowledge/index-generator.ts` 的 `generateIndexLines()` 改为调用 `FileStore.buildIndex()`
- `KnowledgeIndexGenerator.parseFile` 的 frontmatter 解析改为调用 `FileStore.parseFrontmatter()`
- `harness knowledge index` 命令输出不变（`_index.md` header + pipe 行格式）
- 跨仓库接入：harness `package.json` 添加 `@dommaker/studio-shared` 依赖

**边界情况：**
- `_index.md` 不存在 → `buildIndex` 正常生成
- 索引重建期间 `harness knowledge index` 调用 → `buildIndex` 覆盖写入
- 格式兼容性：保持 `filename|id|type|title|maturity|tags|terms` 格式
- 知识库目录为空 → 生成 header-only 索引

**涉及文件:**
- `packages/studio-shared/src/file-store.ts`（buildIndex/queryIndex）
- `harness/src/knowledge/index-generator.ts`（改为调用 FileStore）
- `harness/src/cli/commands/knowledge.ts`（改为调用 FileStore）
- `harness/src/cli/commands/__tests__/knowledge.test.ts`
- `harness/package.json`（新增 studio-shared 依赖）
