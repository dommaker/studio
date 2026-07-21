/**
 * ResolutionService — RKB 匹配/创建/验证
 *
 * L3~L6 运维配置类知识：错误模式 → 已知解法。
 * 供 agent-executor (重试时注入) 和 Auditor (日审自动创建) 使用。
 *
 * Storage: ~/.studio/knowledge/resolution-{id}.md (frontmatter + body)
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { scheduleVectorDbSync } from './knowledge-bus.service.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  Resolution,
  CreateResolutionInput,
  MatchResolutionInput,
  MatchResolutionResult,
} from '@dommaker/studio-shared';

const KNOWLEDGE_DIR = path.join(os.homedir(), '.studio', 'knowledge');
const STUDIO_EVENTS_JSONL = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
const fileStore = new FileStore();

// ── Helpers ──

function resolutionFromDoc(id: string, meta: Record<string, any>, body: string): any {
  const tags = Array.isArray(meta.tags) ? meta.tags :
    (typeof meta.tags === 'string' ? meta.tags.split(';').filter(Boolean) : []);
  const fixMatch = body.match(/## Solution\n\n([\s\S]*)$/);
  const fix = fixMatch ? fixMatch[1].trim() : body.replace(/^# .*\n/, '').trim();
  return {
    id,
    pattern: meta.pattern || '',
    errorClass: meta.errorClass || '',
    layer: meta.layer || 'L3_tool_behavior',
    title: meta.title || '',
    fix,
    status: meta.maturity || 'pending',
    maturity: meta.maturity || 'pending',
    verifyCount: meta.verifyCount || 0,
    verifiedAt: meta.verifiedAt || null,
    sourceGoalId: meta.sourceGoalId ? String(meta.sourceGoalId) : undefined,
    tags,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || new Date().toISOString(),
  };
}

function generateId(): string {
  return `res_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Scan all resolution-*.md files in knowledge dir.
 *  R5: 直接读目录，不走 _index.md——writeDoc 不维护索引，索引滞后会让扫描对存量
 *  失明（seed 去重失效、auditor/triage 新建解法 UI 不可见的共同根因）。 */
async function scanResolutions(): Promise<any[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(KNOWLEDGE_DIR);
  } catch {
    return [];
  }
  const results: any[] = [];
  for (const f of files) {
    if (!f.startsWith('resolution-') || !f.endsWith('.md')) continue;
    const key = f.replace(/\.md$/, '');
    const doc = await fileStore.readDoc(KNOWLEDGE_DIR, key);
    if (doc) {
      results.push(resolutionFromDoc(key.replace('resolution-', ''), doc.meta, doc.body));
    }
  }
  return results;
}

/** R5: title + 正文内容 hash —— seed/合并去重判据（不受 frontmatter 序列化差异影响） */
function resolutionContentHash(title: string, fix: string): string {
  return crypto.createHash('sha256').update(`${title}\n${fix}`).digest('hex').slice(0, 16);
}

