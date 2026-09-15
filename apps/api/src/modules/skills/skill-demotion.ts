/**
 * §10.6 skill 生命周期降级通路（聚合 + 降级提案）。
 *
 * 数据流（skill 度量地基票 D，2026-09-15 口径重定义：曝光 vs 使用分离）：
 *   knowledge:skill_used 事件（payload: { skillName, workUnitId?, channel? }）
 *     发射点：skill-loader.ts（loadSkill 文件路径）/ skill-tools.ts（loadSkill cache
 *     路径）/ skill-usage-scan.ts（WU done transcript 后验扫描，主口径）。
 *     → uses = 使用 WU 数：带 workUnitId 的事件按 (skill, workUnitId) 去重（同一 WU
 *       多渠道/多步只计一次）；legacy 事件（无 workUnitId）每条计 1 次。
 *     → successRate 使用归因：终态 WU 关联 = 该 WU 有该 skill 的 skill_used 事件
 *       （注入了没被读的 skill 不背 WU 成败）；done = 成功，closed/blocked = 不成功，
 *       其余（active/in_review/unassigned 等）未终态不计入。
 *   WU 索引 metadata.matchedSkills（决策 7：agent-loop step 时匹配并落盘）
 *     → exposures 曝光计数（注入名单命中次数，含未终态 WU），仅人审参考，
 *       不参与 demote 判定。
 *   无关联终态 WU 时 successRate = null（未知，不参与 demote 判定，不编造）。
 *
 * 降级规则（只产提案，绝不自动生效；人审通过才改 frontmatter）：
 *   - uses === 0 且 SKILL.md 文件年龄 > 30 天（mtime）→ archive 提案
 *   - uses >= 5 且 successRate < 0.3 → demote 提案（suggestedStatus: archived）
 *
 * 提案存储：~/.studio/data/skills/demotion-proposals.json（ProposalStore 同款 JSON 数组风格），
 * 幂等：同一 skill+kind 只存在一条 pending 提案。
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { FileStore, logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const SKILLS_DIR = process.env.SKILLS_DIR || studioPath('skills');
const DEFAULT_STORE_FILE = studioPath('data', 'skills', 'demotion-proposals.json');

/** 降级规则阈值 */
export const ARCHIVE_AGE_DAYS = 30;
export const DEMOTE_MIN_USES = 5;
export const DEMOTE_MAX_SUCCESS_RATE = 0.3;

// ── Types ──

export interface SkillUsageStats {
  uses: number;
  /** 终态 WU 成功率（使用归因：有 skill_used 的 WU 才计入）；无关联终态 WU → null（未知） */
  successRate: number | null;
  lastUsedAt: string | null;
  /** 曝光次数（注入名单 matchedSkills 命中计数，含未终态 WU）；仅人审参考，不参与 demote 判定 */
  exposures: number;
}

export type DemotionKind = 'archive' | 'demote';

export interface DemotionProposal {
  id: string;
  skillName: string;
  kind: DemotionKind;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  stats: SkillUsageStats & { ageDays: number };
  suggestedStatus: 'archived';
  createdAt: string;
  reviewedAt: string | null;
}

// ── Store（JSON 数组文件，风格对齐 ProposalStore）──

export class DemotionProposalStore {
  private cache: DemotionProposal[] | null = null;

  constructor(private filePath: string = DEFAULT_STORE_FILE) {}

