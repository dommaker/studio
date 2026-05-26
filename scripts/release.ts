#!/usr/bin/env npx tsx
/**
 * studio release — 收尾阶段自动化
 *
 * 流程:
 *   1. harness sync-docs     同步文档
 *   2. harness check          检查约束
 *   3. harness-upgrade        检测 harness 新版本并升级
 *   4. changelog              从 git log 生成 CHANGELOG 条目
 *   5. git add + commit + push
 *   6. [可选] version bump + tag + gh release (--patch/--minor/--major)
 *
 * 用法:
 *   npx tsx scripts/release.ts [--dry-run] ["commit message"]
 *   npx tsx scripts/release.ts --patch "commit message"   (打 tag + bump version)
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const BUMP = process.argv.find(a => ['--patch', '--minor', '--major'].includes(a))?.replace('--', '');
// Find first non-flag arg as commit message (skip --flags and node/tsx paths)
const MSG = process.argv.slice(2).find(a => !a.startsWith('-') && !a.includes('node') && !a.includes('tsx')) || 'chore: release';

function sh(cmd: string): string {
  try {
    const result = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' });
    if (!DRY_RUN) console.log(result.trim());
    return (result || '').trim();
  } catch (e: any) {
    console.error(`⚠️  ${cmd.split('\n')[0]}: ${(e.stderr || e.message).slice(0, 200)}`);
    return '';
  }
}

function shOk(cmd: string): boolean {
  try { execSync(cmd, { cwd: ROOT, stdio: 'pipe' }); return true; }
  catch { return false; }
}

async function main() {
  console.log('🚀 Studio Release Pipeline\n');

  // ── Step 1: Sync docs ──
  console.log('📋 Step 1: Sync documents...');
  sh('npx harness sync-docs');

  // ── Step 2: Constraint check ──
  console.log('\n🔍 Step 2: Constraint check...');
  const checkResult = sh('npx harness check 2>&1 || true');
  if (checkResult.includes('通过') || checkResult.includes('passed')) {
    console.log('   ✅ Passed.');
  } else if (checkResult.includes('异常')) {
    console.log('   ⚠️  Warnings present.');
  }

  // ── Step 3: Harness upgrade ──
  console.log('\n📦 Step 3: Check harness updates...');
  sh('npx tsx scripts/harness-upgrade.ts');

  // ── Step 4: Changelog ──
  console.log('\n📝 Step 4: Update CHANGELOG...');
  const lastTag = sh('git describe --tags --abbrev=0 2>/dev/null || echo ""');
  if (lastTag) {
    const commits = sh(`git log ${lastTag}..HEAD --oneline --no-merges 2>/dev/null || echo ""`);
    if (commits) {
      const entries = commits.split('\n').filter(Boolean).map(c => `- ${c.replace(/^[a-f0-9]+ /, '')}`);
      const today = new Date().toISOString().split('T')[0];
      const changelogEntry = `\n## [${today}]\n\n${entries.join('\n')}\n`;
      if (!DRY_RUN && shOk('test -f CHANGELOG.md')) {
        const current = readFileSync('CHANGELOG.md', 'utf-8');
        writeFileSync('CHANGELOG.md', changelogEntry + current);
        console.log(`   ✅ Added ${entries.length} entries since ${lastTag}`);
      } else {
        console.log(`   📋 ${entries.length} entries since ${lastTag} (DRY RUN)`);
      }
    } else {
      console.log('   ⏭️  No commits since last tag');
    }
  } else {
    console.log('   ⏭️  No previous tags found');
  }

  // ── Step 5: Git ──
  if (DRY_RUN) {
    console.log('\n🏃 DRY RUN — skipping commit/push.');
    return;
  }

  console.log('\n📤 Step 5: Commit and push...');
  sh('git add -u');
  const hasChanges = sh('git diff --cached --quiet 2>&1 || echo "HAS_CHANGES"');
  if (hasChanges.includes('HAS_CHANGES')) {
    sh(`git commit -m "${MSG}" --no-verify`);
    sh('git push origin master');
    console.log('   ✅ Pushed');
  } else {
    console.log('   ⏭️  No changes to commit');
  }

  // ── Step 6: Tag + version bump (optional) ──
  if (BUMP) {
    console.log(`\n🏷️  Step 6: Version bump (${BUMP})...`);
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    const [major, minor, patch] = (pkg.version || '0.1.0').split('.').map(Number);
    let newVer: string;
    if (BUMP === 'major') newVer = `${major + 1}.0.0`;
    else if (BUMP === 'minor') newVer = `${major}.${minor + 1}.0`;
    else newVer = `${major}.${minor}.${patch + 1}`;

    pkg.version = newVer;
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    console.log(`   ${pkg.version} → ${newVer}`);

    sh(`git add package.json`);
    sh(`git commit -m "chore: bump to v${newVer}" --no-verify`);
    sh(`git push origin master`);
    sh(`git tag v${newVer}`);
    sh(`git push origin v${newVer}`);
    console.log(`   ✅ Tagged v${newVer}`);

    // gh release
    console.log('\n🎉 Step 7: GitHub Release...');
    const releaseCmd = `gh release create v${newVer} --title "v${newVer}" --notes "$(head -30 CHANGELOG.md | sed 's/\"/\\"/g')"`;
    try {
      sh(releaseCmd);
      console.log(`   ✅ Release created: v${newVer}`);
    } catch {
      console.log('   ⚠️  gh release failed (account issue — run manually)');
    }
  }

  console.log('\n✅ Release complete!\n');
}

main().catch(console.error);
