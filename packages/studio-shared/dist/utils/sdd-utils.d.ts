/**
 * SDD 工具函数 — frontmatter 解析 + slug 生成
 *
 * SP-004: SDD 知识架构 Step 1
 * Phase 4 (spec-2a): 底层 I/O 下沉到 FileStore，函数改为 async。
 *
 * SDD 文档结构：docs/sdd/<slug>/{requirement,design,task}.md
 * 每个文件头部有 YAML frontmatter，包含文档元数据。
 */
export interface SddFrontmatter {
    id: string;
    workUnitId?: string;
    slug: string;
    title: string;
    status: 'draft' | 'confirmed' | 'done' | 'stale';
    tier: 'fast' | 'standard' | 'premium';
    version: number;
    requirementVersion: number;
    designVersion: number;
    taskVersion: number;
    parentId?: string;
    changeType?: 'L1' | 'L2' | 'L3' | 'L4';
    changeDesc?: string;
    sourceChannelId?: string;
    tags: string[];
    linkedDocIds?: string[];
    createdAt: string;
    updatedAt: string;
}
/**
 * 将标题转为 kebab-case slug。
 * 支持中文（常见字拼音映射）、英文、数字。
 *
 * @example
 * toKebab("添加 JWT 验证") // "add-jwt-auth"
 * toKebab("SDD 知识架构") // "sdd-knowledge-architecture"
 */
export declare function toKebab(text: string): string;
/**
 * 解析 SDD markdown 文件的 YAML frontmatter。
 * 底层调用 FileStore.parseFrontmatter，上层做 SddFrontmatter 类型断言。
 */
export declare function parseSddFrontmatter(content: string): {
    meta: Partial<SddFrontmatter>;
    body: string;
} | null;
/**
 * 将 SddFrontmatter 序列化为 YAML 字符串。
 */
export declare function stringifySddFrontmatter(fm: Partial<SddFrontmatter>): string;
/**
 * 读取 SDD 文档（requirement/design/task）。
 */
export declare function readSddDoc(slug: string, layer: 'requirement' | 'design' | 'task'): Promise<{
    meta: Partial<SddFrontmatter>;
    body: string;
} | null>;
/**
 * 写入 SDD 文档。
 */
export declare function writeSddDoc(slug: string, layer: 'requirement' | 'design' | 'task', frontmatter: Partial<SddFrontmatter>, body: string): Promise<void>;
/**
 * 列出所有 SDD 文档目录（扫描子目录，非 flat .md 文件）。
 */
export declare function listSddDocs(): Promise<string[]>;
export declare function findSddDocById(id: string): Promise<string | null>;
export declare function findSddDocByWorkUnitId(workUnitId: string): Promise<string | null>;
export declare function readSddDocByWorkUnitId(workUnitId: string, layer: 'requirement' | 'design' | 'task'): Promise<{
    meta: Partial<SddFrontmatter>;
    body: string;
} | null>;
export declare function parseTaskDocContractTests(body: string): Array<{
    file: string;
    content: string;
}>;
export declare function parseTaskDocTestFiles(body: string): string[];
export declare function appendChangelog(slug: string, entry: string): Promise<void>;
export declare function findSddDocs(filter?: {
    status?: string;
    workUnitId?: string;
}): Promise<Array<Partial<SddFrontmatter>>>;
export declare function updateSddFrontmatter(slug: string, patch: Partial<SddFrontmatter>): Promise<void>;
//# sourceMappingURL=sdd-utils.d.ts.map