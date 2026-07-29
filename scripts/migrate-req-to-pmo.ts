/**
 * REQ → PMO 存量迁移（2026-07-28 分析文档，决策 4 修正版）
 *
 * 背景：现存 PMO（PM-XXX）与 REQ（REQ-XXXX）是两条独立序列、编号重叠，
 * 不能按编号直接等价。本脚本：
 *   1. 扫描存量 REQ 与 PMO，生成 reqId→pmoId 映射报告；
 *   2. 校验统一编号起点（max(两序列)+1）不与任何存量 id 冲突；
 *   3. apply 时把映射落盘 <studioHome>/data/req-pmo-map.json（只含已挂接的对子；
 *      未挂接的存量 REQ 保持 legacy 只读，不自动建 PMO——避免把测试/废弃数据脊椎化）。
 *
 * 用法：
 *   npx tsx scripts/migrate-req-to-pmo.ts            # dry-run（默认，只出报告）
 *   npx tsx scripts/migrate-req-to-pmo.ts --apply    # 落盘映射文件
 *   npx tsx scripts/migrate-req-to-pmo.ts --studio-home <dir>  # 指定数据根（测试/排障）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface ReqRecord {
  id: string;
  seq?: number;
  title?: string;
  status?: string;
  projectId?: string | null;
}

export interface ProjectRecord {
  id: string;
  pmoNumber?: string;
  title?: string;
  status?: string;
  reqAlias?: string | null;
  isChore?: boolean;
}

export interface MigrationReport {
  lines: string[];
  unifiedStart: number;
  mapping: Record<string, string>;
  unmapped: string[];
  broken: Array<{ reqId: string; reason: string }>;
  conflicts: string[];
}

function readJsonFiles<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.json') && n !== 'index.json')
    .map(n => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')) as T;
      } catch {
        return null;
      }
    })
    .filter((r): r is T => r !== null);
}

function parseSeq(id: string | undefined, re: RegExp): number | null {
  const m = id?.match(re);
  return m ? parseInt(m[1], 10) : null;
}

/** 核心逻辑（纯数据进/报告出，不碰默认路径——测试经 studioHome 注入 fixture） */
export function runMigration(opts: { studioHome: string; apply?: boolean }): MigrationReport {
  const requirementsDir = path.join(opts.studioHome, 'data', 'requirements');
  const projectsDir = path.join(opts.studioHome, 'projects');
  const mapFile = path.join(opts.studioHome, 'data', 'req-pmo-map.json');

  const reqs = readJsonFiles<ReqRecord>(requirementsDir);
  const projects = readJsonFiles<ProjectRecord>(projectsDir);

  const maxReqSeq = Math.max(0, ...reqs.map(r => r.seq ?? parseSeq(r.id, /^REQ-(\d+)$/) ?? 0));
  const maxPmoSeq = Math.max(0, ...projects.map(p => parseSeq(p.pmoNumber, /^PMO?-(\d+)$/) ?? 0));
  const unifiedStart = Math.max(maxReqSeq, maxPmoSeq) + 1;

  // 映射：只收已挂接 projectId 的 REQ；未挂接的保持 legacy 只读
  const mapping: Record<string, string> = {};
  const unmapped: string[] = [];
  const broken: Array<{ reqId: string; reason: string }> = [];
  for (const req of reqs) {
    if (req.projectId) {
      const target = projects.find(p => p.id === req.projectId);
      if (target) {
        mapping[req.id] = target.id;
      } else {
        broken.push({ reqId: req.id, reason: `projectId ${req.projectId} 指向不存在的项目` });
      }
    } else {
      unmapped.push(req.id);
    }
  }

  // 冲突校验：统一起点之后的编号不得与存量冲突；reqAlias 必须与 pmoNumber 同号
  const conflicts: string[] = [];
  for (const p of projects) {
    const seq = parseSeq(p.pmoNumber, /^PMO?-(\d+)$/);
    if (seq !== null && seq >= unifiedStart) conflicts.push(`PMO 编号越界: ${p.pmoNumber}`);
    if (p.reqAlias) {
      const aliasSeq = parseSeq(p.reqAlias, /^REQ-(\d+)$/);
      if (aliasSeq !== null && aliasSeq !== seq) {
        conflicts.push(`reqAlias 与 pmoNumber 不同号: ${p.pmoNumber} ↔ ${p.reqAlias}`);
      }
    }
  }
  for (const r of reqs) {
    const seq = parseSeq(r.id, /^REQ-(\d+)$/);
    if (seq !== null && seq >= unifiedStart) conflicts.push(`REQ 编号越界: ${r.id}`);
  }

  // 报告文本
  const lines: string[] = [];
  lines.push('═'.repeat(60));
  lines.push(`REQ → PMO 存量迁移 ${opts.apply ? '（--apply 实跑）' : '（dry-run）'}`);
  lines.push('═'.repeat(60));
  lines.push(`存量 REQ: ${reqs.length} 条（最大序号 ${maxReqSeq}）`);
  lines.push(`存量 PMO: ${projects.length} 个（最大序号 ${maxPmoSeq}）`);
  lines.push(`统一编号起点: PMO-${unifiedStart} / REQ-${String(unifiedStart).padStart(4, '0')}`);
  lines.push('');
  lines.push(`已挂接（reqId → pmoId 映射，${Object.keys(mapping).length} 条）:`);
  for (const [reqId, pmoId] of Object.entries(mapping)) {
    const p = projects.find(x => x.id === pmoId);
    lines.push(`  ${reqId} → ${p?.pmoNumber ?? pmoId}`);
  }
  if (Object.keys(mapping).length === 0) lines.push('  （无）');
  lines.push('');
  lines.push(`未挂接（保持 legacy 只读，不迁移，${unmapped.length} 条）:`);
  for (const reqId of unmapped) {
    const req = reqs.find(r => r.id === reqId);
    lines.push(`  ${reqId}  ${(req?.title ?? '').slice(0, 40)}  [${req?.status ?? '?'}]`);
  }
  if (unmapped.length === 0) lines.push('  （无）');
  lines.push('');
  if (broken.length > 0) {
    lines.push(`⚠ 挂接断裂（需人工处理，${broken.length} 条）:`);
    for (const b of broken) lines.push(`  ${b.reqId}: ${b.reason}`);
    lines.push('');
  }
  lines.push(conflicts.length > 0
    ? `⚠ 编号冲突:\n${conflicts.map(c => `  ${c}`).join('\n')}`
    : '✓ 编号冲突校验通过（统一起点不与存量重叠）');

  if (opts.apply) {
    if (conflicts.length === 0) {
      fs.mkdirSync(path.dirname(mapFile), { recursive: true });
      fs.writeFileSync(mapFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        unifiedStart,
        mapping,
        unmapped,
      }, null, 2));
      lines.push(`\n映射已落盘: ${mapFile}`);
    } else {
      lines.push('\n存在编号冲突，中止落盘。');
    }
  } else {
    lines.push('\n（dry-run，未写盘；加 --apply 落盘映射文件）');
  }

  return { lines, unifiedStart, mapping, unmapped, broken, conflicts };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const homeIdx = args.indexOf('--studio-home');
  const studioHome = homeIdx >= 0 ? args[homeIdx + 1] : path.join(os.homedir(), '.studio');

  const report = runMigration({ studioHome, apply });
  console.log(report.lines.join('\n'));
  if (apply && report.conflicts.length > 0) process.exit(1);
}

// 直接执行时走 CLI；被 import（测试）时不执行
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
