/**
 * role-memory (#98) — 角色记忆存储服务
 *
 * #88 spec §A「角色记忆服务」的存储层。per-role 目录三件套：
 *   memory/<roleId>/MEMORY.md     索引（每 topic 一行：路径 + 一句话摘要，供 #100 注入）
 *   memory/<roleId>/topics/<slug>.md  topic 正文（frontmatter: title/summary/kind/updatedAt）
 *   memory/<roleId>/draft.jsonl    append-only JSONL 草稿区（供 #99 提取写 / #101 人审读）
 *
 * 内容纪律（spec §A）：记忆只收两类 —— execution-knowledge（有效做法/踩坑/失败教训）
 * 与 preference（偏好/约定）。决策不进角色记忆（留项目级决策日志，索引存指针）；
 * persona/职责属静态 preset 不算记忆。appendDraft 按 kind 白名单拒绝其它形态。
 *
 * 并发安全：草稿 append-only（FileStore.appendJsonl 的 O_APPEND 追加，多 WU 并行写不冲突）；
 * promote 合并走单一代码路径（唯一写 topic + 索引的方法）且 per-role 进程内互斥
 * （Map<roleId, Promise> 链式锁，单进程模型，不引入 Redis）。
 *
 * 容量上限 + GC：超限只提醒（checkCapacity 返回结构化 signal），不落新人罪（不拒绝写入）、
 * 不自动删。GC 最简 = 超限提醒人合并 topic / 淘汰草稿。
 * 与 KnowledgeSync「零值 trend 止血 + GC」的合并：#88 中该子项属 #83（知识飞轮 GC，
 * spec Out of Scope），本仓库无明确实现锚点（grep「零值」无命中），故本票只留
 * checkCapacity 作为未来 GC 可消费的 hook，不深入改 KnowledgeSync。见 apps/api/src/modules/role-memory/CONTEXT.md。
 *
 * 路径：落盘经 studioPath()（读 STUDIO_HOME，dev/prod 隔离，禁硬编码 ~/.studio）。
 * 测试隔离与 studio-log-path 同约定：VITEST/NODE_ENV=test 时改写 os.tmpdir()/
 * studio-test-role-memory/<per-进程子目录>（全局设 STUDIO_HOME 会破坏既有测试，故不改写
 * env 用 tmpdir；per-进程子目录防 vitest 并行测试文件整删互踩，#135）。
 */
import fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore, parseFrontmatter, serializeFrontmatter } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { isTestEnv, testTmpRoot } from '../../utils/studio-log-path.js';

const store = new FileStore();

/** studioDir() 下的记忆根目录名（单层目录名） */
export const ROLE_MEMORY_DIR = 'memory';

/** 记忆形态白名单：只收执行知识 + 偏好/约定（spec §A） */
export type MemoryKind = 'execution-knowledge' | 'preference';

const MEMORY_KINDS: ReadonlySet<string> = new Set<MemoryKind>(['execution-knowledge', 'preference']);

/**
 * 人审档位（#101 两档人审闸口）：
 * - auto：操作型事实（高置信、零争议，如测试命令/路径/流程）→ 直接 promote 进索引，不产卡；
 * - manual：规律/教训/偏好（需人把关）→ 发 knowledge 卡片人审（approve→promote / reject→demote）。
 */
export type MemoryReview = 'auto' | 'manual';

// ─── 路径 ───

/**
 * 记忆根目录：测试 → os.tmpdir()/studio-test-role-memory/<per-进程子目录>（testTmpRoot，#135）；
 * 生产 → studioPath('memory')（经 studioDir() 读 STUDIO_HOME，dev/prod 隔离，禁硬编码 ~/.studio）。
 */
export function roleMemoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return isTestEnv(env)
    ? testTmpRoot('studio-test-role-memory')
    : studioPath(ROLE_MEMORY_DIR);
}

/** 角色 id 目录名 sanitize：拒路径穿越（.. / 分隔符 / 空），防 ../../ 越权 */
export function sanitizeRoleId(roleId: string): string {
  if (!roleId || roleId === '.' || roleId === '..' || /[\/\\]/.test(roleId)) {
    throw new Error(`Invalid roleId: ${JSON.stringify(roleId)}`);
  }
  return roleId;
}

