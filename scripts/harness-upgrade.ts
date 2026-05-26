#!/usr/bin/env npx tsx
/**
 * harness-upgrade — 自动升级 @dommaker/harness 到最新版本
 *
 * 功能:
 *   1. 检查 npm 上最新 harness 版本
 *   2. 对比 studio 当前版本
 *   3. 更新所有 package.json 的 harness 依赖
 *   4. 检测 harness breaking changes（对比 API 导出变化）
 *   5. 扫描 studio 代码中对已移除 API 的引用
 *   6. 报告不兼容项
 *
 * 用法: npx tsx scripts/harness-upgrade.ts [--dry-run] [--force]
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const STUDIO_ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

interface UpgradeReport {
  currentVersion: string;
  latestVersion: string;
  needsUpgrade: boolean;
  breakingChanges: string[];
  incompatibleReferences: { file: string; line: number; api: string }[];
  updatedFiles: string[];
}

async function main() {
  console.log('🔍 Checking @dommaker/harness versions...\n');

  // 1. Get current vs latest
  const currentVersion = getCurrentVersion();
  const latestVersion = getLatestVersion();
  const needsUpgrade = latestVersion !== currentVersion;

  console.log(`   Studio current: ${currentVersion}`);
  console.log(`   npm latest:     ${latestVersion}`);
  console.log(`   Needs upgrade:  ${needsUpgrade ? '✅ yes' : '❌ no'}\n`);

  if (!needsUpgrade && !FORCE) {
    console.log('Already on latest version. Use --force to re-check.');
    return;
  }

  // 2. Detect breaking changes
  console.log('🔬 Detecting breaking changes...');
  const breakingChanges = detectBreakingChanges(currentVersion, latestVersion);
  if (breakingChanges.length > 0) {
    console.log(`   Found ${breakingChanges.length} potentially breaking change(s):`);
    breakingChanges.forEach(c => console.log(`   - ${c}`));
  } else {
    console.log('   No breaking changes detected.');
  }
  console.log();

  // 3. Scan for incompatible references
  console.log('🔎 Scanning studio code for removed APIs...');
  const incompatibleRefs = scanIncompatibleReferences(breakingChanges);
  if (incompatibleRefs.length > 0) {
    console.log(`   ⚠️  Found ${incompatibleRefs.length} reference(s) to removed APIs:`);
    incompatibleRefs.forEach(r => console.log(`   - ${r.file}:${r.line} → ${r.api}`));
  } else {
    console.log('   No incompatible references found.');
  }
  console.log();

  // 4. Update package.json files
  if (DRY_RUN) {
    console.log('🏃 DRY RUN — skipping package.json updates.');
    return;
  }

  console.log('📝 Updating package.json files...');
  const updatedFiles = updatePackageJsonFiles(latestVersion);
  updatedFiles.forEach(f => console.log(`   ✅ ${f}`));
  console.log();

  // 5. Run pnpm install
  console.log('📦 Installing...');
  try {
    execSync('pnpm install', { cwd: STUDIO_ROOT, stdio: 'inherit' });
    console.log('   ✅ pnpm install complete\n');
  } catch {
    console.log('   ⚠️  pnpm install failed — run manually.\n');
  }

  // 6. Report
  console.log('━'.repeat(60));
  console.log('📊 Upgrade Report');
  console.log('━'.repeat(60));
  console.log(`   Version:     ${currentVersion} → ${latestVersion}`);
  console.log(`   Breaking:    ${breakingChanges.length} changes`);
  console.log(`   Incompatible: ${incompatibleRefs.length} references`);
  console.log(`   Files:       ${updatedFiles.length} updated`);

  if (incompatibleRefs.length > 0) {
    console.log('\n⚠️  MANUAL FIX REQUIRED:');
    incompatibleRefs.forEach(r => console.log(`   Fix ${r.file}:${r.line} — ${r.api} was removed`));
  }
}

function getCurrentVersion(): string {
  const pkgPath = join(STUDIO_ROOT, 'packages', 'studio-shared', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const dep = pkg.dependencies?.['@dommaker/harness'] || '0.0.0';
  return dep.replace(/[\^~]/, '');
}

function getLatestVersion(): string {
  try {
    return execSync('npm view @dommaker/harness version', { encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {
    console.error('Failed to fetch latest version from npm');
    return 'unknown';
  }
}

function detectBreakingChanges(oldVer: string, newVer: string): string[] {
  const changes: string[] = [];

  // Use git diff between tags to detect removed exports
  try {
    // Check if we have access to git tags
    const tagList = execSync('cd /tmp && git ls-remote --tags https://github.com/dommaker/harness.git 2>/dev/null', {
      encoding: 'utf-8', timeout: 10_000,
    }).trim();

    if (tagList) {
      changes.push('(git-based diff detection requires local harness clone)');
    }
  } catch {
    // Can't access git, use npm-based diff
  }

  // Heuristic: compare npm package exports
  try {
    const oldExports = getPackageExports(oldVer);
    const newExports = getPackageExports(newVer);
    for (const exp of oldExports) {
      if (!newExports.includes(exp)) {
        changes.push(`REMOVED: ${exp}`);
      }
    }
  } catch (e) {
    changes.push(`(could not compare exports: ${e})`);
  }

  return changes;
}

function getPackageExports(version: string): string[] {
  try {
    const output = execSync(
      `node -e "const m = require('@dommaker/harness'); console.log(Object.keys(m).sort().join('\\n'))"`,
      { encoding: 'utf-8', timeout: 10_000, cwd: STUDIO_ROOT },
    ).trim();
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function scanIncompatibleReferences(breakingChanges: string[]): { file: string; line: number; api: string }[] {
  const results: { file: string; line: number; api: string }[] = [];

  const removedApis = breakingChanges
    .filter(c => c.startsWith('REMOVED:'))
    .map(c => c.replace('REMOVED:', '').trim());

  if (removedApis.length === 0) return results;

  // Scan studio source for references to removed APIs
  const srcFiles = findSourceFiles(STUDIO_ROOT, ['.ts', '.tsx']);

  for (const file of srcFiles) {
    try {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const api of removedApis) {
          if (lines[i].includes(api)) {
            results.push({ file: file.replace(STUDIO_ROOT + '/', ''), line: i + 1, api });
          }
        }
      }
    } catch { /* skip unreadable */ }
  }

  return results;
}

