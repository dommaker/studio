/**
 * Analyst Executor — Claude Code 执行 + 输出验证
 *
 * 从 analyst-trigger.service.ts 提取。
 */
import { logger } from '@dommaker/studio-shared';
import { daemon } from '../../daemon/studio-daemon.js';
import { ensureWorktree } from './analyst-knowledge.js';
import { parseClaudeUsage } from '../../daemon/metrics.js';
import * as fs from 'fs';

export interface RequirementsDocJson {
  title: string;
  summary: string;
  /** 任务复杂度分级：fast=单session单步, standard=当前管线, premium=详细上下文 */
  tier?: 'fast' | 'standard' | 'premium';
  tierReason?: string;
  interfaceVerification?: {
    verified: string[];
    unverified: string[];
    newRequired: string[];
  };
  acGroups: Array<{
    id: string;
    acs: string[];
    files: string[];
    dependencies: string[];
    implementationNotes: string;
    architectureContext?: {
      functions: string[];
      callChain: string;
      imports: string[];
      typesInScope: string[];
      testMock: string[];
      dangerZones: string[];
      verifiedAt: string;
    };
    codePatterns: string[];
    gotchas: string[];
    modelTier?: 'fast' | 'standard' | 'premium';
    modelTierReason?: string;
  }>;
  constraints: string[];
  tags: string[];
  discoveries?: Array<{
    type: string;
    severity: string;
    file: string;
    title: string;
    description?: string;
    category?: string;
  }>;
  /** TDD-05: Analyst 写的契约测试（按 AC 组组织，RED 状态） */
  contractTests?: Array<{
    /** 测试文件名，如 ac-group-1.test.ts */
    file: string;
    /** 测试代码内容（可执行的 vitest 代码） */
    content: string;
  }>;
  /** SP-004: Executor 需运行的已有测试文件路径（回归验证） */
  testFiles?: string[];
  /** Analyst 主动跳过契约测试时必须填写原因（如：纯文件创建、无代码行为可测） */
  contractTestsSkipReason?: string;
}

/**
 * 从需求文本预判任务分级（规则，0 成本）
 * Analyst 可以覆盖此预判（输出自己的 tier 字段）
 */
export function preClassifyTier(requirement: string): 'fast' | 'standard' | 'premium' {
  const lower = requirement.toLowerCase();
  const hasSchema = /schema|migration|prisma|migrate|数据库/i.test(lower);
  const hasMultiModule = /跨模块|多模块|架构重构|新模块|new module/i.test(lower);
  const hasSecurity = /auth|login|password|token|oauth|jwt|security|加密|encrypt/i.test(lower);
  const isShort = requirement.length < 300;
  const hasSimpleKeywords = /修复|fix|改|replace|移除|remove|添加|add|升级|upgrade|更新|update/i.test(lower);

  if (hasSchema || hasMultiModule || hasSecurity) return 'premium';
  if (isShort && hasSimpleKeywords) return 'fast';
  return 'standard';
}

// O1d: accept optional claudeArgs for tool restriction on Simple tasks
export async function runClaudeCode(prompt: string, outputFile: string, claudeArgs?: string[], modelTier?: 'fast' | 'standard' | 'premium'): Promise<{ doc: RequirementsDocJson; usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number } }> {
  ensureWorktree();

  // Use ad-hoc session for concurrent @Analyst support
  const result = await daemon.submitAdhocJob({
    prompt,
    outputFile,
    ...(claudeArgs ? { claudeArgs } : {}),
  }, {
    worktree: process.env.REPO_DIR || process.cwd(), // needs access to project source, not .analyst/
    modelTier: modelTier || 'premium',
  });

  if (!result.success) {
    throw new Error(`Analyst daemon task failed: ${result.error}`);
  }

  const raw = result.output || '';

  // --output-format json → Claude Code 返回 JSON envelope: { result, usage }
  let text = raw;
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result) text = envelope.result;
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to parse JSON envelope', { error: String(e) });
  }
  // Reuse parseClaudeUsage for robust parsing (JSON + regex fallback)
  const usage = parseClaudeUsage(raw);

  // Read the output JSON file (Claude Code writes structured output here)
  if (fs.existsSync(outputFile)) {
    const json = fs.readFileSync(outputFile, 'utf-8');
    try {
      return { doc: JSON.parse(json), usage };
    } catch {
      const match = json.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match?.[1]) return { doc: JSON.parse(match[1].trim()), usage };
    }
  }

  // Fallback: try to parse RequirementsDoc from result text
  const jsonMatch = text.match(/\{[\s\S]*"acGroups"[\s\S]*\}/);
  if (jsonMatch) return { doc: JSON.parse(jsonMatch[0]), usage };

  throw new Error(`Analyst did not produce valid output. text: ${text.slice(0, 500)}`);
}