/** topic slug sanitize：拒路径穿越（同 roleId 口径），slug 直接做文件名 */
export function sanitizeTopicSlug(slug: string): string {
  if (!slug || slug === '.' || slug === '..' || /[\/\\]/.test(slug)) {
    throw new Error(`Invalid topic slug: ${JSON.stringify(slug)}`);
  }
  return slug;
}

/** per-role 记忆目录：<root>/<roleId> */
export function roleMemoryDir(roleId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(roleMemoryRoot(env), sanitizeRoleId(roleId));
}

// ─── 类型 ───

/** 草稿条目（draft.jsonl 一行；pending 形态，无 promoted/rejected 标记） */
export interface MemoryDraftEntry {
  id: string;
  roleId: string;
  kind: MemoryKind;
  title: string;
  content: string;
  /** 目标 topic slug；缺省由 title 推导 */
  topicSlug?: string;
  /** 人审档位：auto=直接进索引；manual=发卡人审（缺省 manual） */
  review: MemoryReview;
  /** 来源原料指针（#145 蒸馏产物三分落地：原料知识条目 id 清单；#99 提取链路不传） */
  sourceRefs?: string[];
  createdAt: string;
}

/** 草稿行（含 promote/reject 墓碑标记；append-only 下追加墓碑行而非改写原行） */
export interface MemoryDraftRow extends MemoryDraftEntry {
  promoted?: boolean;
  promotedAt?: string;
  rejected?: boolean;
  rejectedAt?: string;
}

/**
 * review-proposal 正本状态墓碑行（#353 接线后由 adapter 追加到条目所属角色的 draft.jsonl）。
 * 与条目行同文件混存；`kind:'status'` 为判别字段（条目行 kind 白名单不含 'status'）。
 */
export interface MemoryDraftStatusRow {
  kind: 'status';
  id: string;
  status: MemoryDraftReviewStatus;
  at: string;
}

/** draft.jsonl 行 = 条目/墓碑行 | 正本状态行 */
export type MemoryDraftLine = MemoryDraftRow | MemoryDraftStatusRow;

/**
 * 草稿审核状态词表 = review-proposal 正本唯一口径（#353，ADR 决策 3）。
 * 旧 `promoted` 与 `executed` 语义相同（approve 副作用执行成功），读侧归一为 executed。
 */
export type MemoryDraftReviewStatus = 'pending' | 'executed' | 'rejected' | 'failed' | 'card-failed';

/** foldDraftRows 输出：最新条目数据 + 折叠后的审核状态 */
export interface DraftFold {
  entry: MemoryDraftRow;
  status: MemoryDraftReviewStatus;
  statusAt: string;
}

export function isDraftStatusRow(row: MemoryDraftLine): row is MemoryDraftStatusRow {
  return (row as MemoryDraftStatusRow).kind === 'status';
}

/**
 * draft.jsonl 行折叠（读侧归一，ADR 决策 3；存量历史行不改写）：
 * 条目行按 id 取最新；旧墓碑 promoted→executed / rejected→rejected；正本状态行直取；
 * 缺省 pending。后写覆盖先写（append-only 时序）。
 */
export function foldDraftRows(rows: MemoryDraftLine[]): Map<string, DraftFold> {
  const entries = new Map<string, MemoryDraftRow>();
  const statuses = new Map<string, { status: MemoryDraftReviewStatus; at: string }>();
  for (const row of rows) {
    if (isDraftStatusRow(row)) {
      statuses.set(row.id, { status: row.status, at: row.at });
      continue;
    }
    entries.set(row.id, row);
    if (row.promoted) statuses.set(row.id, { status: 'executed', at: row.promotedAt ?? row.createdAt });
    else if (row.rejected) statuses.set(row.id, { status: 'rejected', at: row.rejectedAt ?? row.createdAt });
  }
  const result = new Map<string, DraftFold>();
  for (const [id, entry] of entries) {
    const s = statuses.get(id);
    result.set(id, { entry, status: s?.status ?? 'pending', statusAt: s?.at ?? entry.createdAt });
  }
  return result;
}

/** appendDraft 入参（id/review/createdAt 缺省自动生成；review 缺省 manual） */
export interface AppendDraftInput {
  id?: string;
  kind: MemoryKind;
  title: string;
  content: string;
  topicSlug?: string;
  review?: MemoryReview;
  /** 来源原料指针（#145 蒸馏落地用；缺省不带） */
  sourceRefs?: string[];
  createdAt?: string;
}

