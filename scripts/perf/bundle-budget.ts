/**
 * bundle 预算门 CLI（#674）：测量 apps/web/dist 产物 → 对比 bundle-budget.json 预算，
 * 超预算 exit 1（CI 红）。stdout 恒输出 markdown 报告。
 * 前置：先跑 pnpm build（dist 不存在即报错退出，不自动构建——CI 里 build 步骤在前）。
 *
 * 用法：pnpm perf:bundle  [--config scripts/perf/bundle-budget.json]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBudget,
  measureDist,
  renderBundleReport,
  type BundleBudget,
} from './lib/bundle-budget.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function parseArgs(argv: string[]): { config: string } {
  let config = join(repoRoot, 'scripts', 'perf', 'bundle-budget.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) config = argv[++i];
  }
  return { config };
}

/** distDir 可注入（测试喂临时 fixture；CLI 缺省 apps/web/dist） */
export function run(argv: string[] = process.argv.slice(2), distDir = join(repoRoot, 'apps', 'web', 'dist')): number {
  const { config } = parseArgs(argv);
  if (!existsSync(join(distDir, 'assets'))) {
    console.error(`❌ ${distDir} 不存在——先跑 pnpm build（或 pnpm build:web）再跑预算门。`);
    return 2;
  }
  const parsed = JSON.parse(readFileSync(config, 'utf8')) as { budget: BundleBudget };
  const measurement = measureDist(distDir);
  const violations = checkBudget(measurement, parsed.budget);
  console.log(renderBundleReport(measurement, parsed.budget, violations));
  if (violations.length > 0) {
    console.error(`\n❌ bundle 超预算 ${violations.length} 项——要么瘦身，要么调 scripts/perf/bundle-budget.json（commit message 说明理由）。`);
    return 1;
  }
  return 0;
}

// 直接执行（非 import）时跑 CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run());
}
