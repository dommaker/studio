/**
 * prompt/上下文组装编排（2026-08 从 agent-loop.agentStep 抽出；#671 按组装段拆分）：
 * agentStep 的 prompt 组装与上下文注入段 —— hint/traceId 邻接的 hint 读取、
 * base prompt 选择（pendingReplies > newReplies > continue）、三类 guard hint 注入、
 * 注入段分段软定额 + 池内余量共享（#91），以及 hint 消费清除增量。
 *
 * 职责边界：
 *   - 本文件 = 编排：composeStepPrompt 段序与池共享（runSection）、hint 读取/消费清除、
 *     base prompt 选择、knowledge 段组装（injectContext 调用与 usage 回传）、files 截断播报。
 *     （#172/#60：skill_used 曝光发射已删除——skill_used 唯一语义 = loadSkill 加载。）
 *   - 段组装实现按段各居其文件：prompt-section-{persona,roster,skill,map,memory,files,
 *     contract,handoff}.ts；定额/截断共享件居 prompt-quota.ts。
 *   - agent-loop.agentStep = 编排：traceId/channelVersion 读取（下游仍消费，留在 agentStep）→
 *     调 composeStepPrompt → 会话管理 → worktree 准备 → 执行与簿记。
 *
 * 可测试性：role/acceptedTypes/fileStore/事件文件路径全部经 deps 注入；
 * knowledgePorts.consume 为模块级窄口直接 import（现有测试以 vi.mock 工厂替换
 * knowledge barrel，同一模块 ID 解析到同一绝对路径，mock 照常生效）。
 */

import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { estimateTokens } from '@dommaker/harness';
import { knowledgePorts } from '../knowledge/index.js';
import { loadRecoveryPacket, postWuSystemMessage } from '../workunit/index.js';
import type { WorkUnitData, WorkUnitMetadata } from '../workunit/index.js';
import { buildContinuePrompt, buildReplyPrompt } from './agent-loop-parsers.js';
import { metricsFileStore } from './agent-loop-events.js';
import { getErrorMessage } from '../../utils/errors.js';
import { SECTION_QUOTAS, type InjectSectionName, type BuiltSection } from './prompt-quota.js';
import { buildPersonaSection } from './prompt-sections/prompt-section-persona.js';
import { buildRosterSection } from './prompt-sections/prompt-section-roster.js';
import { buildSkillSection } from './prompt-sections/prompt-section-skill.js';
import { buildPmoMapSection } from './prompt-sections/prompt-section-map.js';
import { buildMemorySection } from './prompt-sections/prompt-section-memory.js';
import { buildFilesSection } from './prompt-sections/prompt-section-files.js';
import { buildContractSection } from './prompt-sections/prompt-section-contract.js';
import { buildHandoffSection, WAITING_QUESTION_REPLAY_MAX_CHARS } from './prompt-sections/prompt-section-handoff.js';
import { logger } from '@dommaker/studio-shared/node';

// #671：拆分前公共面 re-export——定额表 / 段模板 / 段常量原经本文件导出，拆后出口不变
export { SECTION_QUOTAS } from './prompt-quota.js';
export { MAP_DECISIONS_MAX, MAP_SUMMARY_MAX_CHARS } from './prompt-sections/prompt-section-map.js';
export { WAITING_QUESTION_REPLAY_MAX_CHARS } from './prompt-sections/prompt-section-handoff.js';
export {
  PLAN_DIRECTION_SECTION,
  PLAN_DIRECTION_DISABLED_HINT,
  CONTRACT_TEMPLATES,
  INSPECTION_CONTRACT,
} from './prompt-sections/prompt-section-contract.js';

/** prompt 组装输入。metadata 为 agentStep 入口解析的持久化视图（hint 消费读取同一来源）。 */
export interface PromptComposerCtx {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  /** §4.2 观察层新回复的消息正文（target.newReplies.map(r => r.content)），优先级低于 pendingReplies */
  newReplies?: string[];
  /** #95: 本步是否新建会话（续用不命中）。true 且 stepCount>0 时注入「前序进展」段 + 回放 waitingQuestion */
  isNewSession?: boolean;
}

/** prompt 组装外部依赖（loop 绑定状态下传；度量事件路径惰性解析，测试可改 env 生效）。 */
export interface PromptComposerDeps {
  role: AgentProfileData;
  acceptedTypes: string[];
  fileStore: FileStore;
  /** studio-events.jsonl 路径解析（#654：归一 resolveStudioEventsFile，认 STUDIO_EVENTS_FILE，测试隔离用） */
  resolveEventsFile: () => string;
}

