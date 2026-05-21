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
    if (g.acs.length > 6) {
      checks.push({
        name: 'ac-granularity',
        passed: false,
        message: `组 "${g.id}" 有 ${g.acs.length} 个 AC，超过 6 个上限。flash 模型一次执行 ≤6 AC。请拆分为更小的组`,
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
    for (const sub of ['apps/api', 'apps/web', 'packages/studio-shared', 'packages/studio-agent', 'packages/studio-skill', 'packages/studio-prisma']) {
      const candidate = path.join(repoDir, sub);
      if (fs.existsSync(candidate)) tryDirs.push(candidate);
    }

    for (const clean of realFiles) {
      let found = false;
      for (const base of tryDirs) {
        const fullPath = path.join(base, clean);
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
): Promise<GateResult> {
  const suggestions: string[] = [];

  // Stage 1
  const stage1 = stage1CodeCheck(groups, repoDir);
  const stage1Passed = stage1.every(c => c.passed);

  // Stage 2
  const stage2 = stage1Passed ? await stage2LlmCheck(groups, title) : [];
  const stage2Passed = stage2.length === 0 || stage2.every(c => c.passed);

  const passed = stage1Passed && stage2Passed;

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

  // Build suggestions
  for (const c of [...stage1, ...stage2]) {
    if (!c.passed) suggestions.push(c.message);
  }

  // Add tier recommendation
  if (tierRecommendation === 'upgrade-to-premium') {
    suggestions.push('💡 建议升级为 premium 模型重新分析此 RequirementsDoc');
  } else if (tierRecommendation === 'needs-human') {
    suggestions.push('⚠️ 自动修正无法解决，请在 Channel 中 @Analyst 提出修正，或将任务拆分更细');
  }

  return { passed, stage1, stage2, suggestions, tierRecommendation };
}
