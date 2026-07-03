/**
 * RequirementGate — RequirementsDoc 质量门 (2026-05-21)
 *
 * 在 WorkUnit 创建前验证 AC 组质量：
 *   Stage 1 (纯代码): AC 粒度、文件路径、依赖闭环
 *   Stage 2 (flash LLM): AC 独立性、隐式依赖、文件冲突
 *
 * 不通过 → 退回 Channel 反馈 → Analyst 修正
 */

import { logger } from '@dommaker/studio-shared';
import { sharedStore } from '../knowledge/knowledge-bus.service.js';
import * as fs from 'fs';
import * as path from 'path';

export interface AcGroup {
  id: string;
  acs: string[];
  files: string[];
  dependencies: string[];
  implementationNotes?: string;
  codePatterns?: string[];
  gotchas?: string[];
  architectureContext?: {
    functions: string[];
    callChain: string;
    imports: string[];
    typesInScope: string[];
    testMock: string[];
    dangerZones: string[];
    verifiedAt: string;
  };
}

export type TierRecommendation = 'flash-ok' | 'upgrade-to-standard' | 'upgrade-to-premium' | 'needs-human';

export interface GateResult {
  passed: boolean;
  stage1: GateCheck[];
  stage2?: GateCheck[];
  suggestions: string[];
  /** tier 升级建议 */
  tierRecommendation: TierRecommendation;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  message: string;
}

/**
 * Stage 1: 纯代码检查
 */
function stage1CodeCheck(groups: AcGroup[], repoDir: string): GateCheck[] {
  const checks: GateCheck[] = [];
  const validFilePathRe = /^[\w\-\/]+\.[a-z]{1,6}$/i; // eg: src/modules/foo/bar.ts

  // 1. AC 粒度: 每组 ≤10 AC
  for (const g of groups) {
    if (g.acs.length > 10) {
      checks.push({
        name: 'ac-granularity',
        passed: false,
        message: `组 "${g.id}" 有 ${g.acs.length} 个 AC，超过 10 个上限。请拆分为更小的组`,
      });
    } else if (g.acs.length === 0) {
      checks.push({
        name: 'ac-empty',
        passed: false,
        message: `组 "${g.id}" 没有 AC。请为每个组定义验收标准`,
      });
    }
  }

  // 2. 文件路径: 至少列出一个，且在仓库中存在
  //    — 只验证真实文件路径（过滤混入的实现指南文本）
  //    — 新建文件（所在目录存在但文件不存在）视为合理，不阻塞
  for (const g of groups) {
    // Filter: only validate entries that look like actual file paths
    const realFiles = g.files
      .map(f => f.replace(/`/g, '').trim())
      .filter(f => validFilePathRe.test(f));
    const nonFileEntries = g.files.length - realFiles.length;

    if (realFiles.length === 0 && nonFileEntries > 0) {
      // All "files" are actually notes/guidelines — suggest clean AC group format in Analyst prompt
      checks.push({
        name: 'files-format',
        passed: true, // soft warning, not a hard failure
        message: `组 "${g.id}" 的 Files 字段包含 ${g.files.length} 个条目但都不是有效文件路径。实现指南请放在 implementationNotes 中`,
      });
    } else if (realFiles.length === 0) {
      checks.push({
        name: 'files-missing',
        passed: false,
        message: `组 "${g.id}" 没有列出文件。并行执行依赖 files 字段做冲突检测`,
      });
    }

    // Monorepo path resolution: Analyst may write paths relative to monorepo root
    // (packages/foo/...) or relative to a package dir (src/modules/...).
    // Try repoDir first, then common package subdirectories.
    const tryDirs = [repoDir];
    for (const sub of ['apps/api', 'apps/web', 'packages/studio-shared', 'packages/studio-agent', 'packages/studio-skill', 'packages/studio-prisma', '..', '../harness']) {
      const candidate = path.join(repoDir, sub);
      if (fs.existsSync(candidate)) tryDirs.push(candidate);
    }

    for (const clean of realFiles) {
      let found = false;
      // Absolute paths: check directly, don't join with base
      const isAbsolute = path.isAbsolute(clean);
      const bases = isAbsolute ? [''] : tryDirs;
      for (const base of bases) {
        const fullPath = isAbsolute ? clean : path.join(base, clean);
        if (fs.existsSync(fullPath)) { found = true; break; }
        // New file: check if any ancestor directory exists (up to 3 levels)
        let ancestor = path.dirname(fullPath);
        for (let level = 0; level < 3; level++) {
          if (fs.existsSync(ancestor)) { found = true; break; }
          ancestor = path.dirname(ancestor);
        }
        if (found) break;
      }
      if (!found) {
        checks.push({
          name: 'file-not-found',
          passed: false,
          message: `组 "${g.id}" 声明的文件 "${clean}" 路径不存在（目录也不存在），请确认路径是否正确`,
        });
      }
    }
  }

  // 3. 依赖闭环: dependencies 指向存在的组
  const groupIds = new Set(groups.map(g => g.id));
  for (const g of groups) {
    for (const dep of g.dependencies) {
      if (!groupIds.has(dep)) {
        checks.push({
          name: 'dep-not-found',
          passed: false,
          message: `组 "${g.id}" 依赖 "${dep}"，但该组不存在`,
        });
      }
    }
  }

  // 4. 文件冲突: 多个组同时操作同一文件 → 标记依赖（只检查真实文件路径）
  const fileOwners = new Map<string, string[]>();
  for (const g of groups) {
    for (const f of g.files) {
      const clean = f.replace(/`/g, '').trim();
      if (!validFilePathRe.test(clean)) continue; // skip non-file-path entries
      if (!fileOwners.has(clean)) fileOwners.set(clean, []);
      fileOwners.get(clean)!.push(g.id);
    }
  }
  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      checks.push({
        name: 'file-conflict',
        passed: true, // warning — 依赖排序系统处理执行顺序，不阻断
        message: `文件 "${file}" 被 ${owners.join(', ')} 共同操作。需要建立依赖关系避免并行冲突`,
      });
    }
  }

  // 5. AC 结构化质量校验已移至 Stage 2（LLM 语义验证）
  //    regex 无法可靠校验自然语言格式，由 LLM 判断 AC 是否包含足够上下文

  // 如果以上检查都没问题，pass
  if (checks.length === 0) {
    checks.push({ name: 'stage1-summary', passed: true, message: '所有纯代码检查通过' });
  }

  return checks;
}