export interface ComposedStepPrompt {
  prompt: string;
  /** F5: 恢复挂起时由 message-routing 写入的人类回复（已注入 prompt；
   *  调用方 recordExecutionOutcome 的会话提取 conversation 仍消费） */
  pendingReplies: string[];
  knowledgeContext: string;
  /** 实际进入注入段的 skill 名（调用方落盘 metadata.matchedSkills 供度量） */
  skillMatched: string[];
  /** R1 反馈环：injectContext 返回的注入知识条目 id（贯穿到 recordOutcome 的 consumedKnowledge） */
  injectedKnowledgeIds: string[];
  /** 已消费 hint 的清除增量（undefined 在 JSON 序列化时丢弃），由 agentStep 合进 metadataUpdates */
  consumedHintUpdates: Partial<WorkUnitMetadata>;
}

/**
 * 组装本 step 的 prompt 与注入上下文：
 *  1. hint 读取（pendingReplies / commitGuardHint / verifyFailHint / childGuardHint / processCheckHint / diffEmptyHint / contractArtifactHint，注入后即消费）；
 *  2. base prompt：pendingReplies > target.newReplies > continue；
 *  3. 三类 guard hint 段注入；
 *  4. 注入段分段软定额 + 池内余量共享（#91），稳定前缀序 persona > roster > skills > map > memory > knowledge > files（#285），
 *     尾组序 base > contract（#119）> handoff > hint；
 *  5. 产出 consumedHintUpdates（已消费 hint 的清除增量）。
 * 全部注入路径 non-blocking：任一段失败按空段处理，绝不阻断执行。
 */
