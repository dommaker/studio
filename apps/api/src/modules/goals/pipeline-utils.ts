/**
 * Pipeline Utils — 共享纯函数层
 *
 * parseAcGroups: RequirementsDocJson → AcGroup[]
 * resolveDependencies: Kahn 拓扑排序 → AcGroup[][]
 * routeModel: 纯函数版 tier 路由
 * buildSkillPrompt: 从 SKILL.md 模板构建 prompt
 * grepACTests: 扫描测试文件检查 AC 覆盖
 * harnessCheck: 运行 tsc + test 质量门
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { RequirementsDocJson } from '../channels/analyst-executor.js';

// ─── Types ───

export interface AcGroup {
  id: string;
  acs: string[];
  files: string[];
  dependencies: string[];
  implementationNotes?: string;
  codePatterns?: string[];
  gotchas?: string[];
  modelTier?: string;
  modelTierReason?: string;
}

// ─── SKILLS_DIR ───

export const SKILLS_DIR = process.env.SKILLS_DIR || path.join(
  process.env.HOME || '/root', '.studio', 'skills',
);

// ─── parseAcGroups ───

/**
 * 从 RequirementsDocJson 提取并验证 AcGroup[]。
 * 过滤无效条目（缺少 id 或 acs 为空）。
 */
export function parseAcGroups(spec: RequirementsDocJson): AcGroup[] {
  if (!spec.acGroups || !Array.isArray(spec.acGroups)) return [];
  return spec.acGroups.filter(
    (g): g is typeof g & { id: string; acs: string[] } =>
      typeof g.id === 'string' && g.id.length > 0
      && Array.isArray(g.acs) && g.acs.length > 0,
  ).map(g => ({
    id: g.id,
    acs: g.acs,
    files: g.files || [],
    dependencies: g.dependencies || [],
    implementationNotes: g.implementationNotes,
    codePatterns: g.codePatterns,
    gotchas: g.gotchas,
    modelTier: g.modelTier,
    modelTierReason: g.modelTierReason,
  }));
}

// ─── resolveDependencies ───

/**
 * Kahn 拓扑排序。返回按依赖层级组织的二维数组。
 * 同层可并行，不同层串行。循环依赖抛错。
 */
export function resolveDependencies(acGroups: AcGroup[]): AcGroup[][] {
  const groupMap = new Map<string, AcGroup>();
  for (const g of acGroups) groupMap.set(g.id, g);

  // 入度计数
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const g of acGroups) {
    inDegree.set(g.id, 0);
    adjacency.set(g.id, []);
  }
  for (const g of acGroups) {
    for (const dep of g.dependencies) {
      if (groupMap.has(dep)) {
        adjacency.get(dep)!.push(g.id);
        inDegree.set(g.id, (inDegree.get(g.id) || 0) + 1);
      }
    }
  }

  // BFS 层级遍历
  const layers: AcGroup[][] = [];
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const layer: AcGroup[] = [];
    const nextQueue: string[] = [];
    for (const id of queue) {
      layer.push(groupMap.get(id)!);
      for (const neighbor of adjacency.get(id) || []) {
        const newDeg = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) nextQueue.push(neighbor);
      }
    }
    layers.push(layer);
    queue.length = 0;
    queue.push(...nextQueue);
  }

  // 循环检测
  const sorted = layers.flat();
  if (sorted.length !== acGroups.length) {
    const sortedIds = new Set(sorted.map(g => g.id));
    const circular = acGroups.filter(g => !sortedIds.has(g.id));
    const cyclePath = circular.map(g => {
      const deps = g.dependencies.filter(d => groupMap.has(d));
      return `${g.id} → ${deps.join(', ') || '(no valid deps)'}`;
    }).join('; ');
    throw new Error(`Circular dependency detected: ${cyclePath}`);
  }

  return layers;
}

// ─── routeModel ───

const HIGH_RISK = /migration|migrate|auth|authentication|security|financial|payment|encrypt|crypto/i;
const LOW_RISK = /style|typo|rename|format|lint|comment|doc|readme|spelling/i;

/**
 * 纯函数版 tier 路由。优先使用 acGroup.modelTier（Analyst 预分类）。
 */
