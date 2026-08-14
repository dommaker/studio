/**
 * normalize-archive-maturity.ts — #142 maturity 脏数据清洗迁移测试
 *
 * 在 tmp archive 目录构造脏 maturity 样本（active/canonical/draft/pending/verified），
 * 验证：归位为 archived、正文与其他 frontmatter 逐字节保留、幂等、
 * 非递归（子目录不动）、与 FileKnowledgeStore.rebuildIndex 一致可用（AC3）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  normalizeArchiveMaturities,
  normalizeMaturityLine,
  ARCHIVE_MATURITY,
} from '../normalize-archive-maturity';
import { FileKnowledgeStore } from '@dommaker/harness';

/** 构造一条合法的知识条目文件内容；maturityLine 可传原始行（控制引号形态） */
function entryFile(id: string, type: string, maturityLine: string): string {
  const fm = [
    `id: ${id}`,
    `type: ${type}`,
    'title: fixture-title',
    maturityLine,
    "layer: project",
    "created: '2026-01-01T00:00:00.000Z'",
    "lastReferenced: '2026-01-02T00:00:00.000Z'",
    'contributors:',
    '  - test-agent',
    'projects: []',
    'tags:',
    '  - sample',
    'applicablePhases: []',
    'sourceReferences:',
    '  - workflow: session-x',
    "    timestamp: '2026-01-01T00:00:00.000Z'",
    'referencedBy: []',
    'consumptionMode: reference',
    'origin: agent',
  ].join('\n');
  // 与 FileKnowledgeStore.save() 同款分隔：---\n<fm>\n---\n\n<body>
  return `---\n${fm}\n---\n\n# Body ${id}\n\nunique-body-content-${id}\n`;
}

