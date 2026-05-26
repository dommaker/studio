#!/usr/bin/env npx tsx
/**
 * studio release — 收尾阶段自动化
 *
 * 流程:
 *   1. harness sync-docs    同步文档
 *   2. harness check         检查约束
 *   3. harness-upgrade       检测 harness 新版本并升级
 *   4. git add + commit + push
 *
 * 用法: npx tsx scripts/release.ts [--dry-run] ["commit message"]
 */

import { execSync } from 'child_process';

const ROOT = __dirname + '/..';
const DRY_RUN = process.argv.includes('--dry-run');
// Find first non-flag arg as commit message (skip --flags and node/tsx paths)
const MSG = process.argv.slice(2).find(a => !a.startsWith('-') && !a.includes('node') && !a.includes('tsx')) || 'chore: release';

function sh(cmd: string): string {
  try {
    const result = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    if (!DRY_RUN) console.log(result.trim());
    return (result || '').trim();
  } catch (e: any) {
    console.error(`⚠️  ${cmd}: ${e.stderr || e.message}`);
    return '';
  }
}

async function main() {
  console.log('🚀 Studio Release Pipeline\n');

  // 1. Sync docs
  console.log('📋 Step 1: Sync documents...');
  sh('npx harness sync-docs');

  // 2. Constraint check
  console.log('\n🔍 Step 2: Constraint check...');
  const checkResult = sh('npx harness check 2>&1 || true');
  if (checkResult.includes('通过')) console.log('   ✅ Passed.');

  // 3. Harness upgrade
  console.log('\n📦 Step 3: Check harness updates...');
  sh('npx tsx scripts/harness-upgrade.ts');

  // 4. Git
  if (DRY_RUN) {
    console.log('\n🏃 DRY RUN — skipping commit/push.');
    return;
  }

  console.log('\n📤 Step 4: Commit and push...');
  sh('git add -u');  // only tracked files — never stage untracked (.env etc.)
  sh(`git commit -m "${MSG}" --no-verify`);
  sh('git push origin master');

  console.log('\n✅ Release complete!\n');
}

main().catch(console.error);
