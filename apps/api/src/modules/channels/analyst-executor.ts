/**
 * Analyst Executor — Claude Code 执行 + 输出验证
 *
 * 从 analyst-trigger.service.ts 提取。
 */
import { logger } from '@dommaker/studio-shared';
import { daemon } from '../../daemon/studio-daemon.js';
import { ensureWorktree } from './analyst-knowledge.js';
import * as fs from 'fs';

export interface RequirementsDocJson {
  title: string;
  summary: string;
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
}

// O1d: accept optional claudeArgs for tool restriction on Simple tasks
export async function runClaudeCode(prompt: string, outputFile: string, claudeArgs?: string[]): Promise<{ doc: RequirementsDocJson; usage?: { inputTokens: number; outputTokens: number; cacheHitTokens: number } }> {
  ensureWorktree();

  // Use ad-hoc session for concurrent @Analyst support
  const result = await daemon.submitAdhocJob({
    prompt,
    outputFile,
    ...(claudeArgs ? { claudeArgs } : {}),
  }, {
    worktree: process.env.REPO_DIR || process.cwd(), // needs access to project source, not .analyst/
    modelTier: 'premium',
  });

  if (!result.success) {
    throw new Error(`Analyst daemon task failed: ${result.error}`);
  }

  const raw = result.output || '';

  // --output-format json → Claude Code 返回 JSON envelope: { result, usage }
  let text = raw;
  let usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number } | undefined;
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result) text = envelope.result;
    if (envelope.usage) {
      usage = {
        inputTokens: envelope.usage.input_tokens || 0,
        outputTokens: envelope.usage.output_tokens || 0,
        cacheHitTokens: envelope.usage.cache_read_input_tokens || envelope.usage.cache_creation_input_tokens || 0,
      };
    }
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to parse JSON envelope', { error: String(e) });
  }

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

  return errors;
}
