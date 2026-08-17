---
slug: filestore-unification
title: FileStore 统一 — 设计
status: done
version: "1.0"
createdAt: 2026-07-17
---

## 设计概述

FileStore 当前只做 JSON/JSONL 读写和 WorkUnit event sourcing。本次扩展加入 3 个新能力组（markdown、索引、版本管理），不改变现有 API。sdd-utils.ts 下沉 I/O 层到 FileStore，自身变为 async 包装层。harness 通过新增依赖接入 FileStore。

---

## 1. FileStore 新增接口

### 1.1 Markdown 能力

```typescript
// 纯函数 — 不依赖 FileStore 实例
export function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } | null;
export function serializeFrontmatter(meta: Record<string, unknown>, body: string): string;

// 实例方法
class FileStore {
  async readDoc(dir: string, key: string): Promise<{ meta: Record<string, unknown>; body: string } | null>;
  async writeDoc(dir: string, key: string, meta: Record<string, unknown>, body: string): Promise<void>;
}
```

**readDoc 实现逻辑**（参考 sdd-utils `readSddDoc` L188-L193）：
1. 构造路径 `path.join(dir, `${key}.md`)`
2. `fs.promises.readFile` 读取内容
3. ENOENT → return null
4. 调用 `parseFrontmatter(content)` 解析

**writeDoc 实现逻辑**（参考 sdd-utils `writeSddDoc` L198-L205）：
1. 构造路径 `path.join(dir, `${key}.md`)`
2. `ensureDir(dir)`
3. `serializeFrontmatter(meta, body)` 序列化
4. `fs.promises.writeFile` 写入

**parseFrontmatter 实现**（从 sdd-utils `parseSddFrontmatter` L102-L133 迁移）：
- 正则 `/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/`
- 不匹配返回 null
- 逐行 `key: value` 解析，数组/数字/字符串自动类型推断
- 返回 `{ meta: Record<string, unknown>, body }`
- 与 `parseSddFrontmatter` 区别：meta 类型为 `Record<string, unknown>` 而非 `Partial<SddFrontmatter>`（通用化）

**serializeFrontmatter 实现**（从 sdd-utils `stringifySddFrontmatter` L138-L171 迁移）：
- 遍历 `Object.entries(meta)`
- 字符串值加双引号，数字裸写，数组 `["a", "b"]` 格式
- 外层 `---\n...\n---`

---

### 1.2 索引能力

```typescript
class FileStore {
  async buildIndex(dir: string, fields: string[]): Promise<void>;
  async queryIndex(dir: string, field: string, value: string): Promise<string[]>;
  async listDocs(dir: string): Promise<string[]>;
  async findByField(dir: string, field: string, value: string): Promise<string | null>;
}
```

**buildIndex 实现逻辑**（参考 harness `KnowledgeIndexGenerator.generateIndexLines` L75-L96）：
1. `fs.promises.readdir(dir)` 扫描所有 `.md` 文件（排除 `_index.md` 自身）
2. 对每个文件调 `readDoc` 提取 frontmatter meta
3. 按 fields 顺序组装行：`filename|meta[field1]|meta[field2]|...`
4. 写入 `{dir}/_index.md`

**queryIndex 实现**：
1. `fs.promises.readFile({dir}/_index.md, 'utf-8')`
2. grep 匹配 `|{value}` 的行
3. 提取每行第一列（filename），返回去重数组

**listDocs 实现**：
1. 尝试调 `readFile(_index.md)`，解析第一列 filename
2. 文件不存在 → `fs.promises.readdir` 扫描目录，过滤 `.md` 后缀
3. 返回文件名列表（不含路径、不含 `.md` 后缀）

**findByField 实现**：
1. 调 `queryIndex(dir, field, value)`
2. 返回第一个结果或 null

**_index.md 格式**（兼容 harness 现有格式）：
```
# Directory Index
# Auto-generated — run `harness knowledge index` to rebuild
# Total: <N> entries
#
# filename|id|type|title|maturity|tags|terms
architecture-something.md|some-id|architecture|Some Title|stable|tag1;tag2|Heading1;Heading2
```

