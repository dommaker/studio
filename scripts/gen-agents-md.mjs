#!/usr/bin/env node
/**
 * gen-agents-md.mjs — 生成/更新根 AGENTS.md 的「模块索引」自动区段
 *
 * 摘要来源：各目录散置的 `CONTEXT.md`（H1 = 目录路径，### 小节含「职责」）。
 * #152 曾归并为 `.studio/CONTEXT.md` 单文件，实践暴露 1770 行膨胀、读写成本高，
 * 现撤销回归散置模型（#299）。
 *
 * 聚合范围（CONTEXT.md 存在才提取说明，目录本身全部列出）：
 *   - apps/api/src/modules/<name>/CONTEXT.md
 *   - packages/<name>/CONTEXT.md（缺省时回退 packages/<name>/src/CONTEXT.md）
 *
 * 只替换 AGENTS.md 中 <!-- AUTO-GENERATED:modules --> 与
 * <!-- /AUTO-GENERATED:modules --> 标记之间的内容；标记外内容不动。
 * 标记不存在时在文件末尾追加。
 *
 * 整个区段外层套 <!-- PRESERVE:modules -->：harness sync-docs --agents 的
 * 漂移比对（existing !== 生成内容+PRESERVE 块）不认识本区段，不套会被
 * --check 永远判 stale；套入后 harness 原样穿过，本脚本仍按 AUTO 标记原地更新。
 *
 * 用法：node scripts/gen-agents-md.mjs   （或 pnpm gen:agents-md）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_MD = join(ROOT, 'AGENTS.md');
const BEGIN = '<!-- AUTO-GENERATED:modules -->';
const END = '<!-- /AUTO-GENERATED:modules -->';

/**
 * 把带 `## <路径>` 锚点的文档解析为锚点表：Map<锚点路径, 锚点正文>。
 * 锚点 = 二级标题 `## <路径>`；正文到下一个二级标题（或文件尾）为止。
 * 供 split-context-md.mjs 一次性拆分 `.studio/CONTEXT.md` 使用。
 */
export function parseAnchors(content) {
  const anchors = new Map();
  const re = /^## (\S+)\s*$/gm;
  let m;
  const heads = [];
  while ((m = re.exec(content)) !== null) heads.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : content.length;
    anchors.set(heads[i].name, content.slice(heads[i].bodyStart, end));
  }
  return anchors;
}

/** 从锚点正文提取一句话说明：优先「职责」节（任意标题级）首行，回退到首个正文段落 */
export function extractSummary(section) {
  if (section == null) return null; // 锚点不存在
  const pickLine = text =>
    text
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0 && !l.startsWith('>') && !l.startsWith('#') && !l.startsWith('- ') && !l.startsWith('|') && !l.startsWith('<!--'));
  const m = section.match(/^#{2,}\s*职责\s*\n([\s\S]*?)(?=\n#{2,}\s|$)/m);
  // 回退：去掉引用块前缀后的首个正文段落
  const fallback = section
    .split('\n')
    .map(l => l.replace(/^>\s?/, ''))
    .join('\n');
  const line = (m && pickLine(m[1])) || pickLine(fallback);
  if (!line) return '（锚点为空）';
  // 表格安全：去掉反引号与竖线，截断
  const clean = line.replace(/[`|]/g, '').trim();
  return clean.length > 120 ? clean.slice(0, 117).trimEnd() + '...' : clean;
}

/** 读目录下的 CONTEXT.md 全文，不存在返回 null */
function readContext(relDir) {
  const file = join(ROOT, relDir, 'CONTEXT.md');
  return existsSync(file) ? readFileSync(file, 'utf-8') : null;
}

/** 收集条目：{ dir, summary } */
function collect() {
  const entries = [];

  const modulesDir = join(ROOT, 'apps/api/src/modules');
  for (const name of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.') || name.name.startsWith('__')) continue;
    const dir = `apps/api/src/modules/${name.name}`;
    entries.push({ dir, summary: extractSummary(readContext(dir)) });
  }

  const packagesDir = join(ROOT, 'packages');
  for (const name of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.') || name.name.startsWith('__')) continue;
    const dir = `packages/${name.name}`;
    const section = readContext(dir) ?? readContext(`${dir}/src`);
    entries.push({ dir, summary: extractSummary(section) });
  }

  return entries.sort((a, b) => a.dir.localeCompare(b.dir));
}

function buildSection(entries) {
  const rows = entries.map(
    e => `| \`${e.dir}\` | ${e.summary ?? '（无 CONTEXT.md，请补充）'} |`,
  );
  return `${BEGIN}
## 模块索引

> 本区段由 \`pnpm gen:agents-md\`（scripts/gen-agents-md.mjs）生成，请勿手改；
> 摘要取自各目录 CONTEXT.md 的「职责」节；新增/变更模块后补 CONTEXT.md 并重跑该命令。
> AGENTS.md 全文（含 harness 生成的导读部分）用 \`pnpm agents-md:sync\` 重建，勿手改本文件。

| 目录 | 说明 |
|------|------|
${rows.join('\n')}
${END}`;
}

function main() {
  const entries = collect();
  const section = buildSection(entries);

  // PRESERVE 包裹版：harness 漂移比对对包裹内容免疫（见文件头注释）
  const WRAP_BEGIN = '<!-- PRESERVE:modules -->';
  const WRAP_END = '<!-- /PRESERVE:modules -->';
  const wrapped = `${WRAP_BEGIN}\n${section}\n${WRAP_END}`;

  let original = '';
  try {
    original = readFileSync(AGENTS_MD, 'utf-8');
  } catch {
    // AGENTS.md 不存在时创建骨架
    original = '# AGENTS.md\n';
  }

  let next;
  const wrapBeginIdx = original.indexOf(WRAP_BEGIN);
  const wrapEndIdx = original.indexOf(WRAP_END);
  const beginIdx = original.indexOf(BEGIN);
  const endIdx = original.indexOf(END);
  if (wrapBeginIdx !== -1 && wrapEndIdx !== -1 && wrapEndIdx > wrapBeginIdx) {
    // 已包裹：整体替换 PRESERVE 块
    next = original.slice(0, wrapBeginIdx) + wrapped + original.slice(wrapEndIdx + WRAP_END.length);
  } else if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // 迁移：裸 AUTO 段 → 替换为 PRESERVE 包裹版
    next = original.slice(0, beginIdx) + wrapped + original.slice(endIdx + END.length);
  } else {
    next = original.replace(/\s*$/, '') + '\n\n' + wrapped + '\n';
  }

  if (next === original) {
    console.log('AGENTS.md 模块索引已是最新（无变化）');
  } else {
    writeFileSync(AGENTS_MD, next);
    console.log(`AGENTS.md 模块索引已更新：${entries.length} 个目录`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