  private loadIndex(): DemotionProposal[] {
    if (this.cache) return this.cache;
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = [];
        return this.cache;
      }
      this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return this.cache!;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  private saveIndex(records: DemotionProposal[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.cache = records;
    fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf-8');
  }

  list(filter?: { status?: string; skillName?: string; kind?: DemotionKind }): DemotionProposal[] {
    let all = this.loadIndex();
    if (filter?.status) all = all.filter(p => p.status === filter.status);
    if (filter?.skillName) all = all.filter(p => p.skillName === filter.skillName);
    if (filter?.kind) all = all.filter(p => p.kind === filter.kind);
    return all;
  }

  get(id: string): DemotionProposal | null {
    return this.loadIndex().find(p => p.id === id) ?? null;
  }

  /** 幂等关键：是否已有同 skill+kind 的 pending 提案 */
  hasPending(skillName: string, kind: DemotionKind): boolean {
    return this.loadIndex().some(p => p.skillName === skillName && p.kind === kind && p.status === 'pending');
  }

  create(input: Omit<DemotionProposal, 'id' | 'status' | 'createdAt' | 'reviewedAt'>): DemotionProposal {
    const all = this.loadIndex();
    const record: DemotionProposal = {
      ...input,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedAt: null,
    };
    all.push(record);
    this.saveIndex(all);
    logger.info('[SkillDemotion] Created proposal', { id: record.id, skillName: record.skillName, kind: record.kind });
    return record;
  }

  update(id: string, patch: { status: 'approved' | 'rejected' }): DemotionProposal | null {
    const all = this.loadIndex();
    const idx = all.findIndex(p => p.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], status: patch.status, reviewedAt: new Date().toISOString() };
    this.saveIndex(all);
    return all[idx];
  }

  /** 外部改文件后调用 */
  invalidateCache(): void {
    this.cache = null;
  }
}

/** 默认单例（路由用） */
export const demotionProposalStore = new DemotionProposalStore();

// ── 聚合 ──

export interface AggregateOptions {
  eventsFile?: string;
  fileStore?: FileStore;
}

/**
 * 聚合 knowledge:skill_used 事件 + WU 终态 → 每 skill { uses, successRate, lastUsedAt, exposures }。
 * 事件文件/索引不可读 → 返回空 Map，不抛错。
 */
export async function aggregateSkillUsage(opts?: AggregateOptions): Promise<Map<string, SkillUsageStats>> {
  const eventsFile = opts?.eventsFile ?? STUDIO_EVENTS_JSONL;
  const fileStore = opts?.fileStore ?? new FileStore();
  const stats = new Map<string, SkillUsageStats>();

  const ensure = (name: string): SkillUsageStats => {
    let s = stats.get(name);
    if (!s) {
      s = { uses: 0, successRate: null, lastUsedAt: null, exposures: 0 };
      stats.set(name, s);
    }
    return s;
  };

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await fileStore.readJsonl<Record<string, unknown>>(eventsFile);
  } catch {
    rows = [];
  }

  // uses 去重：带 workUnitId 的事件按 (skill, workUnitId) 只计一次（同一 WU 多渠道/多步不重复计数）；
  // usedWuIds 供 successRate 使用归因（票 D）
  const seenWuPairs = new Set<string>();
  const usedWuIds = new Map<string, Set<string>>();

  for (const row of rows) {
    if (row?.type !== 'knowledge:skill_used') continue;
    let payload: Record<string, unknown>;
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>) ?? {};
    } catch {
      continue;
    }
    const name = typeof payload.skillName === 'string' ? payload.skillName : null;
    if (!name) continue;
    const wuId = typeof payload.workUnitId === 'string' && payload.workUnitId ? payload.workUnitId : null;
    const s = ensure(name);
    if (wuId) {
      const pairKey = `${name}${wuId}`;
      if (!seenWuPairs.has(pairKey)) {
        seenWuPairs.add(pairKey);
        s.uses++;
      }
      let ids = usedWuIds.get(name);
      if (!ids) {
        ids = new Set();
        usedWuIds.set(name, ids);
      }
      ids.add(wuId);
    } else {
      s.uses++; // legacy 事件（无 workUnitId）每条计 1 次（无法归因成功率）
    }
    const tsRaw = (row.createdAt ?? row.timestamp) as string | undefined;
    if (tsRaw && (!s.lastUsedAt || tsRaw > s.lastUsedAt)) s.lastUsedAt = tsRaw;
  }

  // WU 索引：终态状态表（successRate 使用归因）+ 曝光计数（matchedSkills 命中，仅展示）
  const wuStatus = new Map<string, string>();
  const wus = await fileStore.getIndex().catch(() => []);
  for (const wu of wus) {
    wuStatus.set(wu.id, wu.status);
    if (!wu.metadata) continue;
    let matched: unknown;
    try {
      matched = (JSON.parse(wu.metadata) as Record<string, unknown>).matchedSkills;
    } catch {
      continue;
    }
    if (!Array.isArray(matched)) continue;
    for (const name of matched) {
      if (typeof name !== 'string' || !name) continue;
      ensure(name).exposures++;
    }
  }

  // successRate 使用归因（票 D）：usedWuIds ∩ 终态 WU（done=成功，closed/blocked=不成功）；
  // 无关联终态 WU → 保持 null（未知，不编造）
  for (const [name, ids] of usedWuIds) {
    let success = 0;
    let final = 0;
    for (const id of ids) {
      const st = wuStatus.get(id);
      if (st === 'done') {
        success++;
        final++;
      } else if (st === 'closed' || st === 'blocked') {
        final++;
      }
    }
    if (final > 0) stats.get(name)!.successRate = success / final;
  }

  return stats;
}