代码表头行以 `# ` 开头（注释），pipe 分隔的数据行不包含 `# ` 前缀。

---

### 1.3 版本管理能力

```typescript
class FileStore {
  async bumpVersion(dir: string, key: string, changeType: string, changeDesc: string): Promise<void>;
  async appendChangelog(dir: string, key: string, entry: string): Promise<void>;
}
```

**bumpVersion 实现逻辑**：
1. 调 `readDoc(dir, key)` 读取当前文档
2. 不存在 → throw `Error`
3. `const currentVersion = typeof meta.version === 'number' ? meta.version : 0`
4. `meta.version = currentVersion + 1`
5. `meta.changeType = changeType; meta.changeDesc = changeDesc`
6. `meta.updatedAt = new Date().toISOString()`
7. `writeDoc(dir, key, meta, body)` 回写

**appendChangelog 实现**（从 sdd-utils `appendChangelog` L391-L405 迁移）：
1. 构造路径 `{dir}/{key}/CHANGELOG.md`
2. 确保目录存在
3. `const entry = \`\n## ${new Date().toISOString()}\n\n${changeEntry}\n\``
4. 文件存在 → append；不存在 → 创建 `# CHANGELOG\n{entry}`

---

## 2. sdd-utils 改造

### 2.1 函数签名变化

| 旧签名 | 新签名 |
|--------|--------|
| `readSddDoc(slug, layer): {meta, body} \| null` | `readSddDoc(slug, layer): Promise<{meta, body} \| null>` |
| `writeSddDoc(slug, layer, fm, body): void` | `writeSddDoc(slug, layer, fm, body): Promise<void>` |
| `listSddDocs(): string[]` | `listSddDocs(): Promise<string[]>` |
| `findSddDocById(id): string \| null` | `findSddDocById(id): Promise<string \| null>` |
| `findSddDocByWorkUnitId(wuId): string \| null` | `findSddDocByWorkUnitId(wuId): Promise<string \| null>` |
| `readSddDocByWorkUnitId(wuId, layer): {meta, body} \| null` | `readSddDocByWorkUnitId(wuId, layer): Promise<{meta, body} \| null>` |
| `findSddDocs(filter): Partial<SddFrontmatter>[]` | `findSddDocs(filter): Promise<Partial<SddFrontmatter>[]>` |
| `updateSddFrontmatter(slug, patch): void` | `updateSddFrontmatter(slug, patch): Promise<void>` |
| `appendChangelog(slug, entry): void` | `appendChangelog(slug, entry): Promise<void>` |

**不变项：**
- `toKebab(text: string): string` — 纯字符串转换，无 I/O
- `parseTaskDocContractTests(body: string): Array<{file, content}>` — 纯字符串解析
- `parseTaskDocTestFiles(body: string): string[]` — 纯字符串解析
- `SddFrontmatter` 类型定义 — 保留

### 2.2 内部实现变更

```typescript
// Before
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';

// After
import { FileStore } from '../file-store';
const store = new FileStore();

export async function readSddDoc(slug, layer) {
  return store.readDoc(getSddBaseDir(), `${slug}/${layer}`);
}
```

`sdd-utils.ts` 不再直接 import `fs`。`parseSddFrontmatter` / `stringifySddFrontmatter` 改为 re-export FileStore 的同名纯函数 + SddFrontmatter 类型包装。

---

## 3. harness 接入

### 3.1 依赖变更

`harness/package.json` 新增：
```json
"dependencies": {
  "@dommaker/studio-shared": "^0.1.0"
}
```

### 3.2 KnowledgeIndexGenerator 改造