export function routeModel(acGroup: AcGroup): { tier: string; reason: string } {
  // Analyst 预分类优先
  if (acGroup.modelTier && ['fast', 'standard', 'premium'].includes(acGroup.modelTier)) {
    return { tier: acGroup.modelTier, reason: acGroup.modelTierReason || 'analyst-classified' };
  }

  const acCount = acGroup.acs.length;
  const fileCount = acGroup.files.length;
  const gotchasLen = (acGroup.gotchas || []).length;
  const notes = acGroup.implementationNotes || '';
  const combined = `${notes} ${acGroup.acs.join(' ')}`;

  const isHighRisk = HIGH_RISK.test(combined);
  const isLowRisk = LOW_RISK.test(combined);

  // premium 触发
  if (isHighRisk || acCount >= 6 || fileCount >= 7) {
    const triggers: string[] = [];
    if (isHighRisk) triggers.push('highRiskKeyword');
    if (acCount >= 6) triggers.push(`acCount=${acCount}`);
    if (fileCount >= 7) triggers.push(`fileCount=${fileCount}`);
    return { tier: 'premium', reason: triggers.join('; ') };
  }

  // fast 触发
  if (isLowRisk && acCount <= 2 && fileCount <= 3) {
    return { tier: 'fast', reason: `lowRisk, acCount=${acCount}, fileCount=${fileCount}` };
  }

  return { tier: 'standard', reason: `default (acCount=${acCount}, fileCount=${fileCount})` };
}

// ─── buildSkillPrompt ───

/**
 * 从 SKILL.md 模板构建 prompt。
 * 目录结构: SKILLS_DIR/<trigger>/<skillName>/SKILL.md
 * 支持占位符: {{task}}, {{constraints}}, {{knowledgeContext}}, {{capabilities}}
 */
export function buildSkillPrompt(
  skillName: string,
  vars: Record<string, string>,
): string {
  // 搜索所有 trigger 子目录
  if (!fs.existsSync(SKILLS_DIR)) return '';

  let template: string | null = null;
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(SKILLS_DIR, entry.name, skillName, 'SKILL.md');
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      if (match) {
        template = match[1].trim();
        break;
      }
    }
  }

  if (!template) return '';

  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// ─── grepACTests ───

export interface ACTestCoverage {
  acId: string;
  testFile: string;
  matched: boolean;
}

/**
 * 扫描 dir 下 .test.ts/.spec.ts 文件，检查每个 AC 是否有对应测试。
 * 使用字符串匹配（非 AST）。
 */
export function grepACTests(acs: string[], dir: string): ACTestCoverage[] {
  const results: ACTestCoverage[] = [];
  const testFiles = findTestFiles(dir);

  for (const ac of acs) {
    let matched = false;
    let matchedFile = '';
    for (const file of testFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes(ac)) {
          matched = true;
          matchedFile = path.relative(dir, file);
          break;
        }
      } catch { /* skip unreadable files */ }
    }
    results.push({ acId: ac, testFile: matchedFile, matched });
  }

  return results;
}

function findTestFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(full);
      } else if (entry.isFile() && /\.(test|spec)\.(ts|js)$/.test(entry.name)) {
        results.push(full);
      }
    }
  };

  walk(dir);
  return results;
}

// ─── harnessCheck ───

export interface HarnessCheckResult {
  passed: boolean;
  errors: string[];
}

/**
 * 质量门：在 workdir 中执行 tsc --noEmit 和 npm test。
 * 失败不抛错，返回 {passed: false, errors}。超时 120s。
 */
export async function harnessCheck(workdir: string): Promise<HarnessCheckResult> {
  if (!fs.existsSync(workdir)) {
    return { passed: false, errors: ['workdir not found'] };
  }

  const TIMEOUT = 120_000;
  const errors: string[] = [];

  try {
    execSync('npx tsc --noEmit', { cwd: workdir, timeout: TIMEOUT, stdio: 'pipe', encoding: 'utf-8' });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    errors.push(`tsc failed:\n${e.stdout || ''}${e.stderr || ''}`.trim());
  }

  try {
    execSync('npm test', { cwd: workdir, timeout: TIMEOUT, stdio: 'pipe', encoding: 'utf-8' });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    errors.push(`npm test failed:\n${e.stdout || ''}${e.stderr || ''}`.trim());
  }

  return { passed: errors.length === 0, errors };
}