describe('normalizeArchiveMaturities (#142)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-maturity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('normalizeMaturityLine（纯函数）', () => {
    it.each([
      ['active', 'maturity: active'],
      ['quoted canonical', 'maturity: "canonical"'],
      ['draft', 'maturity: draft'],
      ['quoted pending', 'maturity: "pending"'],
      ['verified', 'maturity: verified'],
      ['quoted verified', 'maturity: "verified"'],
      ['deprecated', 'maturity: deprecated'],
      ['proven', 'maturity: proven'],
    ])('归位 %s → archived', (_label, maturityLine) => {
      const raw = entryFile('e1', 'guideline', maturityLine);
      const out = normalizeMaturityLine(raw);
      expect(out.status).toBe('normalized');
      if (out.status === 'normalized') {
        expect(out.content).toContain(`maturity: ${ARCHIVE_MATURITY}\n`);
        // 正文逐字节保留
        expect(out.content.endsWith('# Body e1\n\nunique-body-content-e1\n')).toBe(true);
      }
    });

    it('已是 archived → already-archived（幂等不动）', () => {
      const raw = entryFile('e2', 'guideline', 'maturity: archived');
      expect(normalizeMaturityLine(raw)).toEqual({ status: 'already-archived' });
    });

    it('无 frontmatter → skipped', () => {
      expect(normalizeMaturityLine('# no frontmatter\nbody\n')).toEqual({
        status: 'skipped', reason: 'no frontmatter',
      });
    });

    it('有 frontmatter 但无 maturity 行 → skipped', () => {
      const raw = '---\nid: x\ntype: guideline\ntitle: t\n---\n\nbody\n';
      expect(normalizeMaturityLine(raw)).toEqual({
        status: 'skipped', reason: 'no maturity field',
      });
    });
  });

  it('只替换 maturity 行，正文与其他 frontmatter 逐字节保留', () => {
    const before = entryFile('a1', 'decision', 'maturity: active');
    fs.writeFileSync(path.join(dir, 'decision-a1.md'), before);

    const result = normalizeArchiveMaturities(dir);

    expect(result).toMatchObject({ total: 1, normalized: 1, unchanged: 0 });
    const after = fs.readFileSync(path.join(dir, 'decision-a1.md'), 'utf-8');
    // 唯一差异 = maturity 行
    expect(after).toBe(before.replace('maturity: active', 'maturity: archived'));
    // 其他 frontmatter 字段与正文完整保留（抽查易被重排/重写的列表与嵌套结构）
    expect(after).toContain('contributors:\n  - test-agent');
    expect(after).toContain('sourceReferences:\n  - workflow: session-x');
    expect(after).toContain('unique-body-content-a1');
  });

  it('批量归位脏值 + 幂等（二次执行为 0）', () => {
    fs.writeFileSync(path.join(dir, 'guideline-g1.md'), entryFile('g1', 'guideline', 'maturity: active'));
    fs.writeFileSync(path.join(dir, 'guideline-g2.md'), entryFile('g2', 'guideline', 'maturity: "canonical"'));
    fs.writeFileSync(path.join(dir, 'guideline-g3.md'), entryFile('g3', 'guideline', 'maturity: draft'));
    fs.writeFileSync(path.join(dir, 'guideline-g4.md'), entryFile('g4', 'guideline', 'maturity: "pending"'));
    fs.writeFileSync(path.join(dir, 'guideline-g5.md'), entryFile('g5', 'guideline', 'maturity: verified'));
    fs.writeFileSync(path.join(dir, 'guideline-g6.md'), entryFile('g6', 'guideline', 'maturity: archived'));

    const first = normalizeArchiveMaturities(dir);
    expect(first).toMatchObject({ total: 6, normalized: 5, unchanged: 1, dryRun: false });

    // 全部归位
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      expect(fs.readFileSync(path.join(dir, f), 'utf-8')).toMatch(/^maturity: archived$/m);
    }

    // 幂等：二次执行零改动
    const second = normalizeArchiveMaturities(dir);
    expect(second).toMatchObject({ total: 6, normalized: 0, unchanged: 6 });
  });

  it('dry-run 只报告不落盘', () => {
    const file = path.join(dir, 'guideline-g1.md');
    fs.writeFileSync(file, entryFile('g1', 'guideline', 'maturity: active'));

    const result = normalizeArchiveMaturities(dir, { dryRun: true });

    expect(result).toMatchObject({ total: 1, normalized: 1, dryRun: true });
    expect(fs.readFileSync(file, 'utf-8')).toContain('maturity: active'); // 未落盘
  });

  it('非递归：子目录文件不动', () => {
    fs.writeFileSync(path.join(dir, 'guideline-g1.md'), entryFile('g1', 'guideline', 'maturity: active'));
    const sub = path.join(dir, 'resolutions');
    fs.mkdirSync(sub, { recursive: true });
    // resolution 记录用 maturity 当 status 阶梯（canonical），不得被归位
    fs.writeFileSync(path.join(sub, 'resolution-r1.md'), '---\ntype: "resolution"\npattern: "x"\nmaturity: "canonical"\n---\n\nbody\n');

    const result = normalizeArchiveMaturities(dir);

    expect(result.total).toBe(1); // 只数顶层 .md
    expect(fs.readFileSync(path.join(sub, 'resolution-r1.md'), 'utf-8')).toContain('maturity: "canonical"');
  });

  it('skip 无 frontmatter / 无 maturity 文件并记录原因', () => {
    fs.writeFileSync(path.join(dir, 'plain-note.md'), '# no frontmatter\n');
    fs.writeFileSync(path.join(dir, 'no-maturity.md'), '---\nid: x\ntype: guideline\ntitle: t\n---\n\nbody\n');

    const result = normalizeArchiveMaturities(dir);

    expect(result.total).toBe(2);
    expect(result.normalized).toBe(0);
    // fs.readdirSync 顺序不保证 → 排序后断言，避免顺序脆弱
    expect(result.skipped.slice().sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: 'no-maturity.md', reason: 'no maturity field' },
      { file: 'plain-note.md', reason: 'no frontmatter' },
    ]);
  });

  it('AC3：迁移前后 FileKnowledgeStore.rebuildIndex 一致可用，index.json 与磁盘同步', () => {
    fs.writeFileSync(path.join(dir, 'guideline-g1.md'), entryFile('g1', 'guideline', 'maturity: active'));
    fs.writeFileSync(path.join(dir, 'guideline-g2.md'), entryFile('g2', 'guideline', 'maturity: "canonical"'));
    fs.writeFileSync(path.join(dir, 'guideline-g3.md'), entryFile('g3', 'guideline', 'maturity: archived'));

    const store = new FileKnowledgeStore({ baseDir: dir });

    // 迁移前：rebuildIndex 反映脏 maturity
    store.rebuildIndex();
    const beforeIdx = store.readIndex();
    expect(beforeIdx).toHaveLength(3);
    expect(beforeIdx.find(e => e.id === 'g1')!.maturity).toBe('active');
    expect(beforeIdx.find(e => e.id === 'g2')!.maturity).toBe('canonical');

    // 迁移
    normalizeArchiveMaturities(dir);

    // 迁移后：rebuildIndex 全 archived，与磁盘条目一致
    store.rebuildIndex();
    const afterIdx = store.readIndex();
    expect(afterIdx).toHaveLength(3);
    expect(afterIdx.every(e => e.maturity === ARCHIVE_MATURITY)).toBe(true);
    expect(afterIdx.map(e => e.id).sort()).toEqual(
      store.readEntriesFromDisk().map(e => e.id).sort(),
    );
  });
});
