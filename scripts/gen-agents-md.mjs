#!/usr/bin/env node
/**
 * gen-agents-md.mjs — 生成/更新根 AGENTS.md 的「模块索引」自动区段
 *
 * 聚合范围（存在的 CONTEXT.md 才提取说明，目录本身全部列出）：
 *   - apps/api/src/modules/<name>/CONTEXT.md
 *   - packages/<name>/CONTEXT.md（缺省时回退 packages/<name>/src/CONTEXT.md）
 *
 * 只替换 AGENTS.md 中 <!-- AUTO-GENERATED:modules --> 与
 * <!-- /AUTO-GENERATED:modules --> 标记之间的内容；标记外内容不动。
 * 标记不存在时在文件末尾追加。
 *
 * 用法：node scripts/gen-agents-md.mjs   （或 pnpm gen:agents-md）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_MD = join(ROOT, 'AGENTS.md');
const BEGIN = '<!-- AUTO-GENERATED:modules -->';
const END = '<!-- /AUTO-GENERATED:modules -->';

/** 从 CONTEXT.md 提取一句话说明：优先「## 职责」节首行，回退到首个正文段落 */
function extractSummary(contextPath) {
  let content;
  try {
    content = readFileSync(contextPath, 'utf-8');
  } catch {
    return null; // 文件不存在
  }
  const pickLine = text =>
    text
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0 && !l.startsWith('>') && !l.startsWith('#') && !l.startsWith('- ') && !l.startsWith('|') && !l.startsWith('<!--'));
  const m = content.match(/##\s*职责\s*\n([\s\S]*?)(?=\n##\s|$)/);
  // 回退：标题后的首个正文段落（允许引用块，去掉 `>` 前缀）
  const fallback = content
    .replace(/^#[^\n]*\n/, '')
    .split('\n')
    .map(l => l.replace(/^>\s?/, ''))
    .join('\n');
  const line = (m && pickLine(m[1])) || pickLine(fallback);
  if (!line) return '（见 CONTEXT.md）';
  // 表格安全：去掉反引号与竖线，截断
  const clean = line.replace(/[`|]/g, '').trim();
  return clean.length > 120 ? clean.slice(0, 117).trimEnd() + '...' : clean;
}

/** 收集条目：{ dir, summary } */
function collect() {
  const entries = [];

  const modulesDir = join(ROOT, 'apps/api/src/modules');
  for (const name of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.') || name.name.startsWith('__')) continue;
    const dir = `apps/api/src/modules/${name.name}`;
    entries.push({ dir, summary: extractSummary(join(ROOT, dir, 'CONTEXT.md')) });
  }

  const packagesDir = join(ROOT, 'packages');
  for (const name of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.') || name.name.startsWith('__')) continue;
    const dir = `packages/${name.name}`;
    const rootContext = join(ROOT, dir, 'CONTEXT.md');
    const srcContext = join(ROOT, dir, 'src', 'CONTEXT.md');
    const contextPath = existsSync(rootContext) ? rootContext : srcContext;
    entries.push({ dir, summary: extractSummary(contextPath) });
  }

  return entries.sort((a, b) => a.dir.localeCompare(b.dir));
}

function buildSection(entries) {
  const rows = entries.map(
    e => `| \`${e.dir}\` | ${e.summary ?? '（缺少 CONTEXT.md，请补充）'} |`,
  );
  return `${BEGIN}
## 模块索引

> 本区段由 \`pnpm gen:agents-md\`（scripts/gen-agents-md.mjs）生成，请勿手改；
> 新增/变更模块后重跑该命令。AGENTS.md 全文（含 harness 生成的导读部分）用 \`pnpm agents-md:sync\` 重建，勿手改本文件。

| 目录 | 说明 |
|------|------|
${rows.join('\n')}
${END}`;
}

const entries = collect();
const section = buildSection(entries);

let original = '';
try {
  original = readFileSync(AGENTS_MD, 'utf-8');
} catch {
  // AGENTS.md 不存在时创建骨架
  original = '# AGENTS.md\n';
}

let next;
const beginIdx = original.indexOf(BEGIN);
const endIdx = original.indexOf(END);
if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
  next = original.slice(0, beginIdx) + section + original.slice(endIdx + END.length);
} else {
  next = original.replace(/\s*$/, '') + '\n\n' + section + '\n';
}

if (next === original) {
  console.log('AGENTS.md 模块索引已是最新（无变化）');
} else {
  writeFileSync(AGENTS_MD, next);
  console.log(`AGENTS.md 模块索引已更新：${entries.length} 个目录`);
}
