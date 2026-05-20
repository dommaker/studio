#!/usr/bin/env npx tsx
/**
 * Harness Integration Coverage Report
 *
 * 扫描 hooks 定义 + 调用点，生成热力图矩阵。
 * 用法：pnpm harness:coverage
 */

import * as fs from 'fs';
import * as path from 'path';

const STUDIO_ROOT = path.resolve(__dirname, '../..');

// Hook 定义
const HOOKS_DIR = path.join(STUDIO_ROOT, 'packages/studio-shared/src/harness/hooks');

// 执行阶段
const PHASES = ['meeting', 'goal', 'agent', 'completion', 'pr'] as const;

// 各阶段应覆盖的 hook
const EXPECTED_HOOKS: Record<string, string[]> = {
  meeting:    ['afterMeetingDecision', 'afterRequirementsDoc'],
  goal:       ['beforeGoalCreate', 'beforeAgentDispatch'],
  agent:      ['beforeAgentExecute', 'buildAgentConstraintPrompt', 'afterAgentComplete'],
  completion: ['checkBeforeTaskComplete', 'afterReview'],
  pr:         ['afterPrCreated'],
};

interface HookDef {
  name: string;
  file: string;
  exported: boolean;
}

interface CallSite {
  hookName: string;
  file: string;
  line: number;
}

function findHookDefinitions(): HookDef[] {
  const defs: HookDef[] = [];
  if (!fs.existsSync(HOOKS_DIR)) return defs;

  for (const file of fs.readdirSync(HOOKS_DIR)) {
    if (!file.endsWith('.hooks.ts')) continue;
    const filePath = path.join(HOOKS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const exportRegex = /export\s+(async\s+)?function\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      defs.push({ name: match[2], file, exported: true });
    }
  }
  return defs;
}

function findCallSites(hookName: string): CallSite[] {
  const sites: CallSite[] = [];
  const searchDirs = [
    path.join(STUDIO_ROOT, 'apps'),
    path.join(STUDIO_ROOT, 'packages'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    scanDir(dir, hookName, sites);
  }
  return sites;
}

function scanDir(dir: string, hookName: string, sites: CallSite[]): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist') {
      scanDir(fullPath, hookName, sites);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const regex = new RegExp(`\\b${hookName}\\b`, 'g');
        let match;
        let lineNum = 0;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            sites.push({ hookName, file: path.relative(STUDIO_ROOT, fullPath), line: i + 1 });
          }
        }
      } catch { /* skip unreadable */ }
    }
  }
}

function main(): void {
  const defs = findHookDefinitions();
  const allHookNames = defs.map(d => d.name);

  console.log('=== Harness Integration Coverage Report ===\n');

  // Header
  const phaseWidth = 15;
  const hookWidth = 30;
  const header = ''.padEnd(hookWidth) + PHASES.map(p => p.padEnd(phaseWidth)).join('');
  console.log(header);
  console.log('─'.repeat(hookWidth + PHASES.length * phaseWidth));

  // Rows
  const gaps: string[] = [];
  for (const hookName of allHookNames) {
    const calls = findCallSites(hookName);
    const nonHookCalls = calls.filter(c => !c.file.includes('harness/hooks'));

    const row = hookName.padEnd(hookWidth);
    let rowData = '';
    for (const phase of PHASES) {
      const hookFile = `${phase}.hooks.ts`;
      const isInPhase = defs.some(d => d.name === hookName && d.file === hookFile);
      const called = nonHookCalls.length > 0;
      const symbol = isInPhase ? (called ? '✅' : '❌') : (called ? '⚠️' : '·');
      rowData += symbol.padEnd(phaseWidth);
    }
    console.log(row + rowData);

    if (!defs.some(d => d.name === hookName && d.file.includes('hooks'))) {
      gaps.push(`${hookName}: hook 未在任何 .hooks.ts 中定义`);
    }
    if (nonHookCalls.length === 0 && allHookNames.includes(hookName)) {
      gaps.push(`${hookName}: 已定义但未在任何调用点使用`);
    }
  }

  // Summary
  console.log('\n=== Gaps ===');
  if (gaps.length === 0) {
    console.log('✅ No gaps found.');
  } else {
    for (const gap of gaps) console.log(`  ❌ ${gap}`);
  }

  // Expected coverage
  console.log('\n=== Expected vs Actual ===');
  for (const phase of PHASES) {
    const expected = EXPECTED_HOOKS[phase] || [];
    const phaseDefs = defs.filter(d => d.file === `${phase}.hooks.ts`).map(d => d.name);
    const covered = expected.filter(e => {
      const calls = findCallSites(e);
      return calls.some(c => !c.file.includes('harness/hooks'));
    });
    const pct = expected.length > 0 ? Math.round((covered.length / expected.length) * 100) : 100;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    console.log(`  ${phase.padEnd(12)} ${bar} ${pct}% (${covered.length}/${expected.length})`);
  }
}

main();