export async function composeStepPrompt(
  ctx: PromptComposerCtx,
  deps: PromptComposerDeps,
): Promise<ComposedStepPrompt> {
  const { wu, metadata } = ctx;

  // F5: 恢复挂起时由 message-routing 写入的人类回复（优先级最高，注入后即消费）
  const pendingReplies = Array.isArray(metadata.pendingReplies)
    ? metadata.pendingReplies.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];

  // §10.5 提交守卫：上一轮 COMPLETE 被打回时 recordResult 写入的提示（注入后即消费）
  const commitGuardHint = typeof metadata.commitGuardHint === 'string' && metadata.commitGuardHint.length > 0
    ? metadata.commitGuardHint
    : null;

  // B3b-i 自动验证：上一轮 COMPLETE 因验证失败被打回时 recordResult 写入的提示（注入后即消费）
  const verifyFailHint = typeof metadata.verifyFailHint === 'string' && metadata.verifyFailHint.length > 0
    ? metadata.verifyFailHint
    : null;

  // §6-2 父 complete 守卫：上一轮 COMPLETE 因子任务未完结被打回时的提示（注入后即消费）
  const childGuardHint = typeof metadata.childGuardHint === 'string' && metadata.childGuardHint.length > 0
    ? metadata.childGuardHint
    : null;

  // T7-E2（#161）软观测守卫：上一轮 COMPLETE 过程检查违规合并提示（不阻断完成，注入后即消费）
  const processCheckHint = typeof metadata.processCheckHint === 'string' && metadata.processCheckHint.length > 0
    ? metadata.processCheckHint
    : null;

  // 收口闸 1（产出实）：上一轮 COMPLETE 因空 diff（base..HEAD 无提交内容）被打回时的提示（注入后即消费）
  const diffEmptyHint = typeof metadata.diffEmptyHint === 'string' && metadata.diffEmptyHint.length > 0
    ? metadata.diffEmptyHint
    : null;

  // 收口闸 2（产出实）：上一轮 COMPLETE 因契约产物缺失被打回时的提示（注入后即消费）
  const contractArtifactHint = typeof metadata.contractArtifactHint === 'string' && metadata.contractArtifactHint.length > 0
    ? metadata.contractArtifactHint
    : null;

  // #95: 仅新会话回放 waitingQuestion（截 300 字符）并入人类回复段——断链后 agent 忘了自己提过什么问题
  const replyTexts = pendingReplies.length > 0
    && ctx.isNewSession === true
    && typeof metadata.waitingQuestion === 'string'
    && metadata.waitingQuestion.trim().length > 0
    ? [`（你此前提出的问题：${metadata.waitingQuestion.slice(0, WAITING_QUESTION_REPLAY_MAX_CHARS)}）`, ...pendingReplies]
    : pendingReplies;
  const basePrompt = replyTexts.length > 0
    ? buildReplyPrompt(wu, replyTexts)
    : ctx.newReplies?.length
      ? buildReplyPrompt(wu, ctx.newReplies)
      : buildContinuePrompt(wu);
  // #95: hint（guard hint）段延后组装 —— 前序进展段挂载在 base 之后、hint 之前
  const hintBlocks = [
    commitGuardHint ? `## 提交提醒\n\n${commitGuardHint}` : null,
    verifyFailHint ? `## 验证失败\n\n${verifyFailHint}` : null,
    childGuardHint ? `## 子任务提醒\n\n${childGuardHint}` : null,
    processCheckHint ? `## 过程检查提醒\n\n${processCheckHint}` : null,
    diffEmptyHint ? `## 提交内容提醒\n\n${diffEmptyHint}` : null,
    contractArtifactHint ? `## 契约产物提醒\n\n${contractArtifactHint}` : null,
  ].filter((s): s is string => s !== null).join('\n\n');

  // #91: 分段软定额 + 池内余量共享 —— 段有效预算 = 定额 + 池；用量差额回流池中。
  // 任一段截断落 prompt:section_trimmed 事件（fire-and-forget，供定额初值校准）。
  let pool = 0;
  const runSection = async <T extends BuiltSection>(
    name: InjectSectionName,
    build: (budget: number) => Promise<T>,
  ): Promise<T | BuiltSection> => {
    const quota = SECTION_QUOTAS[name];
    const budget = quota + pool;
    let built: T | BuiltSection;
    try {
      built = await build(budget);
    } catch (e) {
      // Non-blocking: agent continues without this section — 但必须有声
      // （#611：原静默 catch 是 R4 bug 潜伏数月无人察觉的土壤）
      logger.warn('[prompt-composer] section build failed (non-blocking)', {
        section: name,
        error: getErrorMessage(e),
      });
      built = { section: '', tokens: 0, originalTokens: 0 };
    }
    if (built.originalTokens > built.tokens) {
      void metricsFileStore.appendJsonl(deps.resolveEventsFile(), {
        type: 'prompt:section_trimmed',
        source: 'prompt-composer',
        payload: JSON.stringify({
          section: name,
          originalTokens: built.originalTokens,
          trimmedTokens: built.tokens,
          quota,
          // #285: files 段截断明细（keptCount/droppedPaths/droppedCount），其他段不受影响
          ...(built.trimDetail ?? {}),
        }),
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
    pool = Math.max(0, budget - built.tokens);
    return built;
  };

  // #119 稳定性重排：稳定前缀（进 knowledgeContext，吃输入缓存）序 = persona → roster → skills
  // → map → memory → knowledge → files（#285）；任务本体尾组（拼 prompt）序 = base → contract → handoff → hint。
  // 段组装顺序即池共享顺序（前段余量流入后段），与稳定前缀序一致。

  // 决策 13 + #91: `## 你的角色` 段（persona ?? description + preset 的 skills/tools/constraints；皆空则省略）
  const persona = await runSection('persona', budget => Promise.resolve(buildPersonaSection(deps.role, budget)));

  // A2A §4.1 机制 2: 成员花名册段（## 频道成员与委派）
  const roster = await runSection('roster', budget => buildRosterSection(wu, deps, budget));

  // 决策 7/11: skill 段（## 本次任务 Skills）step 时计算，吃 skill 库最新版
  interface SkillSection extends BuiltSection { matched: string[] }
  const skills = await runSection<SkillSection>('skills', budget => buildSkillSection(wu, deps, budget));
  const skillMatched = 'matched' in skills ? skills.matched : [];

  // #111 T5: PMO 地图完整段（## PMO 地图）——#119 起移入稳定前缀（skills 后、memory 前），
  // 不再拼进 prompt 尾部。
  const pmoMap = await runSection('map', budget => buildPmoMapSection(metadata, budget));

  // #100: memory 段内容源 = 角色记忆索引常驻注入（per-role MEMORY.md 索引全文，依赖 #98 存储服务）
  const memory = await runSection('memory', budget => buildMemorySection(deps.role.id, budget));

  // GAP-5 + R1 反馈环: knowledge 段 —— injectContext 内部按 maxTokens（= 定额 + 池余量）截断，
  // 截断尺寸经 usage 回传（originalTokens > keptTokens 即发生了段内截断）。
  let injectedKnowledgeIds: string[] = [];
  const knowledge = await runSection('knowledge', async budget => {
    const injected = await knowledgePorts.consume.injectContext(wu.type, {
      tags: [wu.type],
      maxTokens: budget,
    });
    injectedKnowledgeIds = injected.injectedIds ?? [];
    const keptTokens = injected.usage?.keptTokens ?? estimateTokens(injected.prompt);
    return {
      section: injected.prompt,
      tokens: keptTokens,
      originalTokens: injected.usage?.originalTokens ?? keptTokens,
    };
  });
  const knowledgeSection = knowledge.section;

  // #285（决策 #257 D1）：files 段（## 引用文件）——稳定前缀最末，knowledge 之后、contract 之前
  // 组装（段组装顺序 = 池共享顺序，files 参与池内余量共享）。
  const files = await runSection('files', budget =>
    Promise.resolve(buildFilesSection(metadata, budget)));
  const filesTrimDetail = 'trimDetail' in files ? files.trimDetail : undefined;

  // #285（决策 #257 D4 用户面）：files 段截断 → 向 WU 所在频道播报一次（best-effort 不阻断）。
  // 只在第一步播报（metadata.stepCount 缺失或为 0；fileRefs 全程稳定，逐步播报会刷屏）；
  // wu.channelId 缺失不播报。
  const stepCount = typeof metadata.stepCount === 'number' ? metadata.stepCount : 0;
  if (filesTrimDetail && filesTrimDetail.droppedCount > 0 && stepCount === 0 && wu.channelId) {
    void postWuSystemMessage(
      wu,
      `引用文件较多，已注入前 ${filesTrimDetail.keptCount} 条`,
      { fileStore: deps.fileStore },
    ).catch(err =>
      logger.warn('[prompt-composer] Post files-trimmed notice failed (non-blocking)', {
        workUnitId: wu.id, error: String(err),
      })
    );
  }

  // #119: 契约段（## 产出契约）——按 WU type 产出格式 + 最小模板，挂 base 后、handoff 前。
  const contract = await runSection('contract', budget =>
    Promise.resolve(buildContractSection(wu, metadata, budget)));

  // #711：有 StepRecord 的新会话注入结构化恢复包；旧单保留 #95 前序进展回退。
  const handoff = await runSection('handoff', async budget => {
    const recovery = ctx.isNewSession === true
      ? await loadRecoveryPacket(deps.fileStore, wu)
      : null;
    return buildHandoffSection(
      metadata, ctx.isNewSession === true, budget,
      recovery && recovery.steps.length > 0 ? recovery : null,
    );
  });

  const leadSections = [persona.section, roster.section, skills.section, pmoMap.section, memory.section]
    .filter(s => s.length > 0)
    .join('\n\n');
  // `## 项目上下文` 包装头仅在前置段存在时添加（沿用原组装口径）
  let knowledgeContext = knowledgeSection;
  if (leadSections) {
    knowledgeContext = knowledgeSection
      ? `${leadSections}\n\n## 项目上下文\n${knowledgeSection}`
      : leadSections;
  }
  // #285（D1）：files 段拼进 knowledgeContext 尾部（稳定前缀最末）
  if (files.section) {
    knowledgeContext = knowledgeContext ? `${knowledgeContext}\n\n${files.section}` : files.section;
  }

  // #119: 尾组序 = base → contract → handoff → hint（map 已移入稳定前缀 knowledgeContext）
  let prompt = basePrompt;
  if (contract.section) prompt = `${prompt}\n\n${contract.section}`;
  if (handoff.section) prompt = `${prompt}\n\n${handoff.section}`;
  if (hintBlocks) prompt = `${prompt}\n\n${hintBlocks}`;

  const consumedHintUpdates: Partial<WorkUnitMetadata> = {};
  if (pendingReplies.length > 0) {
    // F5: 回复已注入 prompt，清除避免后续步骤重复注入（undefined 在 JSON 序列化时丢弃）
    consumedHintUpdates.pendingReplies = undefined;
  }
  if (commitGuardHint) {
    // §10.5: 提示已注入 prompt，清除避免后续步骤重复注入
    consumedHintUpdates.commitGuardHint = undefined;
  }
  if (verifyFailHint) {
    // B3b-i: 提示已注入 prompt，清除避免后续步骤重复注入
    consumedHintUpdates.verifyFailHint = undefined;
  }
  if (childGuardHint) {
    // §6-2: 提示已注入 prompt，清除避免后续步骤重复注入
    consumedHintUpdates.childGuardHint = undefined;
  }
  if (processCheckHint) {
    // T7-E2: 提示已注入 prompt，清除避免后续步骤重复注入
    consumedHintUpdates.processCheckHint = undefined;
  }
  if (diffEmptyHint) {
    // 收口闸 1: 提示已注入 prompt，清除避免后续步骤重复注入
    consumedHintUpdates.diffEmptyHint = undefined;
  }
  if (contractArtifactHint) {
    // 收口闸 2: 提示已注入 prompt，清除避免后续步骤重复注入
    consumedHintUpdates.contractArtifactHint = undefined;
  }

  return { prompt, pendingReplies, knowledgeContext, skillMatched, injectedKnowledgeIds, consumedHintUpdates };
}
