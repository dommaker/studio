/**
 * Architecture Boundary Test — Goal / Agent Network 隔离验证
 *
 * 硬约束：goals 模块源码不得查询 WorkUnit 表，workunit 模块源码不得查询 Goal/GoalExecution 表。
 * 违反此测试 = 两个架构正在耦合，必须立即修复。
 *
 * 背景：
 * - Pipeline（Goal 系统）使用 Goal + GoalPlan + GoalExecution 表
 * - Agent Network（WorkUnit 系统）使用 WorkUnit 表
 * - 两个系统是独立架构，不共用表，不交叉查询
 *
 * 排除项：
 * - @deprecated 注释中的历史说明
 * - 测试文件（__tests__/）
 * - 类型导入（import type）
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const GOALS_DIR = path.resolve(__dirname, '..');
const WORKUNIT_DIR = path.resolve(__dirname, '..', '..', 'workunit');

function getSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map(f => path.join(dir, f));
}

function checkFileForForbiddenPatterns(filePath: string, forbidden: RegExp[]): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const violations: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    for (const pattern of forbidden) {
      if (pattern.test(line)) {
        violations.push(`${path.basename(filePath)}:${i + 1} — ${line.trim()}`);
      }
    }
  }
  return violations;
}

describe('Architecture Boundary: Goal ↔ Agent Network Isolation', () => {
  it('goals module does not query WorkUnit table', () => {
    const files = getSourceFiles(GOALS_DIR);
    const forbidden = [
      /prisma\.workUnit\./,
      /workUnitService\./,
      /new WorkUnitService/,
    ];

    const violations = files.flatMap(f => checkFileForForbiddenPatterns(f, forbidden));
    expect(violations, `goals module must not query WorkUnit table:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('goals module does not subscribe to workunit events', () => {
    const files = getSourceFiles(GOALS_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/eventBus\.subscribe\(\s*['"]workunit\./.test(content)) {
        violations.push(`${path.basename(file)} — subscribes to workunit.* event`);
      }
    }

    expect(violations, `goals module must not subscribe to workunit events:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('workunit module does not query Goal/GoalExecution tables', () => {
    // Exclude migration utilities if they exist
    const excluded = ['goal-to-workunit.ts', 'status-mapping.ts'];
    const files = getSourceFiles(WORKUNIT_DIR).filter(f => !excluded.includes(path.basename(f)));
    const forbidden = [
      /prisma\.goal\./,
      /prisma\.goalExecution\./,
    ];

    const violations = files.flatMap(f => checkFileForForbiddenPatterns(f, forbidden));
    expect(violations, `workunit module must not query Goal/GoalExecution tables:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('workunit module does not subscribe to goal events', () => {
    const files = getSourceFiles(WORKUNIT_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      if (/eventBus\.subscribe\(\s*['"]goal\./.test(content)) {
        violations.push(`${path.basename(file)} — subscribes to goal.* event`);
      }
    }

    expect(violations, `workunit module must not subscribe to goal events:\n${violations.join('\n')}`).toHaveLength(0);
  });
});