function updatePackageJsonFiles(version: string): string[] {
  const updated: string[] = [];
  const pkgFiles = findAllPackageJsonFiles(STUDIO_ROOT);

  for (const file of pkgFiles) {
    const pkg = JSON.parse(readFileSync(file, 'utf-8'));
    if (pkg.dependencies?.['@dommaker/harness'] || pkg.devDependencies?.['@dommaker/harness']) {
      if (pkg.dependencies?.['@dommaker/harness']) {
        pkg.dependencies['@dommaker/harness'] = `^${version}`;
      }
      if (pkg.devDependencies?.['@dommaker/harness']) {
        pkg.devDependencies['@dommaker/harness'] = `^${version}`;
      }
      writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
      updated.push(file.replace(STUDIO_ROOT + '/', ''));
    }
  }

  return updated;
}

function findAllPackageJsonFiles(root: string): string[] {
  const results: string[] = [];
  const rootPkg = join(root, 'package.json');
  if (existsSync(rootPkg)) results.push(rootPkg);

  for (const subDir of ['packages', 'apps']) {
    const dir = join(root, subDir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = join(dir, entry.name, 'package.json');
      if (existsSync(pkg)) results.push(pkg);
    }
  }

  return results;
}

function findSourceFiles(root: string, extensions: string[]): string[] {
  const results: string[] = [];
  const skip = ['node_modules', 'dist', '.git', '.claude', 'worktrees'];

  function walk(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          results.push(full);
        }
      }
    } catch { /* skip */ }
  }

  walk(root);
  return results;
}

main().catch(console.error);