```typescript
// Before
import * as fs from 'fs';
import * as yaml from 'js-yaml';

// After
import { FileStore } from '@dommaker/studio-shared';

export class KnowledgeIndexGenerator {
  private store: FileStore;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.store = new FileStore(baseDir);
  }

  async regenerate(): Promise<string> {
    const lines = await this.generateIndexLines();
    const output = this.generate();
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    await fs.promises.writeFile(path.join(this.baseDir, INDEX_FILENAME), output, 'utf-8');
    return output;
  }

  async generateIndexLines(): Promise<string[]> {
    // 改为调用 FileStore.buildIndex
    const files = await this.scanFiles(this.baseDir);
    const entries: IndexEntry[] = [];
    for (const filePath of files) {
      const filename = path.relative(this.baseDir, filePath);
      const doc = await this.store.readDoc(path.dirname(filePath), path.basename(filePath, '.md'));
      if (doc) {
        entries.push({
          filename,
          id: String(doc.meta.id ?? doc.meta.name ?? path.basename(filePath, '.md')),
          type: String(doc.meta.type ?? 'unknown'),
          title: String(doc.meta.title ?? ''),
          maturity: String(doc.meta.maturity ?? 'unknown'),
          tags: Array.isArray(doc.meta.tags) ? doc.meta.tags : [],
          headings: this.extractHeadings(doc.body),
        });
      }
    }
    // sort, format...
  }
}
```

`KnowledgeIndexGenerator` 不再使用 `js-yaml`（frontmatter 解析交给 FileStore）。`scanFiles`、`extractHeadings`、`formatLine`、`inferType` 保持内部方法。

---

## 4. 代码依赖图

```
FileStore (packages/studio-shared/src/file-store.ts)
  ├── fs (node:fs/promises)
  ├── path (node:path)
  └── os (node:os)

sdd-utils.ts → FileStore
  ├── parseSddFrontmatter → FileStore.parseFrontmatter
  ├── stringifySddFrontmatter → FileStore.serializeFrontmatter
  ├── readSddDoc → FileStore.readDoc
  ├── writeSddDoc → FileStore.writeDoc
  ├── listSddDocs → FileStore.listDocs
  ├── findSddDocById → FileStore.findByField
  ├── findSddDocByWorkUnitId → FileStore.findByField
  ├── findSddDocs → FileStore.readDoc (per file)
  ├── updateSddFrontmatter → FileStore.readDoc + writeDoc
  └── appendChangelog → FileStore.appendChangelog

harness KnowledgeIndexGenerator → FileStore
  ├── parseFile → FileStore.readDoc (frontmatter 解析)
  └── regenerate → FileStore.buildIndex (索引生成)

harness knowledge.ts → KnowledgeIndexGenerator (不变)
```

### 依赖拓扑（任务并行度）

```
AC-S1 (markdown) ──┐
                    ├──> AC-S4 (sdd-utils)
AC-S2 (index) ─────┤
                    │
AC-S3 (version) ───┘     AC-S2 ──> AC-S5 (harness)

S1, S2, S3: 可并行（三个独立能力组，无交叉依赖）
S4: 依赖 S1, S2, S3（需要 readDoc/writeDoc/listDocs/findByField/appendChangelog）
S5: 依赖 S2（需要 buildIndex/queryIndex/parseFrontmatter）
```

---

## 5. 模块边界与约束

| 约束 | 说明 |
|------|------|
| 不修改现有 API | FileStore 现有 JSON/JSONL/flock/workunit 方法签名不变 |
| 异步一致 | 新增方法全部 async（`fs.promises`），与现有 FileStore 模式一致 |
| 通用化 | `parseFrontmatter` 返回 `Record<string, unknown>` 而非 `Partial<SddFrontmatter>`（FileStore 不依赖 SDD 类型） |
| sdd-utils 保留类型 | `SddFrontmatter` 类型和 SDD schema 验证保留在 sdd-utils，不沉入 FileStore |
| _index.md 格式 | 保持 `filename|field1|...|fieldN` pipe 格式，兼容 harness 现有格式 |
| 消费者适配 | sdd-utils 调用方（6 个 scripts + barrel export）需改为 await |