// ── 降级扫描 ──

export interface ScanOptions extends AggregateOptions {
  skillsDir?: string;
  store?: DemotionProposalStore;
  /** 测试注入时钟 */
  now?: number;
}

interface SkillOnDisk {
  name: string;
  skillFile: string;
  mtimeMs: number;
  status: string | null;
}

/** 扫描 skills 目录（跳过 _ 前缀目录，与 manifest-loader 口径一致） */
function listSkillsOnDisk(skillsDir: string): SkillOnDisk[] {
  const result: SkillOnDisk[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith('_')) continue;
    const skillFile = path.join(skillsDir, dir.name, 'SKILL.md');
    try {
      const st = fs.statSync(skillFile);
      const status = readFrontmatterStatus(fs.readFileSync(skillFile, 'utf-8'));
      result.push({ name: dir.name, skillFile, mtimeMs: st.mtimeMs, status });
    } catch {
      continue; // 无 SKILL.md / 不可读 → 跳过
    }
  }
  return result;
}

function readFrontmatterStatus(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find(l => /^status\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^status\s*:\s*/, '').replace(/^["']|["']$/g, '').trim() || null;
}

/**
 * 扫描全部磁盘 skill，按降级规则生成提案（幂等：同 skill+kind 已有 pending 则跳过）。
 * 返回本次扫描结果。绝不自动生效——生效走 approve。
 */
export async function scanSkillDemotions(opts?: ScanOptions): Promise<{
  scanned: number;
  created: number;
  proposals: DemotionProposal[];
}> {
  const skillsDir = opts?.skillsDir ?? SKILLS_DIR;
  const store = opts?.store ?? demotionProposalStore;
  const now = opts?.now ?? Date.now();

  const usage = await aggregateSkillUsage(opts);
  const skills = listSkillsOnDisk(skillsDir);
  const created: DemotionProposal[] = [];

  for (const skill of skills) {
    // 已归档的 skill 不再产提案
    if (skill.status === 'archived') continue;

    const stats = usage.get(skill.name) ?? { uses: 0, successRate: null, lastUsedAt: null, exposures: 0 };
    const ageDays = (now - skill.mtimeMs) / 86_400_000;
    const statsWithAge = { ...stats, ageDays: Math.round(ageDays * 10) / 10 };

    if (stats.uses === 0 && ageDays > ARCHIVE_AGE_DAYS) {
      if (!store.hasPending(skill.name, 'archive')) {
        created.push(store.create({
          skillName: skill.name,
          kind: 'archive',
          reason: `零使用且已存在 ${Math.floor(ageDays)} 天（> ${ARCHIVE_AGE_DAYS} 天）`,
          stats: statsWithAge,
          suggestedStatus: 'archived',
        }));
      }
      continue;
    }

    if (stats.uses >= DEMOTE_MIN_USES && stats.successRate !== null && stats.successRate < DEMOTE_MAX_SUCCESS_RATE) {
      if (!store.hasPending(skill.name, 'demote')) {
        created.push(store.create({
          skillName: skill.name,
          kind: 'demote',
          reason: `使用 ${stats.uses} 次（>= ${DEMOTE_MIN_USES}）但关联 WU 成功率 ${(stats.successRate * 100).toFixed(0)}% < ${DEMOTE_MAX_SUCCESS_RATE * 100}%`,
          stats: statsWithAge,
          suggestedStatus: 'archived',
        }));
      }
    }
  }

  return { scanned: skills.length, created: created.length, proposals: created };
}

// ── 审批 ──

/**
 * 改写 SKILL.md frontmatter 的 status 行；正文（frontmatter 结束后）逐字节保留。
 * 有 status 行则替换，无则在收尾 --- 前插入。frontmatter 其余行同样原样保留。
 */
export function setSkillFrontmatterStatus(skillName: string, status: string, skillsDir?: string): void {
  const dir = skillsDir ?? SKILLS_DIR;
  const skillFile = path.join(dir, skillName, 'SKILL.md');
  const raw = fs.readFileSync(skillFile, 'utf-8');

  const match = raw.match(/^---\n[\s\S]*?\n---/);
  if (!match) throw new Error(`SKILL.md has no frontmatter: ${skillFile}`);

  const head = match[0];
  const body = raw.slice(head.length); // 正文逐字节保留
  const lines = head.split('\n');
  // lines[0] = '---'，lines[lines.length-1] = '---'
  const statusIdx = lines.findIndex(l => /^status\s*:/.test(l));
  if (statusIdx !== -1) {
    lines[statusIdx] = `status: ${status}`;
  } else {
    lines.splice(lines.length - 1, 0, `status: ${status}`);
  }
  fs.writeFileSync(skillFile, lines.join('\n') + body, 'utf-8');
  logger.info('[SkillDemotion] Frontmatter status updated', { skillName, status });
}

export interface ReviewOptions {
  store?: DemotionProposalStore;
  skillsDir?: string;
}

/**
 * 批准提案：把 skill frontmatter status 改为 suggestedStatus（archived）。
 * 返回 false = 提案不存在或已审过；SKILL.md 缺失/无 frontmatter 抛错（路由转 500），
 * 此时提案保持 pending 可重试。
 */
export async function approveDemotion(id: string, opts?: ReviewOptions): Promise<boolean> {
  const store = opts?.store ?? demotionProposalStore;
  const p = store.get(id);
  if (!p || p.status !== 'pending') return false;

  const dir = opts?.skillsDir ?? SKILLS_DIR;
  // 1. 写 frontmatter status=archived（原路径）
  setSkillFrontmatterStatus(p.skillName, p.suggestedStatus, dir);
  // 2. 移动 skill 目录到 _deprecated/<skillName>/（listSkillsOnDisk 跳过 _ 前缀）
  const srcDir = path.join(dir, p.skillName);
  const destDir = path.join(dir, '_deprecated', p.skillName);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.renameSync(srcDir, destDir);
  logger.info('[SkillDemotion] Skill directory moved to _deprecated', { skillName: p.skillName, from: srcDir, to: destDir });
  // 3. 标记提案已审
  store.update(id, { status: 'approved' });
  return true;
}

/** 拒绝提案：只改提案状态，不动 skill 文件 */
export async function rejectDemotion(id: string, opts?: ReviewOptions): Promise<boolean> {
  const store = opts?.store ?? demotionProposalStore;
  const p = store.get(id);
  if (!p || p.status !== 'pending') return false;
  store.update(id, { status: 'rejected' });
  return true;
}
