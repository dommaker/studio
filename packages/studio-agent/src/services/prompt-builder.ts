/**
 * Prompt Builder — Agent prompt 构建（session-manager.ts 拆分模块）
 *
 * 2026-08-04: 从 session-manager.ts 按职责拆出的 prompt 构建逻辑：
 *   Session 1: 全量 prompt（约束注入 + 输出风格 + skill 注入 + Analyst 上下文）
 *   Session 2+: 极短续接（文件桥，上下文靠 worktree 文件）
 *   卡住时按 STRATEGY_HINTS 逐级注入策略切换指令
 *
 * 零行为变更：函数体自 AgentExecutor.buildPrompt() 平移；不依赖实例状态。
 */

import { logger } from '@dommaker/studio-shared';
import { buildAgentConstraintPrompt } from '@dommaker/studio-shared/harness/hooks';
import { skillLoader } from '@dommaker/studio-skill';

import type { ProgressReport } from './output-capture.js';
import type { AgentTask } from './session-manager.js';

/** 策略切换指令 — 逐级升级 */
const STRATEGY_HINTS: Record<number, string> = {
  0: '',
  1: `⚠️ 上次 session 停在同一个步骤无进展。不要重复相同的尝试。换一种实现思路，先解释你打算尝试的新方法（2-3 句），再动手。`,
  2: `⚠️⚠️ 已经连续 2 次卡在同一处。缩小范围：只做当前步骤最核心的部分，跳过边缘情况。写完最小实现后立即跑测试验证。`,
  3: `⚠️⚠️⚠️ 严重阻塞 — 连续 3 次无进展。强制切换模式：1) 先不要写代码，读 REQUIREMENTS.md 和现有代码；2) 写出 3 步以内的 mini plan；3) 只实现第 1 步，跑测试；4) 跑通后再继续`,
  4: `🔴 最后一次机会 — 放弃当前方向，从第 0 行重新开始，用最简单、最朴素的方式实现（哪怕代码丑），先让测试通过。`,
};

/**
 * 构建 Agent prompt
 *
 * Session 1: 简要指令 + 读 REQUIREMENTS.md
 * Session 2+: 极短续接（文件桥，上下文靠 worktree 文件）
 * 卡住时注入策略切换指令
 */