/** topic 文档（frontmatter 元数据 + 正文） */
export interface TopicDoc {
  slug: string;
  title: string;
  summary: string;
  kind: MemoryKind | null;
  updatedAt: string;
  body: string;
}

/** 容量上限（超限只提醒，不拒绝写入） */
export interface CapacityLimits {
  /** topic 数（= 索引条目数）上限 */
  maxTopics: number;
  /** pending 草稿条目数上限 */
  maxPendingDrafts: number;
}

export const DEFAULT_CAPACITY_LIMITS: CapacityLimits = {
  maxTopics: 20,
  maxPendingDrafts: 100,
};

export interface CapacityViolation {
  metric: 'topics' | 'draft';
  current: number;
  limit: number;
}

export interface CapacityCheck {
  roleId: string;
  overLimit: boolean;
  violations: CapacityViolation[];
}

export interface PromoteResult {
  roleId: string;
  promoted: number;
  topicsUpdated: string[];
}

export interface DemoteResult {
  roleId: string;
  demoted: number;
}

// ─── 工具 ───

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

/** title → 文件名安全 slug（ASCII 归并；空/全非 ASCII → 'general'） */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'general';
}

/** 一句话摘要：内容首非空行（截断 120 字符） */
function summarize(entry: MemoryDraftEntry): string {
  const firstLine = entry.content
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) ?? entry.title;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/** 目标 topic slug：显式 topicSlug 优先，缺省由 title 推导（sanitize + slugify）。promote 与 #101 卡片共用口径。 */
export function resolveTopicSlug(title: string, topicSlug?: string): string {
  return sanitizeTopicSlug(topicSlug && topicSlug.trim() ? topicSlug : slugify(title));
}

// ─── 服务 ───

export class RoleMemoryStore {
  private readonly limits: CapacityLimits;
  /** per-role 进程内互斥（单进程模型，promote 合并串行化） */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(limits?: Partial<CapacityLimits>) {
    this.limits = { ...DEFAULT_CAPACITY_LIMITS, ...limits };
  }

  // ── 路径生成 ──

  private indexPath(roleId: string): string {
    return path.join(roleMemoryDir(roleId), 'MEMORY.md');
  }

  private topicsDir(roleId: string): string {
    return path.join(roleMemoryDir(roleId), 'topics');
  }

  private topicPath(roleId: string, slug: string): string {
    return path.join(this.topicsDir(roleId), `${sanitizeTopicSlug(slug)}.md`);
  }

  private draftPath(roleId: string): string {
    return path.join(roleMemoryDir(roleId), 'draft.jsonl');
  }

  // ── 读索引（供 #100 注入）──

