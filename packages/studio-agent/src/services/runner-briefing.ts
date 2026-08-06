/**
 * Runner Briefing — "agent 被告知的內容"的 worktree 文件桥
 *
 * Wave-4: 从 worktree-resolver.ts 拆出。worktree-resolver 只保留
 * git/依赖生命周期（resolveWorkspace/createWorktree/ensureWuWorktree/ensureDeps/
 * propagateHarnessConfig）；本模块负责把 prompt 上下文物化为 worktree 文件：
 *   - buildCachePrefix   → CACHE_PREFIX.md（跨 worktree 字节一致，命中 prefix cache）
 *   - writeRequirementsMd → REQUIREMENTS.md（AC/架构上下文/验证命令）
 *   - writeContractTests  → __tests__/（Analyst 契约测试，RED→GREEN）
 *
 * 与 runner-params.ts（buildPrompt 等纯函数，不落盘）配套：prompt 文本引用
 * REQUIREMENTS.md，两侧共同定义"agent 被告知的內容"。
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { logger } from '@dommaker/studio-shared';

import type { AgentTask } from './types.js';

/**
 * Build shared cache prefix — byte-identical across all worktrees
 * so DeepSeek's prefix cache matches across pipeline agent sessions.
 */
export function buildCachePrefix(repoDir: string): string {
  // 探测包管理器
  const pkgManager = fsSync.existsSync(path.join(repoDir, 'pnpm-lock.yaml')) ? 'pnpm'
    : fsSync.existsSync(path.join(repoDir, 'yarn.lock')) ? 'yarn' : 'npm';

  const installCmd = pkgManager === 'pnpm' ? 'pnpm install'
    : pkgManager === 'yarn' ? 'yarn install' : 'npm install';
  const testCmd = pkgManager === 'pnpm' ? 'pnpm test'
    : pkgManager === 'yarn' ? 'yarn test' : 'npm test';

  const lines = [
    '<!-- SHARED_CACHE_PREFIX — DO NOT EDIT — identical across all worktrees -->',
    '',
    '# Project Context (shared)',
    '',
    '## 环境',
    `- 包管理器: ${pkgManager}`,
    `- 安装依赖: \`${installCmd}\``,
    `- 运行测试: \`${testCmd}\``,
    '- 类型检查: `npx tsc --noEmit`',
    '- 依赖已预装（node_modules 通过 hardlink 缓存）。',
    '- **禁止自己跑 install**：node_modules 已存在。如果 import 报错，检查是否是自己修改了代码导致的，修复代码而非安装依赖。',
    '',
  ];
  try {
    const claudeMd = fsSync.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf-8');
    lines.push(claudeMd);
  } catch { /* CLAUDE.md may not exist in the repo */ }
  lines.push('');
  return lines.join('\n');
}

/**
 * 写入 REQUIREMENTS.md（session 间共享的 AC 上下文）
 */
