/**
 * §10.6 skill 生命周期降级通路单测。
 *
 * tmp 目录构造：fixture events jsonl + FileStore WU 索引 + 磁盘 skill（SKILLS_DIR 风格 tmp 目录）。
 * 覆盖：
 *   - 聚合：uses / lastUsedAt / successRate（done=成功，closed/blocked=不成功，未终态不计）
 *   - 规则边界：恰好 5 次使用 + 成功率恰好 0.3 → 不提案；29 天零使用 → 不提案
 *   - 幂等：重复扫描不重复产提案
 *   - approve：frontmatter status 改写且正文逐字节保留（hash 对比）
 *   - reject：只改提案状态
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';

import {
  DemotionProposalStore,
  aggregateSkillUsage,
  scanSkillDemotions,
  approveDemotion,
  rejectDemotion,
  setSkillFrontmatterStatus,
} from '../skill-demotion.js';

let tmpDir: string;
let eventsFile: string;
let skillsDir: string;
let store: DemotionProposalStore;
let fileStore: FileStore;

const NOW = Date.parse('2026-07-21T00:00:00.000Z');
const DAY_MS = 86_400_000;

function makeWu(id: string, status: string, matchedSkills?: string[]): WorkUnitSnapshot {
  return {
    id,
    parentId: null,
    type: 'feature',
    scope: `wu ${id}`,
    assigneeId: 'inst-1',
    status,
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: matchedSkills ? JSON.stringify({ matchedSkills }) : null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    claimedAt: null,
    completedAt: null,
  };
}

function writeIndex(wus: WorkUnitSnapshot[]): void {
  const dir = path.join(tmpDir, 'workunits');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(wus), 'utf-8');
}

function skillUsedEvent(skillName: string, createdAt: string): string {
  return JSON.stringify({
    type: 'knowledge:skill_used',
    source: 'skill-loader',
    payload: JSON.stringify({ skillName, skillId: `file:${skillName}` }),
    createdAt,
  });
}

/** agent-loop step 注入格式（2026-07-27 口径校准：带 workUnitId） */
function skillUsedEventForWu(skillName: string, workUnitId: string, createdAt: string): string {
  return JSON.stringify({
    type: 'knowledge:skill_used',
    source: 'agent-loop',
    payload: JSON.stringify({ skillName, workUnitId }),
    createdAt,
  });
}

function writeEvents(lines: string[]): void {
  fs.writeFileSync(eventsFile, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
}

function writeSkill(name: string, opts?: { ageDays?: number; frontmatterExtra?: string[]; body?: string }): string {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = ['---', `name: '${name}'`, `description: '${name} desc'`, ...(opts?.frontmatterExtra ?? []), '---'].join('\n');
  const body = opts?.body ?? `\n# ${name}\n\n正文内容。\n`;
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, fm + body, 'utf-8');
  if (opts?.ageDays !== undefined) {
    const mtime = new Date(NOW - opts.ageDays * DAY_MS);
    fs.utimesSync(file, mtime, mtime);
  }
  return file;
}