/** Write resolution to knowledge md file */
async function writeResolution(data: {
  id: string; pattern: string; errorClass: string; layer: string;
  title: string; fix: string; status?: string; verifyCount?: number;
  sourceGoalId?: string; tags?: string[]; verifiedAt?: string;
  createdAt?: string; updatedAt?: string;
}): Promise<void> {
  const meta: Record<string, any> = {
    type: 'resolution',
    pattern: data.pattern,
    errorClass: data.errorClass,
    layer: data.layer,
    title: data.title,
    maturity: data.status || 'pending',
    verifyCount: data.verifyCount || 0,
    tags: data.tags || [],
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
  if (data.sourceGoalId) meta.sourceGoalId = data.sourceGoalId;
  if (data.verifiedAt) meta.verifiedAt = data.verifiedAt;

  const body = `# ${data.title}\n\n## Solution\n\n${data.fix}`;
  await fileStore.writeDoc(KNOWLEDGE_DIR, `resolution-${data.id}`, meta, body);
}

// ── Service ──

export class ResolutionService {
  private static instance: ResolutionService;

  static getInstance(): ResolutionService {
    if (!ResolutionService.instance) {
      ResolutionService.instance = new ResolutionService();
    }
    return ResolutionService.instance;
  }

  /**
   * 匹配错误消息 → 已知解法
   */
  async matchResolutions(input: MatchResolutionInput): Promise<MatchResolutionResult> {
    const { errorMessage, errorClass } = input;

    try {
      const all = await scanResolutions();
      const candidates = all.filter((r: any) =>
        (r.maturity === 'verified' || r.maturity === 'canonical') &&
        (!errorClass || r.errorClass === errorClass)
      );

      const matched: Resolution[] = [];
      const lowerMsg = errorMessage.toLowerCase();

      for (const row of candidates) {
        const pattern = row.pattern;
        let isMatch = false;

        try {
          const re = new RegExp(pattern, 'i');
          if (re.test(errorMessage)) isMatch = true;
        } catch {
          if (lowerMsg.includes(pattern.toLowerCase())) isMatch = true;
        }

        if (isMatch) {
          matched.push({
            id: row.id,
            pattern: row.pattern,
            errorClass: row.errorClass,
            layer: row.layer as Resolution['layer'],
            title: row.title,
            fix: row.fix,
            status: row.maturity as Resolution['status'],
            verifyCount: row.verifyCount,
            verifiedAt: row.verifiedAt,
            sourceGoalId: row.sourceGoalId,
            tags: row.tags,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }
      }

      const promptSnippet = matched.length > 0
        ? matched.map((r, i) =>
            `## 已知解法 #${i + 1}: ${r.title}\n${r.fix}\n(verified ${r.verifyCount}x)`
          ).join('\n\n')
        : '';

      if (matched.length > 0) {
        logger.info('[ResolutionService] Resolution matched', {
          count: matched.length,
          ids: matched.map(r => r.id),
          titles: matched.map(r => r.title),
        });

        fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
          type: 'knowledge:consumption',
          source: 'resolution-match',
          payload: JSON.stringify({
            resolutionIds: matched.map(r => r.id),
            pattern: errorMessage.slice(0, 200),
            count: matched.length,
          }),
          createdAt: new Date().toISOString(),
        }).catch((e: any) => {
          logger.warn('[ResolutionService] consumption event failed', { error: String(e) });
        });
      }

      return { matched: matched.length > 0, resolutions: matched, promptSnippet };
    } catch (err) {
      logger.warn('[ResolutionService] match failed', { error: String(err) });
      return { matched: false, resolutions: [], promptSnippet: '' };
    }
  }

  /** 创建 Resolution */
  async createResolution(input: CreateResolutionInput): Promise<Resolution | null> {
    try {
      const all = await scanResolutions();
      if (all.some((r: any) => r.pattern === input.pattern)) return null;

      const id = generateId();
      await writeResolution({
        id,
        pattern: input.pattern,
        errorClass: input.errorClass,
        layer: input.layer,
        title: input.title,
        fix: input.fix,
        status: 'pending',
        verifyCount: 0,
        sourceGoalId: input.sourceGoalId,
        tags: input.tags || [],
      });

      logger.info('[ResolutionService] Created pending resolution', {
        id, title: input.title, pattern: input.pattern,
      });

      return resolutionFromDoc(id, { pattern: input.pattern, errorClass: input.errorClass,
        layer: input.layer, title: input.title, maturity: 'pending', verifyCount: 0,
        sourceGoalId: input.sourceGoalId, tags: input.tags || [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        `# ${input.title}\n\n## Solution\n\n${input.fix}`);
    } catch (err) {
      logger.warn('[ResolutionService] create failed', { error: String(err) });
      return null;
    }
  }

  /** 验证 Resolution */
  async verifyResolution(id: string): Promise<void> {
    try {
      const doc = await fileStore.readDoc(KNOWLEDGE_DIR, `resolution-${id}`);
      if (!doc) return;

      const meta = { ...doc.meta };
      const newCount = (Number(meta.verifyCount) || 0) + 1;
      const newMaturity = newCount >= 3 ? 'canonical' : (newCount >= 1 ? 'verified' : 'pending');

      meta.verifyCount = newCount;
      meta.maturity = newMaturity;
      meta.updatedAt = new Date().toISOString();
      if (!meta.verifiedAt) meta.verifiedAt = new Date().toISOString();

      await fileStore.writeDoc(KNOWLEDGE_DIR, `resolution-${id}`, meta, doc.body);

      logger.info('[ResolutionService] Verified resolution', { id, verifyCount: newCount, status: newMaturity });

      if (newMaturity === 'canonical') {
        scheduleVectorDbSync();
      }
    } catch (err) {
      logger.warn('[ResolutionService] verify failed', { error: String(err) });
    }
  }

  /** 获取所有 pending 的 Resolution */
  async listPending(): Promise<Resolution[]> {
    return this.listByMaturity(['pending']);
  }

  /**
   * R3: 按成熟度列出 Resolution（解法库浏览口径 = pending + canonical，
   * canonical 是审核通过的正式解法，本应展示）。createdAt 倒序。
   */
  async listByMaturity(maturities: Array<Resolution['status']>): Promise<Resolution[]> {
    try {
      const all = await scanResolutions();
      return all.filter((r: any) => maturities.includes(r.maturity))
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((row: any) => ({
          id: row.id, pattern: row.pattern, errorClass: row.errorClass,
          layer: row.layer as Resolution['layer'], title: row.title, fix: row.fix,
          status: row.maturity as Resolution['status'], verifyCount: row.verifyCount,
          verifiedAt: row.verifiedAt, sourceGoalId: row.sourceGoalId,
          tags: row.tags, createdAt: row.createdAt, updatedAt: row.updatedAt,
        }));
    } catch {
      return [];
    }
  }

  /** 预置已知 Resolution Seed — 幂等 */
  async ensureSeedResolutions(): Promise<void> {
    const seeds: CreateResolutionInput[] = [
      {
        pattern: 'dangerously-skip-permissions.*root|cannot be used with root',
        errorClass: 'permission_error',
        layer: 'L3_tool_behavior',
        title: 'root 用户不能使用 --dangerously-skip-permissions',
        fix: 'CLI flag `--dangerously-skip-permissions` 在 root 下被禁止。改用 settings.json 配置：在工作目录下创建 `.claude/settings.json`，写入 `{"permissions": {"defaultMode": "bypassPermissions"}}`，然后去掉命令中的 `--dangerously-skip-permissions` flag。',
        tags: ['cli', 'root', 'permission', 'claude-code'],
      },
      {
        pattern: 'surgical.*regression|非目标变更|未授权删除|删了不该删|scope.*violation|不该改',
        errorClass: 'scope_violation',
        layer: 'L3_tool_behavior',
        title: 'AC 范围外修改 — 改/删了 AC 未要求的代码导致功能回归',
        fix: '检查 AC 中的 files 列表和 gotchas（红线）。不在 AC 范围内的代码绝对不要碰，尤其是：① shell 重定向参数(2>&1, tee)通常有隐蔽的消费者(audit/log)；② 异常处理代码；③ 未在 AC 中提及的文件。每处改动前问自己：这个改动属于哪个 AC？如果找不到对应的 AC → 不要改。',
        tags: ['executor', 'surgical', 'scope', 'regression'],
      },
    ];

    // R5: 启动幂等 —— 旧判据 pattern 等值比较依赖 _index.md 可见性，索引滞后时
    // 每次启动重复写 seed（生产 730 条 = 2 seed × 365 次启动）。改为一次性扫描存量，
    // 按 title+内容 hash 判重；同一批内登记 hash 防同 run 重复。
    let existingHashes: Set<string>;
    try {
      const existing = await scanResolutions();
      existingHashes = new Set(existing.map((r: any) => resolutionContentHash(r.title, r.fix)));
    } catch {
      existingHashes = new Set();
    }

    for (const seed of seeds) {
      try {
        const hash = resolutionContentHash(seed.title, seed.fix);
        if (existingHashes.has(hash)) continue;

        const id = generateId();
        await writeResolution({
          id,
          pattern: seed.pattern,
          errorClass: seed.errorClass,
          layer: seed.layer,
          title: seed.title,
          fix: seed.fix,
          status: 'canonical',
          verifyCount: 3,
          tags: seed.tags || [],
          verifiedAt: new Date().toISOString(),
        });
        existingHashes.add(hash);
        logger.info('[ResolutionService] Seeded resolution', { title: seed.title });
      } catch (err) {
        logger.warn('[ResolutionService] Seed failed for pattern', { pattern: seed.pattern, error: String(err) });
      }
    }
  }

  /** 写 canonical resolutions 到磁盘 + 重建索引 */
  async writeCanonicalToDisk(): Promise<void> {
    try {
      await fileStore.buildIndex(KNOWLEDGE_DIR, ['id', 'type', 'title', 'maturity', 'tags', 'terms']);
      logger.info('[ResolutionService] Knowledge index rebuilt');
    } catch (err) {
      logger.warn('[ResolutionService] writeCanonicalToDisk failed', { error: String(err) });
    }
  }

  /** 格式化 verified + canonical resolution 为 prompt snippet */
  async formatForPrompt(): Promise<string> {
    try {
      const all = await scanResolutions();
      const resolutions = all
        .filter((r: any) => r.maturity === 'canonical' || r.maturity === 'verified')
        .sort((a: any, b: any) => (b.verifyCount || 0) - (a.verifyCount || 0))
        .slice(0, 10);
      if (resolutions.length === 0) return '';
      return resolutions.map((r: any, i: number) =>
        `### ${i + 1}. ${r.title}\n${r.fix}`
      ).join('\n\n');
    } catch {
      return '';
    }
  }

  /** Knowledge density scoring */
  async getDensityScore(): Promise<{
    score: number; total: number; verified: number; canonical: number;
    errorClasses: number; layers: number;
  }> {
    try {
      const all = await scanResolutions();
      const total = all.length;
      const verified = all.filter((r: any) => r.maturity === 'verified').length;
      const canonical = all.filter((r: any) => r.maturity === 'canonical').length;
      const errorClasses = new Set(all.map((r: any) => r.errorClass).filter(Boolean)).size;
      const layers = new Set(all.map((r: any) => r.layer).filter(Boolean)).size;

      const countScore = Math.min(total / 20, 1) * 25;
      const verifiedRatio = total > 0 ? (verified + canonical) / total : 0;
      const verifiedScore = verifiedRatio * 25;
      const breadthScore = Math.min(errorClasses / 8, 1) * 25;
      const layerScore = Math.min(layers / 4, 1) * 25;

      return {
        score: Math.round(countScore + verifiedScore + breadthScore + layerScore),
        total, verified, canonical, errorClasses, layers,
      };
    } catch {
      return { score: 0, total: 0, verified: 0, canonical: 0, errorClasses: 0, layers: 0 };
    }
  }

  /** Auto-verify from behavior confirmation */
  async autoVerifyFromBehavior(category: string, pattern: string): Promise<number> {
    try {
      const categoryToErrorClass: Record<string, string> = {
        correction: 'scope_violation', automation: 'repetitive_task',
      };
      const errorClass = categoryToErrorClass[category];
      if (!errorClass) return 0;

      const all = await scanResolutions();
      const candidates = all.filter((r: any) =>
        r.errorClass === errorClass &&
        (r.maturity === 'pending' || r.maturity === 'verified')
      );

      let verified = 0;
      for (const r of candidates) {
        try {
          const re = new RegExp(r.pattern, 'i');
          if (re.test(pattern)) { await this.verifyResolution(r.id); verified++; }
        } catch {
          if (pattern.toLowerCase().includes(r.pattern.toLowerCase())) {
            await this.verifyResolution(r.id); verified++;
          }
        }
      }
      return verified;
    } catch (err) {
      logger.warn('[ResolutionService] autoVerifyFromBehavior failed', { error: String(err) });
      return 0;
    }
  }

  /** Cross-session causality stats */
  async getCrossSessionStats(): Promise<{
    linkedToGoals: number; unlinked: number;
    topErrorClasses: Array<{ errorClass: string; count: number; avgVerifyCount: number }>;
  }> {
    try {
      const all = await scanResolutions();
      const linkedToGoals = all.filter((r: any) => r.sourceGoalId).length;
      const unlinked = all.filter((r: any) => !r.sourceGoalId).length;

      const classMap = new Map<string, { count: number; totalVerify: number }>();
      for (const r of all) {
        const ec = r.errorClass;
        if (!classMap.has(ec)) classMap.set(ec, { count: 0, totalVerify: 0 });
        const entry = classMap.get(ec)!;
        entry.count++;
        entry.totalVerify += r.verifyCount || 0;
      }
      const topErrorClasses = [...classMap.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([errorClass, { count, totalVerify }]) => ({
          errorClass, count, avgVerifyCount: Math.round(totalVerify / count),
        }));

      return { linkedToGoals, unlinked, topErrorClasses };
    } catch {
      return { linkedToGoals: 0, unlinked: 0, topErrorClasses: [] };
    }
  }
}

export const resolutionService = ResolutionService.getInstance();
export const resolutionMatcher = resolutionService;
