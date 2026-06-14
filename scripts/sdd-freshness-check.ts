#!/usr/bin/env tsx
/**
 * SP-004 Step 9: SDD Doc Freshness CLI
 *
 * post-commit hook 调用：检测变更文件，patch 关联 SDD 文档。
 *
 * 运行:
 *   npx tsx scripts/sdd-freshness-check.ts          # 分析 + patch
 *   npx tsx scripts/sdd-freshness-check.ts --dry-run # 只分析，不 patch
 */

import { execSync } from 'child_process';

// Dynamic import to avoid loading sdd-utils before env is set
async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');

  // Get changed files from last commit
  let changedFiles: string[];
  let gitDiff: string;
  try {
    changedFiles = execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    gitDiff = execSync('git diff HEAD~1 HEAD', { encoding: 'utf-8' });
  } catch {
    console.log('[sdd-freshness] No previous commit found, skipping');
    return;
  }

  if (changedFiles.length === 0) {
    console.log('[sdd-freshness] No changed files, skipping');
    return;
  }

  console.log(`[sdd-freshness] ${changedFiles.length} changed files`);

  // Dynamic import after env is loaded
  const { sddFreshnessService } = await import('../apps/api/src/modules/sdd/sdd-freshness.service.js');

  // Analyze
  const plans = await sddFreshnessService.analyzeChanges(changedFiles, gitDiff);

  if (plans.length === 0) {
    console.log('[sdd-freshness] No SDD docs affected (all L1 or no match)');
    return;
  }

  console.log(`[sdd-freshness] ${plans.length} SDD docs affected:`);
  for (const plan of plans) {
    console.log(`  ${plan.slug}: ${plan.level} (${plan.matchedFiles.join(', ')})`);
  }

  if (DRY_RUN) {
    console.log('[sdd-freshness] Dry-run mode, skipping patches');
    return;
  }

  // Apply patches
  await sddFreshnessService.applyPatches(plans, gitDiff);
  console.log('[sdd-freshness] Patches applied');
}

main().catch((e) => {
  console.error('[sdd-freshness] Failed:', e);
  process.exit(1);
});