// ── B5-H01: Analyst 输出 JSON Schema 验证 ──

interface AnalystOutput {
  title?: string;
  tier?: string;
  acGroups?: Array<{
    id?: string;
    acs?: unknown[];
    files?: unknown[];
    dependencies?: unknown[];
    implementationNotes?: string;
  }>;
  tags?: unknown[];
  constraints?: unknown[];
  discoveries?: unknown[];
  contractTests?: unknown[];
  contractTestsSkipReason?: unknown;
}

/** 验证 Analyst 输出结构，返回错误列表（空 = 通过） */
export function validateAnalystOutput(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') {
    return ['Output is not an object'];
  }
  const d = doc as AnalystOutput;

  // title: optional but if present must be string
  if (d.title !== undefined && typeof d.title !== 'string') {
    errors.push('title must be a string');
  }

  // acGroups: required, must be non-empty array
  if (!Array.isArray(d.acGroups) || d.acGroups.length === 0) {
    errors.push('acGroups must be a non-empty array');
  } else {
    for (let i = 0; i < d.acGroups.length; i++) {
      const g = d.acGroups[i];
      if (!g || typeof g !== 'object') { errors.push(`acGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !g.id.trim()) errors.push(`acGroups[${i}].id must be a non-empty string`);
      if (!Array.isArray(g.acs) || g.acs.length === 0) errors.push(`acGroups[${i}].acs must be a non-empty array`);
      if (g.files !== undefined && !Array.isArray(g.files)) errors.push(`acGroups[${i}].files must be an array`);
      if (g.dependencies !== undefined && !Array.isArray(g.dependencies)) errors.push(`acGroups[${i}].dependencies must be an array`);
    }
  }

  // tags/constraints/discoveries: optional, if present must be arrays
  for (const field of ['tags', 'constraints', 'discoveries'] as const) {
    if (d[field] !== undefined && !Array.isArray(d[field])) {
      errors.push(`${field} must be an array`);
    }
  }

  // TDD-07: contractTests validation (optional but if present must be valid)
  if (d.contractTests !== undefined) {
    if (!Array.isArray(d.contractTests)) {
      errors.push('contractTests must be an array');
    } else {
      for (let i = 0; i < d.contractTests.length; i++) {
        const t = d.contractTests[i] as Record<string, unknown> | undefined;
        if (!t || typeof t !== 'object') { errors.push(`contractTests[${i}] must be an object`); continue; }
        if (typeof t.file !== 'string' || !t.file.trim()) errors.push(`contractTests[${i}].file must be a non-empty string`);
        if (typeof t.content !== 'string') errors.push(`contractTests[${i}].content must be a string`);
      }
    }
  }
  // contractTests 为空时，必须提供 skipReason
  const hasTests = Array.isArray(d.contractTests) && d.contractTests.length > 0;
  if (!hasTests && (d.contractTestsSkipReason === undefined || d.contractTestsSkipReason === null)) {
    errors.push('contractTests empty requires contractTestsSkipReason explaining why');
  }
  if (d.contractTestsSkipReason !== undefined && typeof d.contractTestsSkipReason !== 'string') {
    errors.push('contractTestsSkipReason must be a string');
  }

  return errors;
}
