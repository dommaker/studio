/**
 * Analyst Executor — Claude Code 执行 + 输出验证
 *
 * 从 analyst-trigger.service.ts 提取。
 */
import { logger, modelGateway } from '@dommaker/studio-shared';
import { daemon } from '../../daemon/studio-daemon.js';
import { ensureWorktree } from './analyst-knowledge.js';
import { parseClaudeUsage } from '../../daemon/metrics.js';
import * as fs from 'fs';
import * as path from 'path';

export interface RequirementsDocJson {
  requirement: {
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
      targetRepo?: string;
      acs: string[];
      files: string[];
      dependencies: string[];
    }>;
    constraints: string[];
    tags: string[];
    discoveries?: Array<{
      type: 'tech_debt' | 'bug' | 'improvement' | 'security' | 'deprecation' | 'observation';
      severity: 'low' | 'medium' | 'high' | 'critical';
      file: string;
      title: string;
      description?: string;
      category?: string;
      effort?: string;
    }>;
  };
  design: {
    acGroups: Array<{
      id: string;
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
  };
  task: {
    acGroups: Array<{
      id: string;
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
    }>;
  };
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

/**
 * Sanitize LLM-generated JSON text — fix common escape/format issues before JSON.parse.
 * LLMs frequently produce invalid JSON: markdown escapes (\: \. \*),
 * unescaped control chars, trailing commas, BOM, etc.
 */
export function sanitizeJson(raw: string): string {
  let s = raw;
  // Strip BOM
  s = s.replace(/^\uFEFF/, '');
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  s = s.replace(/^```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
  // Fix invalid JSON escape sequences: \: \. \* \( \) \# \- \> → literal char
  // Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX
  s = s.replace(/\\([:.*()#>\-])/g, '$1');
  // Remove unescaped control characters (keep \n \r \t)
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // Fix trailing commas before } or ]: ,} → } ,] → ]
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s;
}

/**
 * LLM-based JSON repair — last resort when sanitize+parse all fail.
 * Sends raw text to LLM with explicit repair instruction.
 */
async function repairJsonWithLLM(rawText: string): Promise<Record<string, unknown> | null> {
  if (!modelGateway.isAvailable()) return null;
  try {
    const result = await modelGateway.promptJson<Record<string, unknown>>(
      `Repair this malformed JSON into valid JSON. Keep all content, fix only syntax errors (bad escapes, trailing commas, missing quotes, etc). Return ONLY the repaired JSON, no commentary.\n\nRaw text:\n${rawText.slice(0, 4000)}`,
      'You are a JSON repair tool. Fix syntax errors and return valid JSON only.',
    );
    if (result && typeof result === 'object' && (result as Record<string, unknown>).requirement) {
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

// O1d: accept optional claudeArgs for tool restriction on Simple tasks
export async function runClaudeCode(prompt: string, outputFile: string, claudeArgs?: string[], modelTier?: 'fast' | 'standard' | 'premium'): Promise<{ doc: RequirementsDocJson; usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number }; rawOutput: string }> {
  ensureWorktree();

  // Resolve to absolute path — API process CWD may differ from worktree,
  // causing session-manager to look for the file in the wrong directory.
  const worktree = process.env.REPO_DIR || process.cwd();
  const resolvedOutputFile = path.isAbsolute(outputFile)
    ? outputFile
    : path.join(worktree, outputFile);

  // Use ad-hoc session for concurrent @Analyst support
  const result = await daemon.submitAdhocJob({
    prompt,
    outputFile: resolvedOutputFile,
    ...(claudeArgs ? { claudeArgs } : {}),
  }, {
    worktree, // needs access to project source, not .analyst/
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
  // Parse chain: sanitize→parse → code-fence extract → regex match → LLM repair
  if (fs.existsSync(resolvedOutputFile)) {
    const fileRaw = fs.readFileSync(resolvedOutputFile, 'utf-8');
    const sanitized = sanitizeJson(fileRaw);

    // Layer 1: direct parse (after sanitize)
    try {
      return { doc: JSON.parse(sanitized), usage, rawOutput: raw };
    } catch { /* continue */ }

    // Layer 2: extract from code fence (after sanitize)
    const match = sanitized.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match?.[1]) {
      try {
        return { doc: JSON.parse(sanitizeJson(match[1].trim())), usage, rawOutput: raw };
      } catch { /* continue */ }
    }

    // Layer 3: parse the envelope's result field (text may be cleaner than file)
    if (text && text !== fileRaw) {
      const sanitizedText = sanitizeJson(text);
      const jsonMatch = sanitizedText.match(/\{[\s\S]*"requirement"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return { doc: JSON.parse(sanitizeJson(jsonMatch[0])), usage, rawOutput: raw };
        } catch { /* continue */ }
      }
    }

    // Layer 4: LLM repair — last resort
    logger.warn('[AnalystTrigger] All parse layers failed, attempting LLM JSON repair', { outputFile: resolvedOutputFile });
    const repaired = await repairJsonWithLLM(sanitized);
    if (repaired) {
      logger.info('[AnalystTrigger] LLM JSON repair succeeded', { outputFile: resolvedOutputFile });
      return { doc: repaired as unknown as RequirementsDocJson, usage, rawOutput: raw };
    }
  }

  // Final fallback: try text result (without file)
  if (text) {
    const sanitizedText = sanitizeJson(text);
    const jsonMatch = sanitizedText.match(/\{[\s\S]*"requirement"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return { doc: JSON.parse(sanitizeJson(jsonMatch[0])), usage, rawOutput: raw };
      } catch { /* fall through to error */ }
    }
  }

  throw new Error(`Analyst did not produce valid output. text: ${text.slice(0, 500)}`);
}

// ── B5-H01: Analyst 输出 JSON Schema 验证 ──

interface AnalystOutput {
  requirement?: {
    title?: string;
    tier?: string;
    acGroups?: Array<{
      id?: string;
      acs?: unknown[];
      files?: unknown[];
      dependencies?: unknown[];
    }>;
    tags?: unknown[];
    constraints?: unknown[];
    discoveries?: unknown[];
  };
  design?: {
    acGroups?: Array<{
      id?: string;
      implementationNotes?: string;
    }>;
  };
  task?: {
    acGroups?: Array<{
      id?: string;
      contractTests?: unknown[];
      testFiles?: unknown[];
      contractTestsSkipReason?: unknown;
    }>;
  };
}

/** 验证 Analyst 输出结构，返回错误列表（空 = 通过） */
export function validateAnalystOutput(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') {
    return ['Output is not an object'];
  }
  const d = doc as AnalystOutput;

  // requirement: required top-level key
  if (!d.requirement || typeof d.requirement !== 'object') {
    errors.push('requirement must be an object');
    return errors;
  }

  // requirement.title: optional but if present must be string
  if (d.requirement.title !== undefined && typeof d.requirement.title !== 'string') {
    errors.push('requirement.title must be a string');
  }

  // requirement.acGroups: required, must be non-empty array
  if (!Array.isArray(d.requirement.acGroups) || d.requirement.acGroups.length === 0) {
    errors.push('requirement.acGroups must be a non-empty array');
  } else {
    for (let i = 0; i < d.requirement.acGroups.length; i++) {
      const g = d.requirement.acGroups[i];
      if (!g || typeof g !== 'object') { errors.push(`requirement.acGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !g.id.trim()) errors.push(`requirement.acGroups[${i}].id must be a non-empty string`);
      if (!Array.isArray(g.acs) || g.acs.length === 0) errors.push(`requirement.acGroups[${i}].acs must be a non-empty array`);
      if (g.files !== undefined && !Array.isArray(g.files)) errors.push(`requirement.acGroups[${i}].files must be an array`);
      if (g.dependencies !== undefined && !Array.isArray(g.dependencies)) errors.push(`requirement.acGroups[${i}].dependencies must be an array`);
    }

    // AC-3: contractTests 非空时，AC 不得含"写测试"类指令
    const hasContractTests = d.task?.acGroups?.some(g => Array.isArray(g.contractTests) && g.contractTests.length > 0);
    const testKeywords = ['写测试', '创建测试', '新增测试', 'write test', 'create test', 'add test'];
    if (hasContractTests) {
      for (let i = 0; i < d.requirement.acGroups.length; i++) {
        const g = d.requirement.acGroups[i];
        if (!g || !Array.isArray(g.acs)) continue;
        for (const ac of g.acs) {
          if (typeof ac !== 'string') continue;
          const lower = ac.toLowerCase();
          if (testKeywords.some(k => lower.includes(k))) {
            errors.push(`requirement.acGroups[${i}]: AC 不得包含"写测试"指令（contractTests 已提供契约测试）: "${ac.slice(0, 60)}"`);
          }
        }
      }
    }

    // AC-4: AC 不得是纯验证步骤（无 files 时）
    const verifyOnlyPattern = /^(跑|运行|执行|run|execute|验证)\s*(测试|test|tsc|vitest)/;
    for (let i = 0; i < d.requirement.acGroups.length; i++) {
      const g = d.requirement.acGroups[i];
      if (!g || !Array.isArray(g.acs)) continue;
      const hasFiles = Array.isArray(g.files) && g.files.length > 0;
      for (const ac of g.acs) {
        if (typeof ac !== 'string') continue;
        if (verifyOnlyPattern.test(ac) && !hasFiles) {
          errors.push(`requirement.acGroups[${i}]: AC 不得是纯验证步骤（无 files）: "${ac.slice(0, 60)}"`);
        }
      }
    }
  }

  // requirement.tags/constraints/discoveries: optional, if present must be arrays
  for (const field of ['tags', 'constraints', 'discoveries'] as const) {
    if (d.requirement[field] !== undefined && !Array.isArray(d.requirement[field])) {
      errors.push(`requirement.${field} must be an array`);
    }
  }

  // design: required top-level key
  if (!d.design || typeof d.design !== 'object') {
    errors.push('design must be an object');
  } else if (Array.isArray(d.design.acGroups)) {
    for (let i = 0; i < d.design.acGroups.length; i++) {
      const g = d.design.acGroups[i];
      if (!g || typeof g !== 'object') { errors.push(`design.acGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !g.id.trim()) errors.push(`design.acGroups[${i}].id must be a non-empty string`);
    }
  }

  // task: required top-level key
  if (!d.task || typeof d.task !== 'object') {
    errors.push('task must be an object');
  } else if (Array.isArray(d.task.acGroups)) {
    for (let i = 0; i < d.task.acGroups.length; i++) {
      const g = d.task.acGroups[i];
      if (!g || typeof g !== 'object') { errors.push(`task.acGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !g.id.trim()) errors.push(`task.acGroups[${i}].id must be a non-empty string`);
      // contractTests validation per AC group
      if (g.contractTests !== undefined) {
        if (!Array.isArray(g.contractTests)) {
          errors.push(`task.acGroups[${i}].contractTests must be an array`);
        } else {
          for (let j = 0; j < g.contractTests.length; j++) {
            const t = g.contractTests[j] as Record<string, unknown> | undefined;
            if (!t || typeof t !== 'object') { errors.push(`task.acGroups[${i}].contractTests[${j}] must be an object`); continue; }
            if (typeof t.file !== 'string' || !t.file.trim()) errors.push(`task.acGroups[${i}].contractTests[${j}].file must be a non-empty string`);
            if (typeof t.content !== 'string') errors.push(`task.acGroups[${i}].contractTests[${j}].content must be a string`);
          }
        }
      }
    }
  }

  return errors;
}