  /** 读取 MEMORY.md 索引全文。不存在返回 ''（不抛出，供注入兜底）。 */
  async readIndex(roleId: string): Promise<string> {
    const rid = sanitizeRoleId(roleId);
    try {
      return await fs.promises.readFile(this.indexPath(rid), 'utf-8');
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) return '';
      throw err;
    }
  }

  // ── 读 topic ──

  /** 读取单个 topic 文档（frontmatter + 正文）。不存在返回 null。 */
  async readTopic(roleId: string, slug: string): Promise<TopicDoc | null> {
    const rid = sanitizeRoleId(roleId);
    const safeSlug = sanitizeTopicSlug(slug);
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.topicPath(rid, safeSlug), 'utf-8');
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) return null;
      throw err;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      return { slug: safeSlug, title: safeSlug, summary: '', kind: null, updatedAt: '', body: raw.trim() };
    }
    return {
      slug: safeSlug,
      title: typeof parsed.meta.title === 'string' ? parsed.meta.title : safeSlug,
      summary: typeof parsed.meta.summary === 'string' ? parsed.meta.summary : '',
      kind: MEMORY_KINDS.has(String(parsed.meta.kind)) ? (parsed.meta.kind as MemoryKind) : null,
      updatedAt: typeof parsed.meta.updatedAt === 'string' ? parsed.meta.updatedAt : '',
      body: parsed.body,
    };
  }

  /** 读取全部 topic 文档（按 slug 排序）。目录不存在返回 []。 */
  private async readTopicMetas(roleId: string): Promise<TopicDoc[]> {
    const dir = this.topicsDir(roleId);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if (isErrnoCode(err, 'ENOENT')) return [];
      throw err;
    }
    const slugs = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name.replace(/\.md$/, ''))
      .sort();
    const docs: TopicDoc[] = [];
    for (const slug of slugs) {
      const doc = await this.readTopic(roleId, slug);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  // ── 写草稿（append，供 #99 提取写 / #101 人审读）──

  /**
   * 追加一条草稿（JSONL 一行）。kind 白名单外抛错（记忆只收执行知识/偏好两类）。
   * 多 WU 并行 append 天然无冲突（O_APPEND 追加，单行小写入）。
   */
  async appendDraft(roleId: string, input: AppendDraftInput): Promise<MemoryDraftEntry> {
    const rid = sanitizeRoleId(roleId);
    if (!MEMORY_KINDS.has(input.kind)) {
      throw new Error(`Invalid memory kind: ${JSON.stringify(input.kind)}（只收 execution-knowledge / preference）`);
    }
    const entry: MemoryDraftEntry = {
      id: input.id ?? randomUUID(),
      roleId: rid,
      kind: input.kind,
      title: input.title.trim(),
      content: input.content,
      ...(input.topicSlug ? { topicSlug: sanitizeTopicSlug(input.topicSlug) } : {}),
      review: input.review === 'auto' ? 'auto' : 'manual',
      ...(input.sourceRefs && input.sourceRefs.length > 0 ? { sourceRefs: input.sourceRefs } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await store.appendJsonl(this.draftPath(rid), entry);
    return entry;
  }

  /**
   * 读取 pending 草稿条目。append-only 墓碑语义：foldDraftRows 折叠（读侧归一），
   * 只留 status=pending 的条目（旧 promoted/rejected 墓碑与正本 status 行同样排除）。
   */
  async readDraft(roleId: string): Promise<MemoryDraftEntry[]> {
    const rid = sanitizeRoleId(roleId);
    const rows = await store.readJsonl<MemoryDraftLine>(this.draftPath(rid));
    return this.resolvePending(rows);
  }

  /** 折叠后返回仍 pending 的条目行。 */
  private resolvePending(rows: MemoryDraftLine[]): MemoryDraftRow[] {
    return [...foldDraftRows(rows).values()]
      .filter(f => f.status === 'pending')
      .map(f => f.entry);
  }

  // ── promote 合并（单路径 + 同角色互斥）──

  /**
   * 草稿条目 → topic / 索引 的唯一合并路径（供 #101 approve→promote 与自动进索引共用）。
   * 同角色内进程级互斥，防并发 read-modify-write 丢更新。
   * 已 promote 条目经墓碑行标记，readDraft 不再返回。
   */
  async promote(roleId: string, entryIds: string[]): Promise<PromoteResult> {
    const rid = sanitizeRoleId(roleId);
    const ids = new Set(entryIds);
    return this.withRoleLock(rid, async () => {
      const rows = await store.readJsonl<MemoryDraftLine>(this.draftPath(rid));
      const toPromote = this.resolvePending(rows).filter(r => ids.has(r.id));
      if (toPromote.length === 0) {
        return { roleId: rid, promoted: 0, topicsUpdated: [] };
      }

      // 按目标 topic 分组（显式 topicSlug 优先，缺省由 title 推导）
      const bySlug = new Map<string, MemoryDraftRow[]>();
      for (const e of toPromote) {
        const slug = resolveTopicSlug(e.title, e.topicSlug);
        const list = bySlug.get(slug) ?? [];
        list.push(e);
        bySlug.set(slug, list);
      }

      const topicsUpdated: string[] = [];
      for (const [slug, entries] of bySlug) {
        await this.mergeIntoTopic(rid, slug, entries);
        topicsUpdated.push(slug);
      }
      topicsUpdated.sort();

      await this.rebuildIndex(rid);

      const promotedAt = new Date().toISOString();
      for (const e of toPromote) {
        await store.appendJsonl(this.draftPath(rid), { ...e, promoted: true, promotedAt });
      }

      return { roleId: rid, promoted: toPromote.length, topicsUpdated };
    });
  }

  /**
   * 拒绝草稿条目（demote，#101 reject 闸口）：append-only 墓碑语义，追加
   * `{…entry, rejected:true, rejectedAt}` 行；readDraft 排除已 rejected。
   * 与 promote 同角色互斥（共用 withRoleLock）；reject 不做 topic/索引写（不落记忆）。
   */
  async demote(roleId: string, entryIds: string[]): Promise<DemoteResult> {
    const rid = sanitizeRoleId(roleId);
    const ids = new Set(entryIds);
    return this.withRoleLock(rid, async () => {
      const rows = await store.readJsonl<MemoryDraftLine>(this.draftPath(rid));
      const toReject = this.resolvePending(rows).filter(r => ids.has(r.id));
      if (toReject.length === 0) {
        return { roleId: rid, demoted: 0 };
      }
      const rejectedAt = new Date().toISOString();
      for (const e of toReject) {
        await store.appendJsonl(this.draftPath(rid), { ...e, rejected: true, rejectedAt });
      }
      return { roleId: rid, demoted: toReject.length };
    });
  }

  /**
   * 合并一组条目进指定 topic：读旧正文 → 追加段落 → 写回（frontmatter 保留首条元数据）。
   * 幂等：正文已含 `## 标题` 段落的条目跳过——promote 先写 topic 后落墓碑，墓碑追加
   * 失败时条目仍 pending，重试 promote 依赖此跳过避免段落重复。
   */
  private async mergeIntoTopic(roleId: string, slug: string, entries: MemoryDraftRow[]): Promise<void> {
    const filePath = this.topicPath(roleId, slug);
    let meta: Record<string, unknown> = {};
    let body = '';
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        meta = parsed.meta;
        body = parsed.body;
      } else {
        body = raw.trim();
      }
    } catch (err: unknown) {
      if (!isErrnoCode(err, 'ENOENT')) throw err;
    }

    const existingHeadings = new Set(
      body.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3)),
    );
    const fresh = entries.filter(e => !existingHeadings.has(e.title));
    if (fresh.length === 0) return;

    const first = fresh[0];
    meta.title = meta.title ?? first.title;
    meta.summary = meta.summary ?? summarize(first);
    meta.kind = meta.kind ?? first.kind;
    meta.updatedAt = new Date().toISOString();

    const sections = fresh.map(e => `## ${e.title}\n\n${e.content}`).join('\n\n');
    body = body ? `${body}\n\n${sections}` : sections;

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, serializeFrontmatter(meta, body), 'utf-8');
  }

  /** 从全部 topic 的 frontmatter 重建 MEMORY.md 索引（每 topic 一行：路径 + 摘要）。 */
  private async rebuildIndex(roleId: string): Promise<void> {
    const metas = await this.readTopicMetas(roleId);
    const lines = ['# Role Memory Index', '', '<!-- auto-generated: do not edit -->', ''];
    for (const t of metas) {
      lines.push(`- [${t.slug}](topics/${t.slug}.md) — ${t.summary}`);
    }
    if (metas.length === 0) lines.push('(empty)');
    await fs.promises.mkdir(roleMemoryDir(roleId), { recursive: true });
    await fs.promises.writeFile(this.indexPath(roleId), `${lines.join('\n')}\n`, 'utf-8');
  }

  // ── 容量检查（超限提醒，不拒绝写入）──

  /**
   * 容量检查：topic 数 / pending 草稿数超限 → overLimit + 结构化 violation（提醒人合并/淘汰）。
   * 只读不写、不自动删（GC 最简）。此 signal 即未来 KnowledgeSync GC 的合并 hook（#83，暂未接）。
   */
  async checkCapacity(roleId: string): Promise<CapacityCheck> {
    const rid = sanitizeRoleId(roleId);
    const metas = await this.readTopicMetas(rid);
    const drafts = await this.readDraft(rid);
    const violations: CapacityViolation[] = [];
    if (metas.length > this.limits.maxTopics) {
      violations.push({ metric: 'topics', current: metas.length, limit: this.limits.maxTopics });
    }
    if (drafts.length > this.limits.maxPendingDrafts) {
      violations.push({ metric: 'draft', current: drafts.length, limit: this.limits.maxPendingDrafts });
    }
    return { roleId: rid, overLimit: violations.length > 0, violations };
  }

  /** per-role 进程内互斥：链式 Promise 锁，promote 合并串行化。 */
  private async withRoleLock<T>(roleId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(roleId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(roleId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(roleId) === run) this.locks.delete(roleId);
    }
  }
}

/** 模块级单例（供 #99/#100/#101 等消费方共用同一互斥与缓存） */
export const roleMemoryStore = new RoleMemoryStore();
