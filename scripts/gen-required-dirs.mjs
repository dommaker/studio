#!/usr/bin/env node
/**
 * gen-required-dirs.mjs — .harness/config.yml required_dirs 自动发现（#694）
 *
 * harness 3.0.0 的 governance.context_files.required_dirs 只认字面路径
 * （glob 按字面处理，实测 2026-10-11），手维护清单已腐化（缺 agent-* 模块）。
 * 本脚本按固定规则扫描源码根，重写 config.yml 中
 * `# AUTO-GENERATED:required_dirs` 标记段；--check 只校验不写（CI 漂移门）。
 *
 * 发现规则（顺序固定，与 sync-docs 模块面 / context_doc_sync 覆盖面一致）：
 *   1. packages/<name>/src（src 存在的包）
 *   2. apps/api/src/bootstrap
 *   3. apps/api/src/modules/<name>（全部模块目录，跳过 . / __ 前缀）
 *
 * 不列 apps/web/src：web 的 CONTEXT.md 自 #693 起住 apps/web/docs/，harness
 * 只认 <dir>/CONTEXT.md，列旧路径会逼 sync-docs 在 src 下重建模板替身（与 #693
 * 决策冲突），且写读两次计数震荡导致 CI Governance 门不稳定（2026-10-12 实测）。
 *
 * 用法：node scripts/gen-required-dirs.mjs [--check]   （或 pnpm gen:required-dirs）
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, '.harness/config.yml');
const BEGIN = '# AUTO-GENERATED:required_dirs';
const END = '# /AUTO-GENERATED:required_dirs';

function listSubdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('__'))
    .map(d => d.name)
    .sort();
}

/** 按固定规则扫描源码根，返回 required_dirs 清单（结构序：packages → bootstrap → modules → web） */
export function collectRequiredDirs(root = ROOT) {
  const dirs = [];
  for (const name of listSubdirs(join(root, 'packages'))) {
    const src = `packages/${name}/src`;
    if (existsSync(join(root, src))) dirs.push(src);
  }
  if (existsSync(join(root, 'apps/api/src/bootstrap'))) dirs.push('apps/api/src/bootstrap');
  for (const name of listSubdirs(join(root, 'apps/api/src/modules'))) {
    dirs.push(`apps/api/src/modules/${name}`);
  }
  return dirs;
}

/** 重写 config.yml 的 AUTO-GENERATED:required_dirs 标记段；缺标记抛错 */
export function applyGenerated(content, dirs) {
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error(`config.yml 缺少 ${BEGIN} 标记段，无法自动改写`);
  }
  const beginEol = content.indexOf('\n', beginIdx);
  const endLineStart = content.lastIndexOf('\n', endIdx) + 1;
  const block = `    required_dirs:\n${dirs.map(d => `      - ${d}`).join('\n')}\n`;
  return content.slice(0, beginEol + 1) + block + content.slice(endLineStart);
}

function main() {
  const check = process.argv.includes('--check');
  const content = readFileSync(CONFIG, 'utf-8');
  const dirs = collectRequiredDirs(ROOT);
  const next = applyGenerated(content, dirs);

  if (next === content) {
    console.log(`required_dirs 已是最新（${dirs.length} 个目录）`);
    return;
  }
  if (check) {
    console.error('❌ .harness/config.yml 的 required_dirs 已腐化——运行 pnpm gen:required-dirs 重新生成');
    process.exit(1);
  }
  writeFileSync(CONFIG, next);
  console.log(`required_dirs 已更新：${dirs.length} 个目录`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
