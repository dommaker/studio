/**
 * RequirementGate — RequirementsDoc 质量门 (2026-05-21)
 *
 * 在 Goal 创建前验证 AC 组质量：
 *   Stage 1 (纯代码): AC 粒度、文件路径、依赖闭环
 *   Stage 2 (flash LLM): AC 独立性、隐式依赖、文件冲突
 *
 * 不通过 → 退回 Channel 反馈 → Analyst 修正
 */

import { modelGateway, logger } from '@dommaker/studio-shared';
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

  // 1. AC 粒度: 每组 ≤6 AC
  for (const g of groups) {
    if (g.acs.length > 5) {
      checks.push({
        name: 'ac-granularity',
        passed: false,
        message: `组 "${g.id}" 有 ${g.acs.length} 个 AC，超过 5 个上限。请拆分为更小的组`,
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
        passed: false,
        message: `文件 "${file}" 被 ${owners.join(', ')} 共同操作。需要建立依赖关系避免并行冲突`,
      });
    }
  }

  // 5. B11-013: AC 结构化质量校验 — 每个 AC 必须含文件路径、位置、改动描述
  const locationPattern = /L\d+|行\s*\d+|在.{2,30}(后|前|中|内|处)/;
  const verbPattern = /^(添加|移除|修改|更新|重写|重构|创建|删除|修复|调整|升级|降级|替换|拆分|合并|注入|接入|配置|清理|Add|Remove|Update|Modify|Refactor|Create|Delete|Fix)/;
  const filePathInAc = /[\w\-\/]+\.(ts|js|tsx|jsx|json|prisma|md|yaml|yml)/;
  for (const g of groups) {
    for (const ac of g.acs) {
      const issues: string[] = [];
      if (!filePathInAc.test(ac)) issues.push('缺少文件路径');
      if (!locationPattern.test(ac)) issues.push('缺少位置（行号或锚点）');
      if (!verbPattern.test(ac)) issues.push('改动描述应以动词开头');
      if (issues.length > 0) {
        checks.push({
          name: 'ac-structure',
          passed: false, // hard gate — force Analyst to improve AC quality
          message: `组 "${g.id}" AC 质量不足: ${issues.join('、')}。AC: "${ac.slice(0, 80)}..."`,
        });
      }
    }
  }

  // 如果以上检查都没问题，pass
  if (checks.length === 0) {
    checks.push({ name: 'stage1-summary', passed: true, message: '所有纯代码检查通过' });
  }

  return checks;
}

/**
 * Stage 2: flash LLM 语义验证
 */
async function stage2LlmCheck(groups: AcGroup[], title: string): Promise<GateCheck[]> {
  if (!modelGateway.isAvailable()) {
    return [{ name: 'stage2-skip', passed: true, message: 'LLM 不可用，跳过语义验证' }];
  }

  const groupsJson = JSON.stringify(groups.map(g => ({
    id: g.id,
    acs: g.acs,
    files: g.files,
    dependencies: g.dependencies,
  })), null, 2);

  const prompt = `你是需求评审专家。检查以下 AC 组是否适合 flash 模型并行执行。

## 任务
${title}

## AC 组
${groupsJson}

请逐组检查：

1. **AC 独立性**: 这组能独立完成吗？还是需要其他组先完成？
2. **隐式依赖**: 有没有没声明的依赖？（例如：B 组需要调用 A 组新建的函数）
3. **文件冲突**: 文件列表是否准确？有没有遗漏会和其他组冲突的文件？
4. **描述具体性**: AC 描述够具体吗？flash 模型能根据描述直接写代码吗？

输出 JSON:
{
  "groups": [{
    "id": "组名",
    "independent": true,
    "missingDeps": ["应依赖但未声明的组名"],
    "missingFiles": ["应该列但没列的文件"],
    "acsTooVague": ["描述不够具体的 AC 索引"]
  }],
  "overallOK": true
}`;

  try {
    const result = await modelGateway.promptJson<{
      groups: Array<{ id: string; independent: boolean; missingDeps: string[]; missingFiles: string[]; acsTooVague: number[] }>;
      overallOK: boolean;
    }>(prompt, '你是需求评审专家。严格检查 AC 组质量。');

    const checks: GateCheck[] = [];

    for (const g of result.groups) {
      if (!g.independent) {
        checks.push({ name: 'not-independent', passed: false, message: `组 "${g.id}" 不能独立执行` });
      }
      for (const dep of g.missingDeps || []) {
        checks.push({ name: 'missing-dep', passed: false, message: `组 "${g.id}" 缺少对 "${dep}" 的依赖声明` });
      }
      for (const f of g.missingFiles || []) {
        checks.push({ name: 'missing-file', passed: false, message: `组 "${g.id}" 缺少文件 "${f}"` });
      }
      for (const acIdx of g.acsTooVague || []) {
        checks.push({ name: 'vague-ac', passed: false, message: `组 "${g.id}" 第 ${acIdx + 1} 个 AC 描述不够具体` });
      }
    }

    if (result.overallOK && checks.length === 0) {
      checks.push({ name: 'stage2-summary', passed: true, message: 'LLM 语义验证通过 — AC 组适合并行执行' });
    }

    return checks;
  } catch (e: any) {
    logger.warn('[RequirementGate] LLM check failed, passing', { error: String(e) });
    return [{ name: 'stage2-error', passed: true, message: 'LLM 语义验证失败（非阻塞），手动审核建议' }];
  }
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

  // Stage 2
  const stage2 = stage1Passed ? await stage2LlmCheck(groups, title) : [];
  const stage2Passed = stage2.length === 0 || stage2.every(c => c.passed);

  const stage0Passed = stage0.length === 0 || stage0.every(c => c.passed);
  const passed = stage0Passed && stage1Passed && stage2Passed;

  // Tier 升级建议
  let tierRecommendation: TierRecommendation = 'flash-ok';
  const hasCodeIssues = stage1.some(c => !c.passed && ['file-not-found', 'dep-not-found'].includes(c.name));
  const hasAcGranularityIssue = stage1.some(c => !c.passed && c.name === 'ac-granularity');
  const hasFileConflictIssue = stage1.some(c => !c.passed && c.name === 'file-conflict');
  const hasLlmIssues = stage2.some(c => !c.passed);

  if (hasCodeIssues) {
    tierRecommendation = 'needs-human'; // 文件不存在/依赖组不存在 → LLM 改不了
  } else if (hasAcGranularityIssue) {
    tierRecommendation = 'needs-human'; // AC 太多 → 需要人工拆
  } else if (hasFileConflictIssue || hasLlmIssues) {
    tierRecommendation = 'upgrade-to-premium'; // 隐式依赖/文件缺失 → premium 可修正
  }

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
  if (tierRecommendation === 'upgrade-to-premium') {
    suggestions.push('💡 建议升级为 premium 模型重新分析此 RequirementsDoc');
  } else if (tierRecommendation === 'needs-human') {
    suggestions.push('⚠️ 自动修正无法解决，请在 Channel 中 @Analyst 提出修正，或将任务拆分更细');
  }

  return { passed, stage1, stage2, suggestions, tierRecommendation };
}