/**
 * Stage 2: 确定性语义检查（替代原 LLM 验证）
 *
 * 原则：LLM 判断不阻断流程。用确定性规则检查可检查的部分，
 * LLM 判断降级为 soft warning（注入 Executor prompt 供参考）。
 */
function stage2DeterministicCheck(groups: AcGroup[], title: string): GateCheck[] {
  const checks: GateCheck[] = [];

  // 1. AC 独立性 — 文件重叠检测（确定性）
  //    如果两组操作同一文件但无依赖声明 → warning（不阻断）
  const fileToGroups = new Map<string, string[]>();
  for (const g of groups) {
    for (const f of g.files) {
      const clean = f.replace(/`/g, '').trim();
      if (!clean) continue;
      if (!fileToGroups.has(clean)) fileToGroups.set(clean, []);
      fileToGroups.get(clean)!.push(g.id);
    }
  }
  const groupIds = new Set(groups.map(g => g.id));
  const depsMap = new Map(groups.map(g => [g.id, new Set(g.dependencies)]));

  for (const [file, owners] of fileToGroups) {
    if (owners.length <= 1) continue;
    for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        const a = owners[i], b = owners[j];
        const aDeps = depsMap.get(a) || new Set();
        const bDeps = depsMap.get(b) || new Set();
        if (!aDeps.has(b) && !bDeps.has(a)) {
          checks.push({
            name: 'independence-warning',
            passed: true, // soft warning — 不阻断
            message: `[warning] 组 "${a}" 和 "${b}" 操作同一文件 "${file}" 但无依赖声明 — Executor 应避免并行执行`,
          });
        }
      }
    }
  }

  // 2. 隐式依赖 — 声明完整性（确定性）
  //    已在 Stage 1 check #3 覆盖（dep-not-found）
  //    补充：检查被依赖的组是否声明了反向依赖
  for (const g of groups) {
    for (const dep of g.dependencies) {
      if (!groupIds.has(dep)) continue; // Stage 1 已报 dep-not-found
      const reverseDeps = depsMap.get(dep) || new Set();
      if (!reverseDeps.has(g.id)) {
        checks.push({
          name: 'one-way-dep-warning',
          passed: true, // soft warning
          message: `[warning] 组 "${g.id}" 依赖 "${dep}" 但反向未声明 — 单向依赖可能导致并行冲突`,
        });
      }
    }
  }

  // 3. architectureContext 完整性（确定性 — 字段存在性检查）
  for (const g of groups) {
    if (!g.architectureContext) continue; // 可选字段，缺失不报
    const ctx = g.architectureContext;
    const required = ['functions', 'imports'] as const;
    for (const field of required) {
      const val = ctx[field as keyof typeof ctx];
      if (!val || (Array.isArray(val) && val.length === 0)) {
        checks.push({
          name: 'arch-ctx-warning',
          passed: true, // soft warning — 不阻断
          message: `[warning] 组 "${g.id}" architectureContext.${field} 为空 — Executor 可能需要额外探索代码`,
        });
      }
    }
  }

  if (checks.length === 0) {
    checks.push({ name: 'stage2-summary', passed: true, message: '确定性语义检查通过' });
  }

  return checks;
}

/**
 * 主入口
 */
export async function validateRequirementsDoc(
  groups: AcGroup[],
  title: string,
  repoDir: string,
  interfaceVerification?: { verified: string[]; unverified: string[]; newRequired: string[] },
): Promise<GateResult> {
  const suggestions: string[] = [];

  // Stage 0: Interface assumption check
  const stage0: GateCheck[] = [];
  if (interfaceVerification?.unverified?.length) {
    stage0.push({
      name: 'interface-unverified',
      passed: false,
      message: `${interfaceVerification.unverified.length} 个接口假设未在代码库中验证: ${interfaceVerification.unverified.join(', ')}。请确认接口存在后再继续。`,
    });
  }
  if (interfaceVerification) {
    stage0.push({
      name: 'interface-verified',
      passed: true,
      message: `${interfaceVerification.verified.length} 个接口已验证, ${interfaceVerification.newRequired.length} 个需新建`,
    });
  }

  // Stage 1
  const stage1 = stage1CodeCheck(groups, repoDir);
  const stage1Passed = stage1.every(c => c.passed);

  // Stage 2: 确定性检查（全部 soft warning，不阻断）
  const stage2 = stage1Passed ? stage2DeterministicCheck(groups, title) : [];
  // Stage 2 不阻断流程 — 所有检查结果为 warning，passed 始终为 true
  const stage2Passed = true;

  const stage0Passed = stage0.length === 0 || stage0.every(c => c.passed);
  const passed = stage0Passed && stage1Passed && stage2Passed;

  // Tier 升级建议
  let tierRecommendation: TierRecommendation = 'flash-ok';
  const hasCodeIssues = stage1.some(c => !c.passed && ['file-not-found', 'dep-not-found'].includes(c.name));
  const hasAcGranularityIssue = stage1.some(c => !c.passed && c.name === 'ac-granularity');

  if (hasCodeIssues) {
    tierRecommendation = 'needs-human'; // 文件不存在/依赖组不存在 → LLM 改不了
  } else if (hasAcGranularityIssue) {
    tierRecommendation = 'needs-human'; // AC 太多 → 需要人工拆
  }
  // file-conflict 不触发 tier 升级 — 依赖排序系统已处理执行顺序
  // 修改现有代码的功能天然有多组共享文件，revision 无法解决

  // P0.2: Query KK for historical pitfalls related to the files being modified
  let kkSuggestions: string[] = [];
  try {
    const allFiles = groups.flatMap(g => g.files || []);
    const allPitfalls = sharedStore.list({ types: ['pitfall'] }).filter(e => e.maturity !== 'archived');
    for (const pf of allPitfalls) {
      const pfContent = (pf.content || '').toLowerCase();
      const pfTitle = (pf.title || '').toLowerCase();
      // Check if any file path segment appears in the pitfall content/title
      for (const file of allFiles) {
        const segments = file.toLowerCase().split(/[\/\\]/);
        for (const seg of segments) {
          if (seg.length >= 3 && (pfContent.includes(seg) || pfTitle.includes(seg))) {
            kkSuggestions.push(`⚠️ 历史陷阱 [${pf.title.slice(0, 100)}]: ${pf.content.slice(0, 150)}`);
            break;
          }
        }
      }
    }
    // Dedup
    kkSuggestions = [...new Set(kkSuggestions)].slice(0, 3);
  } catch { /* best-effort */ }

  // Build suggestions
  for (const c of [...stage0, ...stage1, ...stage2]) {
    if (!c.passed) suggestions.push(c.message);
  }

  // Append KK-identified pitfalls as contextual warnings
  if (kkSuggestions.length > 0) {
    suggestions.push('\n## 历史教训（知识库匹配）');
    suggestions.push(...kkSuggestions);
  }

  // Add tier recommendation
  if (tierRecommendation === 'needs-human') {
    suggestions.push('⚠️ 自动修正无法解决，请在 Channel 中 @Analyst 提出修正，或将任务拆分更细');
  }

  return { passed, stage1, stage2, suggestions, tierRecommendation };
}