function sha256(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-demotion-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  skillsDir = path.join(tmpDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  store = new DemotionProposalStore(path.join(tmpDir, 'demotion-proposals.json'));
  fileStore = new FileStore(tmpDir);
  writeEvents([]);
  writeIndex([]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('§10.6 aggregateSkillUsage', () => {
  it('聚合 uses / lastUsedAt / successRate（done=成功，closed=不成功，in_review 不计）', async () => {
    writeEvents([
      skillUsedEvent('skill-a', '2026-07-19T10:00:00.000Z'),
      skillUsedEvent('skill-a', '2026-07-20T10:00:00.000Z'),
      skillUsedEvent('skill-b', '2026-07-18T10:00:00.000Z'),
    ]);
    writeIndex([
      makeWu('wu-1', 'done', ['skill-a']),
      makeWu('wu-2', 'closed', ['skill-a']),
      makeWu('wu-3', 'in_review', ['skill-a']), // 未终态不计入
      makeWu('wu-4', 'blocked', ['skill-b']),
      makeWu('wu-5', 'done'),                    // 无 matchedSkills
    ]);

    const usage = await aggregateSkillUsage({ eventsFile, fileStore });
    const a = usage.get('skill-a')!;
    expect(a.uses).toBe(2);
    expect(a.lastUsedAt).toBe('2026-07-20T10:00:00.000Z');
    expect(a.successRate).toBe(0.5); // 1 done / 2 终态

    const b = usage.get('skill-b')!;
    expect(b.uses).toBe(1);
    expect(b.successRate).toBe(0);   // 0 done / 1 终态（blocked）
  });

  it('uses 口径：带 workUnitId 按 (skill, WU) 去重；legacy 无 workUnitId 每条计 1', async () => {
    writeEvents([
      skillUsedEventForWu('skill-a', 'wu-1', '2026-07-19T10:00:00.000Z'),
      skillUsedEventForWu('skill-a', 'wu-1', '2026-07-19T11:00:00.000Z'), // 同 WU 多 step 注入 → 去重
      skillUsedEventForWu('skill-a', 'wu-2', '2026-07-20T10:00:00.000Z'),
      skillUsedEvent('skill-a', '2026-07-18T10:00:00.000Z'),              // legacy 每条计 1
      skillUsedEvent('skill-a', '2026-07-18T11:00:00.000Z'),
    ]);

    const usage = await aggregateSkillUsage({ eventsFile, fileStore });
    const a = usage.get('skill-a')!;
    expect(a.uses).toBe(4); // wu-1×1 + wu-2×1 + legacy×2
    expect(a.lastUsedAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('空数据 → 空 Map，不抛错', async () => {
    const usage = await aggregateSkillUsage({ eventsFile, fileStore });
    expect(usage.size).toBe(0);
  });
});

describe('§10.6 scanSkillDemotions 规则边界', () => {
  it('uses=0 且 >30 天 → archive 提案；29 天 → 不提案', async () => {
    writeSkill('old-skill', { ageDays: 31 });
    writeSkill('young-skill', { ageDays: 29 });

    const result = await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    expect(result.scanned).toBe(2);
    expect(result.created).toBe(1);
    expect(result.proposals[0].skillName).toBe('old-skill');
    expect(result.proposals[0].kind).toBe('archive');
    expect(result.proposals[0].suggestedStatus).toBe('archived');
  });

  it('恰好 5 次使用 + 成功率恰好 0.3 → 不提案；成功率 < 0.3 → demote 提案', async () => {
    // skill-edge: 5 次使用，10 个终态 WU 3 成功 → 0.3，不满足 < 0.3
    // skill-bad:  5 次使用，10 个终态 WU 2 成功 → 0.2，满足
    const events: string[] = [];
    const wus: WorkUnitSnapshot[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(skillUsedEvent('skill-edge', new Date(NOW - i * 1000).toISOString()));
      events.push(skillUsedEvent('skill-bad', new Date(NOW - i * 1000).toISOString()));
    }
    for (let i = 0; i < 10; i++) {
      wus.push(makeWu(`edge-${i}`, i < 3 ? 'done' : 'closed', ['skill-edge']));
      wus.push(makeWu(`bad-${i}`, i < 2 ? 'done' : 'closed', ['skill-bad']));
    }
    writeEvents(events);
    writeIndex(wus);
    writeSkill('skill-edge', { ageDays: 5 });
    writeSkill('skill-bad', { ageDays: 5 });

    const result = await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    expect(result.created).toBe(1);
    expect(result.proposals[0].skillName).toBe('skill-bad');
    expect(result.proposals[0].kind).toBe('demote');
    expect(result.proposals[0].stats.successRate).toBe(0.2);
  });

  it('uses < 5 即使成功率 0 → 不提案；successRate=null（无终态 WU）→ 不提案', async () => {
    writeIndex([makeWu('wu-1', 'closed', ['skill-few'])]);
    writeSkill('skill-few', { ageDays: 5 });
    writeSkill('skill-no-outcome', { ageDays: 5 });
    writeEvents([
      ...Array.from({ length: 4 }, (_, i) => skillUsedEvent('skill-few', new Date(NOW - i * 1000).toISOString())),
      ...Array.from({ length: 6 }, (_, i) => skillUsedEvent('skill-no-outcome', new Date(NOW - i * 1000).toISOString())),
    ]);

    const result = await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    expect(result.created).toBe(0);
  });

  it('幂等：重复扫描不重复产提案（同 skill+kind 只有一条 pending）', async () => {
    writeSkill('old-skill', { ageDays: 40 });

    const first = await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    expect(first.created).toBe(1);
    const second = await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    expect(second.created).toBe(0);
    expect(store.list({ status: 'pending' })).toHaveLength(1);
  });

  it('_ 前缀目录与已归档 skill 跳过', async () => {
    writeSkill('_deprecated-thing', { ageDays: 90 });
    writeSkill('already-archived', { ageDays: 90, frontmatterExtra: ['status: archived'] });

    const result = await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    expect(result.created).toBe(0);
  });
});

describe('§10.6 approve / reject', () => {
  it('approve：替换已有 status 行，正文逐字节保留，文件移动到 _deprecated/', async () => {
    writeSkill('old-skill', { ageDays: 40, frontmatterExtra: [`status: published`], body: `\n# 正文\n\n保留我。\n` });
    const file = path.join(skillsDir, 'old-skill', 'SKILL.md');
    // frontmatter 收尾 --- 起算的正文段
    const bodyOf = (s: string) => s.slice(s.indexOf('\n---\n') + 1);
    const bodyBefore = bodyOf(fs.readFileSync(file, 'utf-8'));

    await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    const proposal = store.list({ status: 'pending' })[0];
    expect(proposal.kind).toBe('archive');

    const ok = await approveDemotion(proposal.id, { store, skillsDir });
    expect(ok).toBe(true);

    // 原路径文件已移走
    expect(fs.existsSync(file)).toBe(false);
    // 新路径文件存在
    const newFile = path.join(skillsDir, '_deprecated', 'old-skill', 'SKILL.md');
    expect(fs.existsSync(newFile)).toBe(true);
    const raw = fs.readFileSync(newFile, 'utf-8');
    expect(raw).toContain('status: archived');
    expect(raw).not.toContain('status: published');
    // 正文逐字节保留：frontmatter 收尾 --- 之后的部分与审批前完全一致
    expect(bodyOf(raw)).toBe(bodyBefore);

    expect(store.get(proposal.id)!.status).toBe('approved');
    expect(store.get(proposal.id)!.reviewedAt).not.toBeNull();
  });

  it('approve：无 status 行时在收尾 --- 前插入，正文不变，文件移动到 _deprecated/', async () => {
    const body = `\n## 没有 status 行的 skill\n`;
    writeSkill('old-skill', { ageDays: 40, body });
    const file = path.join(skillsDir, 'old-skill', 'SKILL.md');
    const rawBefore = fs.readFileSync(file, 'utf-8');
    const bodyBefore = rawBefore.slice(rawBefore.indexOf('\n---\n') + 1);

    await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    const proposal = store.list({ status: 'pending' })[0];
    await approveDemotion(proposal.id, { store, skillsDir });

    // 原路径文件已移走
    expect(fs.existsSync(file)).toBe(false);
    const newFile = path.join(skillsDir, '_deprecated', 'old-skill', 'SKILL.md');
    expect(fs.existsSync(newFile)).toBe(true);
    const rawAfter = fs.readFileSync(newFile, 'utf-8');
    expect(rawAfter).toContain('status: archived\n---');
    expect(rawAfter.slice(rawAfter.indexOf('\n---\n') + 1)).toBe(bodyBefore);
  });

  it('approve：skill 目录从原位置整体移动到 _deprecated/<skillName>/', async () => {
    writeSkill('old-skill', { ageDays: 40, frontmatterExtra: ['status: published'] });
    const originalDir = path.join(skillsDir, 'old-skill');
    const deprecatedDir = path.join(skillsDir, '_deprecated', 'old-skill');

    await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    const proposal = store.list({ status: 'pending' })[0];

    await approveDemotion(proposal.id, { store, skillsDir });

    // 原目录不存在
    expect(fs.existsSync(originalDir)).toBe(false);
    // _deprecated/<skillName>/ 目录存在
    expect(fs.existsSync(deprecatedDir)).toBe(true);
    // SKILL.md 在新位置且 frontmatter status=archived
    const raw = fs.readFileSync(path.join(deprecatedDir, 'SKILL.md'), 'utf-8');
    expect(raw).toContain('status: archived');
  });

  it('已审过的提案再次 approve → false', async () => {
    writeSkill('old-skill', { ageDays: 40 });
    await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    const proposal = store.list({ status: 'pending' })[0];

    expect(await approveDemotion(proposal.id, { store, skillsDir })).toBe(true);
    expect(await approveDemotion(proposal.id, { store, skillsDir })).toBe(false);
  });

  it('reject：只改提案状态，不动 skill 文件', async () => {
    writeSkill('old-skill', { ageDays: 40, frontmatterExtra: ['status: published'] });
    const file = path.join(skillsDir, 'old-skill', 'SKILL.md');
    const hashBefore = sha256(file);

    await scanSkillDemotions({ eventsFile, fileStore, skillsDir, store, now: NOW });
    const proposal = store.list({ status: 'pending' })[0];

    expect(await rejectDemotion(proposal.id, { store })).toBe(true);
    expect(store.get(proposal.id)!.status).toBe('rejected');
    expect(sha256(file)).toBe(hashBefore); // skill 文件未动
    expect(await rejectDemotion(proposal.id, { store })).toBe(false); // 幂等
  });

  it('setSkillFrontmatterStatus 直接调用：frontmatter 其余行原样保留', () => {
    writeSkill('some-skill', {
      frontmatterExtra: [`agentTypes: ['executor']`, `tier: 'standard'`, `status: draft`],
      body: `\nbody\n`,
    });
    const file = path.join(skillsDir, 'some-skill', 'SKILL.md');
    setSkillFrontmatterStatus('some-skill', 'archived', skillsDir);

    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain(`agentTypes: ['executor']`);
    expect(raw).toContain(`tier: 'standard'`);
    expect(raw).toContain('status: archived');
    expect(raw.endsWith('\nbody\n')).toBe(true);
  });
});
