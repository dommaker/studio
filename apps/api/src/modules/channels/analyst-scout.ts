/**
 * Analyst Scout — Parallel code exploration sessions
 *
 * Builds scout prompts from scope; dispatch is handled by caller (trigger service).
 */
import type { ScoutScope } from './analyst-prescan.js';

export interface ScoutReport {
  type: string;
  success: boolean;
  content: string;  // JSON string of findings (from scout output file)
  durationMs: number;
  error?: string;
}

export interface ScoutPromptSpec {
  type: string;
  prompt: string;
}

/**
 * Determine which scouts to run and build their prompts.
 */
export function buildScoutPrompts(scope: ScoutScope, requirement: string): ScoutPromptSpec[] {
  const scouts: ScoutPromptSpec[] = [];

  // Code Scout — always included
  scouts.push({
    type: 'code',
    prompt: buildCodeScoutPrompt(scope, requirement),
  });

  // Knowledge Scout — always included
  scouts.push({
    type: 'knowledge',
    prompt: buildKnowledgeScoutPrompt(scope, requirement),
  });

  // Test Scout — if test concern or enough modules
  if (scope.concerns.includes('test') || scope.modules.length >= 2) {
    scouts.push({
      type: 'test',
      prompt: buildTestScoutPrompt(scope, requirement),
    });
  }

  // Schema Scout — only if schema concern
  if (scope.concerns.includes('schema')) {
    scouts.push({
      type: 'schema',
      prompt: buildSchemaScoutPrompt(scope, requirement),
    });
  }

  return scouts;
}

function buildCodeScoutPrompt(scope: ScoutScope, requirement: string): string {
  return [
    '你是代码探索专家。分析以下需求涉及的代码结构。',
    '',
    '## 需求',
    requirement,
    '',
    '## 探索范围',
    `模块: ${scope.modules.join(', ') || '根据需求判断'}`,
    `关键文件: ${scope.keyFiles.join(', ') || '自行定位'}`,
    '',
    '## 输出格式 (JSON)',
    '```json',
    '{',
    '  "affectedFiles": ["path/to/file.ts — 说明"],',
    '  "functionSignatures": ["functionName(params): returnType @ L123"],',
    '  "callChains": ["caller → callee → leaf"],',
    '  "imports": ["import { X } from \\"./path\\";"],',
    '  "typesInScope": ["TypeName — 关键字段"],',
    '  "dangerZones": ["file.ts:L45-L60 — 不要碰的原因"],',
    '  "codePatterns": ["可复用的模式描述"],',
    '  "gotchas": ["红线格式: 不可删除 X (下游: Y)"]',
    '}',
    '```',
    '',
    '探索代码库（Read/Grep/Glob），输出上述 JSON。不修改任何文件。',
  ].join('\n');
}

function buildTestScoutPrompt(scope: ScoutScope, requirement: string): string {
  return [
    '你是测试分析专家。分析以下需求涉及的测试结构。',
    '',
    '## 需求',
    requirement,
    '',
    '## 探索范围',
    `模块: ${scope.modules.join(', ')}`,
    '',
    '## 输出格式 (JSON)',
    '```json',
    '{',
    '  "existingTestFiles": ["path/to/test.ts — 覆盖什么"],',
    '  "mockPatterns": ["vi.mock(\\"./module\\", () => ({ ... }))"],',
    '  "coverageGaps": ["未被测试覆盖的关键路径"],',
    '  "suggestedTestFiles": ["需要新增的测试文件"],',
    '  "testFixtures": ["已有的共享 fixture，不要修改"]',
    '}',
    '```',
    '',
    '探索测试文件（Read/Grep/Glob），输出上述 JSON。不修改任何文件。',
  ].join('\n');
}

function buildKnowledgeScoutPrompt(scope: ScoutScope, requirement: string): string {
  return [
    '你是知识检索专家。从项目知识库中检索与需求相关的模式和教训。',
    '',
    '## 需求',
    requirement,
    '',
    '## 探索范围',
    `关注点: ${scope.concerns.join(', ')}`,
    '',
    '## 输出格式 (JSON)',
    '```json',
    '{',
    '  "relevantPatterns": ["模式描述 — 来源文件"],',
    '  "historicalLessons": ["历史教训 — 来源"],',
    '  "relatedDecisions": ["架构决策 — 来源"],',
    '  "applicableGotchas": ["适用注意事项"],',
    '  "knowledgeGaps": ["知识缺失——需要探索确认的假设"]',
    '}',
    '```',
    '',
    '搜索 docs/sdd/、docs/decisions.md（Read/Grep）。需要历史模式/坑点时用 mcp__local-rag__query_documents 检索。输出上述 JSON。不修改任何文件。',
  ].join('\n');
}

function buildSchemaScoutPrompt(scope: ScoutScope, requirement: string): string {
  return [
    '你是 Schema 分析专家。分析需求涉及的数据库 Schema 和 API 接口。',
    '',
    '## 需求',
    requirement,
    '',
    '## 输出格式 (JSON)',
    '```json',
    '{',
    '  "schemaModels": ["ModelName — 关键字段"],',
    '  "apiRoutes": ["METHOD /path — handler"],',
    '  "interfaceConstraints": ["接口约束描述"],',
    '  "migrationNeeds": ["是否需要 migration"],',
    '  "dangerZones": ["不可修改的 schema 字段及原因"]',
    '}',
    '```',
    '',
    '读 prisma/schema.prisma + API routes（Read/Grep），输出上述 JSON。不修改任何文件。',
  ].join('\n');
}