export async function writeRequirementsMd(
  worktree: string,
  task: AgentTask,
  acGroup?: Record<string, any>,
  testFiles?: string[],
): Promise<void> {
  const acs: string[] = acGroup?.acs || [];
  const files: string[] = acGroup?.files || [];
  const notes: string = acGroup?.implementationNotes || '';
  const patterns: string[] = acGroup?.codePatterns || [];
  const gotchas: string[] = acGroup?.gotchas || [];
  const archCtx = acGroup?.architectureContext as Record<string, any> | undefined;

  const isSimple = files.length <= 1 && acs.length <= 3 && gotchas.length <= 2;

  const sections = [
    '# 需求',
    ...(isSimple ? [
      '> ⚡ **简单改动** — Analyst 已验证。直接执行，不探索。',
      '> 步骤：读目标文件 → 按实现指南改 → tsc → npm test → .progress.json',
      '',
    ] : []),
    `## 任务`,
    task.prompt,
    '',
    '## 你负责的验收标准',
    ...(acs.length > 0 ? acs.map((ac, i) => `${i + 1}. ${ac}`) : ['（从任务描述中推断）']),
    '',
    // ── 架构上下文（Analyst 已探索，你不需要重新读 CLAUDE.md）──
    ...(archCtx ? ['## 架构上下文（Analyst 已探索并验证）', '', '**下面的信息已经过 Analyst 代码探索验证。直接使用，不需要自己重新读文件。** 只在出现矛盾时才验证。', ''] : []),
    ...(archCtx?.functions?.length ? ['### 关键函数', ...archCtx.functions.map((f: string) => `- ${f}`), ''] : []),
    ...(archCtx?.callChain ? ['### 调用链', archCtx.callChain, ''] : []),
    ...(archCtx?.imports?.length ? ['### 需要导入', ...archCtx.imports.map((i: string) => `\`\`\`${i}\`\`\``), ''] : []),
    ...(archCtx?.typesInScope?.length ? ['### 相关类型', ...archCtx.typesInScope.map((t: string) => `- ${t}`), ''] : []),
    ...(archCtx?.dangerZones?.length ? ['### ⚠️ 禁区（不要触碰）', ...archCtx.dangerZones.map((d: string) => `- ${d}`), ''] : []),
    ...(archCtx?.testMock?.length ? ['### 测试 mock 模板', ...archCtx.testMock.map((m: string) => `\`\`\`typescript\n${m}\n\`\`\``), ''] : []),
    ...(archCtx?.verifiedAt ? [`*以上信息验证于 commit ${archCtx.verifiedAt}*`, ''] : []),
    ...(notes ? ['## 实现指南', notes, ''] : []),
    ...(patterns.length ? ['## 参考模式', ...patterns.map(p => `- ${p}`), ''] : []),
    ...(gotchas.length ? ['## ⚠️ 注意事项', ...gotchas.map(g => `- ${g}`), ''] : []),
    ...(files.length > 0 ? ['## 预期改动文件', ...files.map(f => `- ${f}`), ''] : []),
    // SP-004 Step 5: testFiles from SDD task layer (GREEN phase verification)
    ...(testFiles && testFiles.length > 0 ? [
      '## 验证测试文件（GREEN 阶段必须全部通过）',
      ...testFiles.map(f => `- \`${f}\``),
      '',
      `运行命令: \`npx vitest run ${testFiles.join(' ')}\``,
      '',
    ] : []),
    '## 行为约束',
    ...(testFiles && testFiles.length > 0
      ? ['- 完成前必须运行上述指定测试文件 + type check + lint']
      : ['- 完成前必须运行 npm test + type check + lint']),
    '- 禁止模糊声明完成',
    '- 每完成一个步骤后立即更新 .progress.json',
    '- 全部 AC 测试通过后才设置 .progress.json allComplete: true',
    '- **Phase 3: 禁止创建新的 .test.ts / .spec.ts 文件**（测试由 Analyst + Reviewer 提供，你只实现代码让测试通过）',
    `- 将测试证据写入 .progress.json.testResults: { passed, total, failed: 0, command: "${testFiles && testFiles.length > 0 ? `npx vitest run ${testFiles.join(' ')}` : 'npm test'}", evidence: "<测试输出>" }`,
    '- 将设计决策写入 .progress.json.designNotes: { decisions: ["选X不选Y因为Z"], failedAttempts: ["试过A遇到B问题"], uncertainties: ["C部分需要特别关注"], constraintsDiscovered: ["实现中发现AC未覆盖的限制D"] }',
    '- designNotes 只记录对 Review 有意义的决策信息，不写琐碎细节',
  ];

  await fs.writeFile(path.join(worktree, 'REQUIREMENTS.md'), sections.join('\n'), 'utf-8');
}

/**
 * TDD-07: 写入 Analyst 的契约测试到 worktree __tests__/
 *
 * RequirementsDoc.contractTests 包含按 AC 组组织的可执行测试代码。
 * 测试在写入时处于 RED 状态（全部 FAIL），Executor 实现后变为 GREEN。
 */
export async function writeContractTests(
  worktree: string,
  contractTests: Array<{ file: string; content: string }>,
): Promise<void> {
  if (!contractTests?.length) return;

  const testsDir = path.join(worktree, '__tests__');
  await fs.mkdir(testsDir, { recursive: true });

  for (const test of contractTests) {
    const testPath = path.join(worktree, test.file);
    const testDir = path.dirname(testPath);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(testPath, test.content, 'utf-8');
    logger.info('[WorktreeResolver] Contract test written', { file: test.file, size: test.content.length });
  }
}
