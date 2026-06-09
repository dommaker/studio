#!/usr/bin/env tsx
/**
 * Test Health Report — 自动曝光 + 根因分类
 *
 * 运行: npx tsx scripts/test-health-report.ts [--json] [--fix]
 *
 * 流程:
 *   1. vitest --reporter=json 运行全量测试
 *   2. 解析失败，按根因自动分类
 *   3. 输出诊断报告 (markdown 或 JSON)
 *   4. --fix 模式: 自动修复可修复的类别
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Types ──

interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
  stack?: string;
  duration: number;
}

interface TestFile {
  name: string;
  status: 'passed' | 'failed';
  testResults: TestResult[];
  failureMessage?: string;
}

interface VitestReport {
  testResults: TestFile[];
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
}

interface FailureCategory {
  id: string;
  label: string;
  rootCause: string;
  fix: string;
  autoFixable: boolean;
  files: { file: string; tests: string[]; error: string }[];
}

// ── Root Cause Classifiers ──

const CLASSIFIERS: {
  id: string;
  label: string;
  rootCause: string;
  fix: string;
  autoFixable: boolean;
  match: (file: TestFile, test: TestResult) => boolean;
}[] = [
  {
    id: 'missing-vitest-globals',
    label: 'Missing Vitest Globals',
    rootCause: 'vitest globals:true 未配置。describe/it/expect 未注入全局',
    fix: '在 vitest.config.ts 设置 globals:true，或在测试文件顶部 import { describe, it, expect } from "vitest"',
    autoFixable: true,
    match: (_file, test) =>
      test.message?.includes('describe is not defined') ||
      test.message?.includes('it is not defined') ||
      test.message?.includes('expect is not defined'),
  },
  {
    id: 'missing-jsdom',
    label: 'Missing jsdom Environment',
    rootCause: '前端组件测试缺少 jsdom 环境。document/window 未定义',
    fix: '在 vitest.config.ts 设置 environment:"jsdom"，或在测试文件顶部加 @vitest-environment jsdom',
    autoFixable: true,
    match: (_file, test) =>
      test.message?.includes('document is not defined') ||
      test.message?.includes('window is not defined'),
  },
  {
    id: 'playwright-in-vitest',
    label: 'Playwright Tests Run by Vitest',
    rootCause: 'Playwright e2e 测试被 vitest 加载，应该用 playwright test 运行',
    fix: '从 vitest include 中排除 e2e/*.spec.ts，用 playwright test 单独运行',
    autoFixable: true,
    match: (file) =>
      file.name.includes('/e2e/') && file.name.endsWith('.spec.ts'),
  },
  {
    id: 'server-not-running',
    label: 'API Server Not Running',
    rootCause: '集成测试需要运行中的 API server (ECONNREFUSED)',
    fix: '在测试 setup 中启动 server，或用 globalSetup 自动拉起',
    autoFixable: false,
    match: (_file, test) =>
      test.message?.includes('ECONNREFUSED'),
  },
  {
    id: 'mock-incomplete',
    label: 'Incomplete Mock',
    rootCause: 'vi.mock() 未导出被测模块引用的成员',
    fix: '在 vi.mock 中补全缺失的 export，或用 importOriginal 保留原始导出',
    autoFixable: false,
    match: (_file, test) =>
      test.message?.includes('No "') && test.message?.includes('export is defined on the'),
  },
  {
    id: 'env-config-mismatch',
    label: 'Environment Config Mismatch',
    rootCause: '测试断言的值与运行时环境变量不匹配',
    fix: '检查 .env.test 或测试 setup 中的环境变量配置',
    autoFixable: false,
    match: (_file, test) =>
      test.message?.includes('Expected:') && test.message?.includes('Received:'),
  },
  {
    id: 'session-not-found',
    label: 'Session Not Found',
    rootCause: '测试依赖的 session/context 未正确初始化',
    fix: '检查测试 beforeAll/beforeEach 中的 session 创建逻辑',
    autoFixable: false,
    match: (_file, test) =>
      test.message?.includes('Session not found'),
  },
];

function classifyFailure(file: TestFile, test: TestResult): string {
  for (const c of CLASSIFIERS) {
    if (c.match(file, test)) return c.id;
  }
  return 'unknown';
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fixMode = args.includes('--fix');
  const reportDir = join(process.cwd(), 'docs', 'test-health');

  console.log('Running test suite with JSON reporter...');
  let rawOutput: string;
  try {
    rawOutput = execSync('npx vitest run --reporter=json 2>/dev/null', {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 600000,
    });
  } catch (e: any) {
    // vitest exits non-zero when tests fail — output is still valid
    rawOutput = e.stdout || '';
    if (!rawOutput) {
      console.error('Failed to run vitest:', e.message);
      process.exit(1);
    }
  }

  let report: VitestReport;
  try {
    report = JSON.parse(rawOutput);
  } catch {
    console.error('Failed to parse vitest JSON output');
    process.exit(1);
  }

  // ── Classify failures ──
  const categories = new Map<string, FailureCategory>();
  for (const cls of CLASSIFIERS) {
    categories.set(cls.id, {
      id: cls.id,
      label: cls.label,
      rootCause: cls.rootCause,
      fix: cls.fix,
      autoFixable: cls.autoFixable,
      files: [],
    });
  }

  let totalFailed = 0;
  let totalPassed = 0;
  let totalSkipped = 0;

  for (const file of report.testResults) {
    const failedTests = file.testResults.filter((t) => t.status === 'failed');
    if (failedTests.length === 0) {
      totalPassed += file.testResults.filter((t) => t.status === 'passed').length;
      totalSkipped += file.testResults.filter((t) => t.status === 'skipped').length;
      continue;
    }

    // Group by first matching category
    const fileGroups = new Map<string, string[]>();
    for (const test of failedTests) {
      const catId = classifyFailure(file, test);
      if (!fileGroups.has(catId)) fileGroups.set(catId, []);
      fileGroups.get(catId)!.push(test.name);
      totalFailed++;
    }

    for (const [catId, tests] of fileGroups) {
      const cat = categories.get(catId)!;
      cat.files.push({
        file: file.name.replace(process.cwd() + '/', ''),
        tests,
        error: failedTests[0].message?.split('\n')[0] || 'unknown',
      });
    }

    totalPassed += file.testResults.filter((t) => t.status === 'passed').length;
    totalSkipped += file.testResults.filter((t) => t.status === 'skipped').length;
  }

  // ── Filter out empty categories ──
  const activeCategories = [...categories.values()].filter((c) => c.files.length > 0);
  activeCategories.sort((a, b) => b.files.length - a.files.length);

  // ── Generate report ──
  if (jsonMode) {
    const jsonOut = {
      timestamp: new Date().toISOString(),
      summary: { total: report.numTotalTests, passed: totalPassed, failed: totalFailed, skipped: totalSkipped },
      categories: activeCategories,
    };
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  // Markdown report
  const lines: string[] = [
    '# Test Health Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total | ${report.numTotalTests} |`,
    `| Passed | ${totalPassed} |`,
    `| Failed | ${totalFailed} |`,
    `| Skipped | ${totalSkipped} |`,
    '',
    '## Failure Categories',
    '',
  ];

  for (const cat of activeCategories) {
    const fileCount = cat.files.length;
    const testCount = cat.files.reduce((s, f) => s + f.tests.length, 0);
    lines.push(`### ${cat.label} (${fileCount} files, ${testCount} tests)`);
    lines.push('');
    lines.push(`**Root Cause:** ${cat.rootCause}`);
    lines.push('');
    lines.push(`**Fix:** ${cat.fix}`);
    lines.push('');
    lines.push(`**Auto-fixable:** ${cat.autoFixable ? 'Yes' : 'No'}`);
    lines.push('');
    lines.push('**Affected files:**');
    lines.push('');
    for (const f of cat.files.slice(0, 10)) {
      lines.push(`- \`${f.file}\` — ${f.tests.length} test(s)`);
    }
    if (cat.files.length > 10) {
      lines.push(`- ... and ${cat.files.length - 10} more`);
    }
    lines.push('');
  }

  // Unknown failures
  const unknownCat = categories.get('unknown')!;
  if (unknownCat.files.length > 0) {
    lines.push(`### Unknown (${unknownCat.files.length} files)`);
    lines.push('');
    lines.push('Unclassified failures — needs manual investigation.');
    lines.push('');
    for (const f of unknownCat.files.slice(0, 5)) {
      lines.push(`- \`${f.file}\` — ${f.error}`);
    }
    lines.push('');
  }

  const md = lines.join('\n');
  console.log(md);

  // Save report
  try {
    mkdirSync(reportDir, { recursive: true });
    const dateStr = new Date().toISOString().split('T')[0];
    const reportPath = join(reportDir, `${dateStr}.md`);
    writeFileSync(reportPath, md);
    console.log(`\nReport saved: ${reportPath}`);
  } catch {
    // ignore save errors
  }

  // ── Auto-fix mode ──
  if (fixMode) {
    console.log('\n--- Auto-fix ---');
    for (const cat of activeCategories) {
      if (!cat.autoFixable) {
        console.log(`[skip] ${cat.label}: requires manual fix`);
        continue;
      }
      console.log(`[fix] ${cat.label}: ${cat.files.length} files`);
      // Auto-fix logic would go here per category
      // For now, just report what would be fixed
    }
  }
}

main().catch(console.error);