export function buildPrompt(
  task: AgentTask,
  progress: ProgressReport | null,
  session: number,
  acGroup?: Record<string, any>,
  stuckCount = 0,
  knowledgeContext?: string,
  resolutionHint?: string,
  role: 'analyst' | 'executor' | 'reviewer' | 'integration' | 'deploy' = 'executor',
): string {
  // 约束注入
  const constraintPrompt = buildAgentConstraintPrompt({
    operation: 'code_implementation',
    taskDescription: task.prompt,
  });

  const rawConstraints = task.parameters?.roleConstraints;
  const roleConstraints: string[] = Array.isArray(rawConstraints) ? rawConstraints
    : typeof rawConstraints === 'string' ? JSON.parse(rawConstraints)
    : [];
  const roleConstraintSection = roleConstraints.length
    ? `\n## 角色约束\n以下约束优先于一般指导原则：\n${roleConstraints.map((c: string) => `- ${c}`).join('\n')}\n`
    : '';

  // G-001~003: 知识上下文（偏好 + 规则 + 环境 + 历史决策）
  const knowledgeSection = knowledgeContext
    ? `\n## 项目上下文\n${knowledgeContext}\n`
    : '';

  const constraintSection = constraintPrompt || roleConstraintSection || knowledgeSection
    ? (constraintPrompt + roleConstraintSection + knowledgeSection + '\n---\n\n')
    : '';

  // O2f/O2g: Output style compression per Agent role
  const OUTPUT_STYLE_MAP: Record<string, string> = {
    analyst: 'Output style: Be concise. Drop filler words (just, really, basically). No sycophantic openers or closing fluff. Keep complete sentences. Technical terms exact.',
    executor: 'Output style: Terse like caveman. Drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK. Short synonyms. Code blocks unchanged. Technical substance exact.',
    reviewer: 'Output style: Terse like caveman. Drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK. Short synonyms. Code blocks unchanged. Technical substance exact.',
    integration: 'Output style: Ultra-terse. Maximum compression. Telegraphic style. Drop all non-essential words. Code output only — no explanation unless error.',
    deploy: 'Output style: Be concise. Drop filler words. No fluff. Keep complete sentences. Technical terms exact.',
  };
  const outputStyleSection = `## 输出风格\n${OUTPUT_STYLE_MAP[role] || OUTPUT_STYLE_MAP.executor}\n\n`;

  // O2i: Skill on-demand injection
  const skillsToInject = skillLoader.load({});
  const skillPrompt = skillLoader.formatForPrompt(skillsToInject);

  // [Skill Discovery] Log injected skills for Agent Network analysis
  logger.info(`[SkillDiscovery] task=${task.id} skills=[${skillsToInject.map(s => s.id).join(',')}]`);

  if (session === 1 || !progress) {
    // O1c: Inject Analyst context to prevent re-exploring verified files
    const analystContext = (task.parameters?.analystContext as any) || null;
    const analystContextSection = analystContext ? [
      '## 已有分析上下文（来自 Analyst 探索）',
      '',
      `**已验证文件** (不需要重新探索): ${(analystContext.verifiedFiles || []).join(', ')}`,
      analystContext.architectureContext ? `\n**架构说明**: ${analystContext.architectureContext}` : '',
      analystContext.gotchas?.length ? `\n**注意事项**: ${analystContext.gotchas.join('; ')}` : '',
      '',
      '只修改上述文件。如需查看额外文件，说明原因——Scheduler 将添加权限后继续。',
      '',
    ].join('\n') : '';

    const verifyStep = acGroup?.architectureContext
      ? '\n⚠️ REQUIREMENTS.md 包含架构上下文（Analyst 已探索的代码位置和签名）。\n第一步必须是验证关键函数签名和行号是否仍然有效，如果已偏移请修正后再实现。\n'
      : '';
    const base = `${constraintSection}${outputStyleSection}${analystContextSection}## 你的任务
${task.prompt}


读 REQUIREMENTS.md 了解你要完成的任务和验收标准。${verifyStep}
${skillPrompt}

## 完成后必须提交
所有 AC 满足且测试通过后，执行 git 操作：
1. \`git add\` 你修改的所有文件
2. \`git commit -m "feat: <简要描述改动>"\` 提交代码
3. 然后设置 allComplete: true
不要跳过 commit —— 代码未提交视为未完成。`;
    return resolutionHint ? `${base}\n\n${resolutionHint}` : base;
  }

  // Session 2+: 极短续接 prompt
  const hintLevel = Math.min(stuckCount, 4);
  const strategyHint = STRATEGY_HINTS[hintLevel];
  const parts = [
    `${constraintSection}${outputStyleSection}## 续接任务`,
    '',
    '读 REQUIREMENTS.md 了解任务。',
    '读 .progress.json 了解进度。',
    '',
    `你上次做到：${progress.currentStep || '未知'}`,
    `已完成：${progress.completedSteps?.join(', ') || '无'}`,
    `测试结果：${progress.testResults?.passed || 0} passed / ${progress.testResults?.failed || 0} failed`,
    `备注：${progress.notes || '无'}`,
  ];
  if (skillPrompt) parts.push('', skillPrompt);
  if (strategyHint) parts.push('', strategyHint);
  if (resolutionHint) parts.push('', resolutionHint);
  parts.push('', '继续工作，从上次中断的地方开始。每完成一步后更新 .progress.json。');
  parts.push('全部完成后 git add 你修改的文件 && git commit，然后设置 allComplete: true。');
  return parts.join('\n');
}
