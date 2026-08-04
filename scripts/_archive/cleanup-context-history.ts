/**
 * cleanup-context-history.ts — 一次性存量清理（docs/plans/2026-08-context-md-flow-gate.md D1）
 *
 * 扫 apps/packages 全部 CONTEXT.md：
 *   ① 删 `<!-- STALE_SINCE -->` 标记行 + `⚠️ 以下文件已变更` 行
 *   ② 删 hash 格式机器条目（`^- ✅ \`[0-9a-f]{7,10}\`:`）
 *   ③ 蒸馏条目（非 hash 的 `- ` 条目）：--report 模式列出供人工分诊；--write 模式随「修复历史」节一并删除
 *   ④ 删空「修复历史」节 + `<!-- SESSION_SUMMARY_FIXES -->` 标记
 *
 * 用法：
 *   npx tsx scripts/cleanup-context-history.ts --report   # 只报告，不改文件
 *   npx tsx scripts/cleanup-context-history.ts --write    # 执行清理（跑完 git diff 人审再提交）
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HASH_ENTRY = /^- ✅ `[0-9a-f]{7,10}`:.*$/;
const STALE_MARKER = /^<!-- STALE_SINCE.*-->$/;
const STALE_WARN = /^⚠️ 以下文件已变更.*$/;
const FIX_SECTION = /^## 修复历史\s*$/;
const HEADING = /^## /;
const SESSION_MARKER = '<!-- SESSION_SUMMARY_FIXES -->';

const mode = process.argv[2];
if (mode !== '--report' && mode !== '--write') {
  console.error('Usage: npx tsx scripts/cleanup-context-history.ts --report|--write');
  process.exit(1);
}

function findContextFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'CONTEXT.md') out.push(p);
    }
  };
  walk(root);
  return out;
}

interface Report {
  file: string;
  staleLines: number;
  hashEntries: number;
  distilled: string[];
  hasFixSection: boolean;
  changed: boolean;
}

function cleanContent(content: string): { cleaned: string; report: Omit<Report, 'file'> } {
  const lines = content.split('\n');
  const out: string[] = [];
  const rep = { staleLines: 0, hashEntries: 0, distilled: [] as string[], hasFixSection: false, changed: false };

  let inFixSection = false;
  for (const line of lines) {
    if (FIX_SECTION.test(line)) {
      inFixSection = true;
      rep.hasFixSection = true;
      rep.changed = true;
      continue; // 整节删除：标题本身不输出
    }
    if (inFixSection) {
      if (HEADING.test(line)) {
        inFixSection = false; // 遇到下一节，本行正常输出
      } else {
        if (line.trim() === SESSION_MARKER) { rep.changed = true; continue; }
        if (HASH_ENTRY.test(line.trim())) { rep.hashEntries++; rep.changed = true; continue; }
        if (/^- /.test(line.trim())) { rep.distilled.push(line.trim()); rep.changed = true; continue; }
        if (line.trim() === '') continue; // 节内空行一并吞掉
        // 其他内容（散文）：随节删除
        rep.changed = true;
        continue;
      }
    }
    if (STALE_MARKER.test(line.trim())) { rep.staleLines++; rep.changed = true; continue; }
    if (STALE_WARN.test(line.trim())) { rep.staleLines++; rep.changed = true; continue; }
    // 不在修复历史节内的 SESSION_SUMMARY_FIXES 标记（个别文件只有标记无节标题）
    if (line.trim() === SESSION_MARKER) { rep.changed = true; continue; }
    if (!inFixSection && HASH_ENTRY.test(line.trim())) { rep.hashEntries++; rep.changed = true; continue; }
    out.push(line);
  }

  let cleaned = out.join('\n');
  // 清掉因删节产生的 3+ 连续空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return { cleaned, report: rep };
}

const files = [...findContextFiles(path.join(REPO_ROOT, 'apps')), ...findContextFiles(path.join(REPO_ROOT, 'packages'))];
const reports: Report[] = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf-8');
  const { cleaned, report } = cleanContent(content);
  const rel = path.relative(REPO_ROOT, file);
  reports.push({ file: rel, ...report });
  if (mode === '--write' && report.changed) {
    fs.writeFileSync(file, cleaned, 'utf-8');
  }
}

// ── 汇总 ──
const touched = reports.filter(r => r.changed);
const totalStale = reports.reduce((s, r) => s + r.staleLines, 0);
const totalHash = reports.reduce((s, r) => s + r.hashEntries, 0);
const totalDistilled = reports.reduce((s, r) => s + r.distilled.length, 0);

console.log(`[cleanup-context-history] ${mode}`);
console.log(`Scanned: ${files.length} CONTEXT.md, touched: ${touched.length}`);
console.log(`STALE 标记/警告行: ${totalStale} | hash 机器条目: ${totalHash} | 蒸馏条目: ${totalDistilled}`);

if (mode === '--report') {
  for (const r of reports.filter(x => x.distilled.length > 0)) {
    console.log(`\n── ${r.file} ──`);
    for (const d of r.distilled) console.log(`  ${d}`);
  }
} else {
  for (const r of touched) {
    console.log(`  ✓ ${r.file} (stale=${r.staleLines} hash=${r.hashEntries} distilled=${r.distilled.length})`);
  }
}
