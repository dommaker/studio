/**
 * prompt/上下文组装（2026-08 从 agent-loop.agentStep 抽出）：
 * agentStep 的 prompt 组装与上下文注入段 —— hint/traceId 邻接的 hint 读取、
 * base prompt 选择（pendingReplies > newReplies > continue）、三类 guard hint 注入、
 * 注入段分段软定额 + 池内余量共享（#91），以及 hint 消费清除增量。
 *
 * 职责边界：
 *   - 本模块 = prompt 组装政策：hint 读取/注入/消费清除、注入段定额分配与截断、
 *     skill_used / section_trimmed 度量落盘。build 段函数同为模块级私有函数。
 *   - agent-loop.agentStep = 编排：traceId/channelVersion 读取（下游仍消费，留在 agentStep）→
 *     调 composeStepPrompt → 会话管理 → worktree 准备 → 执行与簿记。
 *
 * 可测试性：role/acceptedTypes/fileStore/事件文件路径全部经 deps 注入；
 * knowledgeService 为模块级单例直接 import（现有测试以 vi.mock 工厂替换整个
 * knowledge-service 模块，同一模块 ID 解析到同一绝对路径，mock 照常生效）。
 */

import { parseChannels, FileStore, logger, type AgentProfileData } from '@dommaker/studio-shared';
import { TokenEstimator } from '@dommaker/harness';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { knowledgeService } from '../../knowledge/knowledge-service.js';
import { projectService } from '../../pmo/project.service.js';
import { roleMemoryStore } from '../../role-memory/role-memory.js';
import { loadManifest } from '../../skills/manifest-loader.js';
import { selectSkillsForInjection, parseSkillHintsFromScope } from '../../skills/skill-selector.js';
import { resolveMaxDepth, MAX_DELEGATIONS_PER_PARENT } from '../../workunit/delegation-gate.js';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import { buildContinuePrompt, buildReplyPrompt } from './agent-loop-parsers.js';
import { metricsFileStore } from './agent-loop-events.js';

/**
 * #91（#88 决策 2）：注入段分段软定额（替代单池 2K 优先级制）。
 * 定额职责 = 防注入劣化（防注入段膨胀挤占对话空间、防噪声稀释信噪比），
 * 不防 CLI 上下文溢出（溢出归反应式策略管）；base prompt 不截断，CLI 脚手架不在管辖内。
 *
 * 软定额 + 池内余量共享：按 persona → roster → skills → map → memory → knowledge → contract
 * → handoff 顺序逐段组装，段有效预算 = 本段定额 + 共享池余量；段实际用量低于有效预算时，
 * 差额流入共享池供后续段借用（注入总量封顶 = 定额总和 ~4.5K）。
 * map 段 = #111 T5 探路地图完整渲染（定额 800，实测校准见 .studio/CONTEXT.md 的 apps/api/src/modules/agents 锚点）。
 * contract 段 = #119 契约段生成器（定额 200，按 WU type 产出格式 + 最小模板）。
 * memory / handoff 段内容源分别归 #100（角色记忆索引常驻注入）与 #95（handoff 前序
 * 进展段）。
 */
export const SECTION_QUOTAS = {
  persona: 300,
  roster: 400,
  skills: 600,
  map: 800,
  memory: 300,
  knowledge: 1000,
  contract: 200,
  handoff: 800,
} as const;

type InjectSectionName = keyof typeof SECTION_QUOTAS;

/** #111 T5：地图段 decisions 渲染条数封顶 N（实测校准：典型 ~160tok，顶格偏重 ~720tok < 800 定额） */
export const MAP_DECISIONS_MAX = 10;
/** #111 T5：单条 decision summary 紧凑截断阈值（超出加省略号；顶格单行 ~43tok） */
export const MAP_SUMMARY_MAX_CHARS = 160;

/** #95：waitingQuestion 仅新会话回放的截断字符上限 */
export const WAITING_QUESTION_REPLAY_MAX_CHARS = 300;

/**
 * #119：契约段按 WU type 的产出格式 + 最小模板（内容定稿随 #118 续烤迭代，先落最简模板）。
 * review → REVIEW_RESULT 协议行；implement → 测试先行 + Phase commit 格式；
 * decision（决策单）→ 结论摘要格式；analysis → research/prototype 产出载体（T3/#125）。
 * #163（T8-E2）：analysis + metadata.inspection===true → 巡检契约（INSPECTION_CONTRACT，
 * 优先级高于 analysis 通用模板）。
 * 未列出的 type（task/feature/bug/spec 等）→ 空段（不注入）。
 */
export const CONTRACT_TEMPLATES: Record<string, string> = {
  review: [
    '完成审查后，除 ACTION 行外，还必须在输出的最后一行给出结构化结论：',
    'REVIEW_RESULT: {"verdict":"pass"|"reject"|"needs-info","summary":"一句话结论","issues":[{"severity":"error"|"warn"|"info","message":"问题描述"}]}',
    '（verdict=pass 通过 / reject 打回 / needs-info 上下文不足转人工；缺少该行将转人工评审。）',
  ].join('\n'),
  implement: [
    '测试先行：先写失败测试（RED）再实现到测试全绿（GREEN），测试全绿后才算完成。',
    'Phase commit：按阶段分批提交，commit message 用 `phase(<阶段名>): <摘要>` 格式。',
  ].join('\n'),
  decision: [
    '结论摘要格式：输出末段 `## 结论摘要`，用一句话给出待决问题的结论与理由。',
  ].join('\n'),
  analysis: [
    '方法论二选一（详见 skills 段 research / prototype 全文）：',
    'research → 调研报告落业务仓 .studio/research/，并在来源工单回挂报告链接。',
    'prototype → 一次性代码落 prototype/<name> 分支（不合并、不进评审），结论（回答了什么问题）记录回工单。',
  ].join('\n'),
};

/**
 * #163（T8-E2，#130 决策 2/3/7）：巡检单（analysis + metadata.inspection）专属契约——
 * 分片扫描、结论即落盘、机会清单协议行。人读面说人话：报告/频道消息不出现
 * WU/metadata/闸/熔断等机制黑话。
 */
export const INSPECTION_CONTRACT = [
  '巡检执行纪律：',
  '- 分片扫描：按目录/模块分片推进，每片扫完立即把结论追加写入报告文件（结论即落盘），不要在内存里攒到最后一次性输出。',
  '- 对象面：代码/文档/配置/测试气味（默认全仓四面；本单 metadata.inspectionScope 在场时按其裁剪）。运行时健康归监控探针、文档一致性归专项审查，都不在巡检范围。',
  '- 报告落业务仓 .studio/research/inspection-<日期>.md，并在来源工单回挂报告链接；报告与频道消息说人话，不出现内部机制术语。',
  '- 每条机会在输出尾部给出协议行（机器消费，报告正文照旧写人话细节）：',
  '  OPPORTUNITY: {"problem":"问题","suggestion":"建议","estimate":"预估（可省）"}',
].join('\n');

/** 单个注入段的组装产出：tokens = 截断后实际用量；originalTokens = 未截断的原始尺寸（> tokens 即发生了截断） */
interface BuiltSection {
  section: string;
  tokens: number;
  originalTokens: number;
}

/**
 * #150 A2: 按 token 预算截断文本（TokenEstimator 口径，替代 chars/4 反推 slice(0, budget*4)）。
 * 旧反推只在纯 ASCII 下成立：含中文文本按 TokenEstimator（≈1.5 字符/token）会超预算。
 * 二分求 estimateText 口径下最长的预算适配前缀，与估算器严格一致，不再复制启发式。
 */
function sliceToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  if (TokenEstimator.estimateText(text) <= tokenBudget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (TokenEstimator.estimateText(text.slice(0, mid)) <= tokenBudget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

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
  /** studio-events.jsonl 路径解析（STUDIO_EVENTS_JSONL 环境变量可覆盖，测试隔离用） */
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
 *  1. hint 读取（pendingReplies / commitGuardHint / verifyFailHint / childGuardHint / processCheckHint，注入后即消费）；
 *  2. base prompt：pendingReplies > target.newReplies > continue；
 *  3. 三类 guard hint 段注入；
 *  4. 注入段分段软定额 + 池内余量共享（#91），稳定前缀序 persona > roster > skills > map > memory > knowledge，
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
    } catch {
      // Non-blocking: agent continues without this section
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
        }),
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
    pool = Math.max(0, budget - built.tokens);
    return built;
  };

  // #119 稳定性重排：稳定前缀（进 knowledgeContext，吃输入缓存）序 = persona → roster → skills
  // → map → memory → knowledge；任务本体尾组（拼 prompt）序 = base → contract → handoff → hint。
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
    const injected = await knowledgeService.injectContext(wu.type, {
      tags: [wu.type],
      maxTokens: budget,
    });
    injectedKnowledgeIds = injected.injectedIds ?? [];
    const keptTokens = injected.usage?.keptTokens ?? TokenEstimator.estimateText(injected.prompt);
    return {
      section: injected.prompt,
      tokens: keptTokens,
      originalTokens: injected.usage?.originalTokens ?? keptTokens,
    };
  });
  const knowledgeSection = knowledge.section;

  // #119: 契约段（## 产出契约）——按 WU type 产出格式 + 最小模板，挂 base 后、handoff 前。
  const contract = await runSection('contract', budget =>
    Promise.resolve(buildContractSection(wu, metadata, budget)));

  // #95: handoff 前序进展段（续用不命中 + stepCount>0 时注入；挂载位 base 后/hint 前）
  const handoff = await runSection('handoff', budget =>
    Promise.resolve(buildHandoffSection(metadata, ctx.isNewSession === true, budget)));

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

  return { prompt, pendingReplies, knowledgeContext, skillMatched, injectedKnowledgeIds, consumedHintUpdates };
}

/**
 * #111 T5（接替 #107 T1 tracer bullet）：组装完整 `## PMO 地图` 段。
 * 紧凑文本：destination 一行 + 近 MAP_DECISIONS_MAX 条 decisions（新→旧，summary 超
 * MAP_SUMMARY_MAX_CHARS 截断加省略号）+ 开放 fog（open/in-discussion，resolved 不列）清单。
 * WU 无 pmoId / PMO 无 map（非探路型）→ 空段（不注入，行为同现状）。
 * 超预算截断策略：fog 全保留，decisions 从旧到新逐条裁（保最新）；决策裁光仍超
 * （fog+destination 病态规模）→ 按 TokenEstimator 口径兜底截（与其他段同口径）。
 * originalTokens = N 封顶后完整渲染尺寸（N 封顶不算截断，只有预算裁条才落埋点）。
 */
async function buildPmoMapSection(metadata: WorkUnitMetadata, tokenBudget: number): Promise<BuiltSection> {
  const pmoId = typeof metadata.pmoId === 'string' && metadata.pmoId.length > 0 ? metadata.pmoId : null;
  if (!pmoId) return { section: '', tokens: 0, originalTokens: 0 };
  const project = await projectService.get(pmoId);
  const map = project?.map;
  if (!map) return { section: '', tokens: 0, originalTokens: 0 };

  const destLine = `目标：${map.destination}`;
  const openFog = (map.fog ?? []).filter(f => f.status !== 'resolved');
  const fogHeader = openFog.length > 0 ? `开放雾（${openFog.length} 条）：` : '开放雾：无';
  const fogLines = openFog.map(f => `- [${f.status}] ${f.question}`);

  // decisions 数组尾 = 最新（#110 T4 追加写）→ 反转为新→旧，封顶 N
  const decisionLines = [...(map.decisions ?? [])].reverse().slice(0, MAP_DECISIONS_MAX).map(d => {
    const date = typeof d.resolvedAt === 'string' ? d.resolvedAt.slice(5, 10) : '';
    const summary = d.summary.length > MAP_SUMMARY_MAX_CHARS
      ? `${d.summary.slice(0, MAP_SUMMARY_MAX_CHARS)}…`
      : d.summary;
    return `- [${date}] ${summary}`;
  });

  const render = (keptDecisions: string[]): string => {
    const lines = ['## PMO 地图', destLine];
    if (keptDecisions.length > 0) {
      lines.push(`已落地决策（新→旧，近 ${MAP_DECISIONS_MAX} 条）：`, ...keptDecisions);
    }
    lines.push(fogHeader, ...fogLines);
    return lines.join('\n');
  };

  const full = render(decisionLines);
  const originalTokens = TokenEstimator.estimateText(full);
  if (originalTokens <= tokenBudget) return { section: full, tokens: originalTokens, originalTokens };

  // 超预算：fog 全保留，decisions 从旧到新逐条裁（列表尾 = 最旧）
  let kept = decisionLines;
  while (kept.length > 0 && TokenEstimator.estimateText(render(kept)) > tokenBudget) {
    kept = kept.slice(0, -1);
  }
  let section = render(kept);
  if (TokenEstimator.estimateText(section) > tokenBudget) {
    // 兜底：fog+destination 自身已超预算，按 TokenEstimator 口径截（与其他段同口径）
    section = sliceToTokenBudget(section, tokenBudget);
  }
  return { section, tokens: TokenEstimator.estimateText(section), originalTokens };
}

/**
 * #119: 组装 `## 产出契约` 段 —— 按 WU type 产出格式 + 最小模板（CONTRACT_TEMPLATES）。
 * 未知/无契约 type → 空段（不注入）。超预算按 TokenEstimator 口径截（与其他段同口径），
 * originalTokens > tokens 由 runSection 落 prompt:section_trimmed 埋点（定额 200）。
 */
function buildContractSection(wu: WorkUnitData, metadata: WorkUnitMetadata, tokenBudget: number): BuiltSection {
  // #163（T8-E2）：巡检单契约优先于 analysis 通用模板
  const template = (wu.type === 'analysis' && metadata.inspection === true)
    ? INSPECTION_CONTRACT
    : CONTRACT_TEMPLATES[wu.type];
  if (!template || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const full = `## 产出契约\n\n${template}`;
  const originalTokens = TokenEstimator.estimateText(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: TokenEstimator.estimateText(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}

/**
 * #95: 组装 `## 前序进展` 段 —— 断链新会话（续用不命中）时给 agent 的前序上下文。
 * 注入条件：isNewSession && stepCount>0（含复活丢会话）。内容 = metadata.progressLog
 * （成功步，旧→新）+ errorType 存在时附「上一步失败」行（失败步不落 log，注入时补）。
 * progressLog 空且无 errorType → 空段。超预算按 TokenEstimator 口径截（与其他段同口径），
 * originalTokens > tokens 由 runSection 落 prompt:section_trimmed 埋点。
 */
function buildHandoffSection(metadata: WorkUnitMetadata, isNewSession: boolean, tokenBudget: number): BuiltSection {
  if (!isNewSession) return { section: '', tokens: 0, originalTokens: 0 };
  const stepCount = typeof metadata.stepCount === 'number' ? metadata.stepCount : 0;
  if (stepCount <= 0) return { section: '', tokens: 0, originalTokens: 0 };
  const log = Array.isArray(metadata.progressLog) ? metadata.progressLog : [];
  if (log.length === 0 && !metadata.errorType) return { section: '', tokens: 0, originalTokens: 0 };

  const lines = ['## 前序进展'];
  if (log.length > 0) {
    lines.push('以下是你在此任务中已完成的步骤（旧→新）：');
    for (const entry of log) {
      // metadata 是 `[key: string]: unknown` 反序列化的 JSON，旧版本/手改可能残留畸形条目（null/标量）——逐字段窄断言防渲染脏数据
      const step = typeof entry?.step === 'number' ? entry.step : '';
      const action = typeof entry?.action === 'string' ? entry.action : '';
      const summary = typeof entry?.summary === 'string' ? entry.summary : '';
      lines.push(`- 第 ${step} 步 [${action}]：${summary}`);
    }
  }
  if (metadata.errorType) {
    lines.push(`上一步执行失败（${metadata.errorType}），请结合上文进展处理失败后再继续。`);
  }

  const full = lines.join('\n');
  const originalTokens = TokenEstimator.estimateText(full);
  if (originalTokens > tokenBudget) {
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: TokenEstimator.estimateText(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}

/**
 * §10 P0 + 决策 7/11 + #92: 组装 `## 本次任务 Skills` 段 —— step 时计算（不再读 claim 落盘的
 * metadata.matchedSkills，消竞态并吃到 skill 库最新版）。
 * #92 硬预裁剪（selectSkillsForInjection）：注入段只含 +skill 显式点名（wu.scope 解析）+
 * 域匹配（role.acceptedTypes ∪ 归一化 wu.type ∩ skill.agentTypes）两类；scope 文本匹配与
 * 「rest 热度」不再进注入段（由段尾 MANIFEST 指针按需兜底）。预裁剪后仍受 #91 分段定额截断
 * （有效预算 = 定额 + 池余量，块级截断，取代封顶 3）。
 * index-on-demand：索引行 = name + description + triggers 摘要 + 全文指针
 * （~/.studio/skills/<name>/SKILL.md，agent 按需阅读），不注入正文；段首协议行说明按需语义；
 * 段尾一行 MANIFEST 指针（~/.studio/skills/MANIFEST.md，agent 按需读全文清单），恒在段尾（无论是否裁剪）。
 * 返回 matched = 实际进入注入段的 skill 名（预裁剪后、截断后的集合；调用方落盘
 * metadata.matchedSkills；此处并发 knowledge:skill_used 事件，fire-and-forget，供度量/被无视率）。
 */
async function buildSkillSection(
  wu: WorkUnitData,
  deps: PromptComposerDeps,
  tokenBudget: number,
): Promise<{ section: string; tokens: number; originalTokens: number; matched: string[] }> {
  const manifest = loadManifest();
  if (manifest.length === 0) return { section: '', tokens: 0, originalTokens: 0, matched: [] };

  const hints = parseSkillHintsFromScope(wu.scope ?? '');
  const ranked = selectSkillsForInjection(manifest, {
    acceptedTypes: deps.acceptedTypes,
    wuType: wu.type,
  }, hints);
  if (ranked.length === 0) return { section: '', tokens: 0, originalTokens: 0, matched: [] };

  const header = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
  // #92: 段尾 MANIFEST 指针（恒在段尾，agent 按需读全文清单）
  const pointer = `完整 skill 清单见 skills MANIFEST.md（${studioPath('skills', 'MANIFEST.md')}）`;
  const pointerTokens = TokenEstimator.estimateText(pointer + '\n\n'); // +\n\n 分隔符
  const fixedTokens = TokenEstimator.estimateText(header) + pointerTokens;

  const candidates = ranked.map(entry => {
    const triggerSummary = Array.isArray(entry.triggers) && entry.triggers.length > 0
      ? `｜触发：${entry.triggers.slice(0, 5).join(', ')}`
      : '';
    const block = `### ${entry.name}\n${entry.description || '（无描述）'}${triggerSummary}\n全文：${studioPath('skills', entry.name, 'SKILL.md')}`;
    return { entry, block, blockTokens: TokenEstimator.estimateText(block + '\n\n') }; // + \n\n 分隔符
  });
  // 未截断的原始尺寸（截断埋点的 originalTokens；块级跳过也计入）
  const originalTokens = fixedTokens + candidates.reduce((sum, c) => sum + c.blockTokens, 0);

  let tokens = fixedTokens;
  const blocks: string[] = [];
  const matched: string[] = [];
  for (const { entry, block, blockTokens } of candidates) {
    if (tokens + blockTokens > tokenBudget) {
      // 首个块即超预算：截断塞入，保证段不为空（沿用原整段截断口径）；
      // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
      if (blocks.length === 0) {
        const sliced = sliceToTokenBudget(block, tokenBudget - tokens);
        blocks.push(sliced);
        matched.push(entry.name);
        tokens = fixedTokens + TokenEstimator.estimateText(sliced);
      }
      break;
    }
    blocks.push(block);
    matched.push(entry.name);
    tokens += blockTokens;
  }

  // 度量（fire-and-forget）：每个实际注入的 skill 记一条 knowledge:skill_used 事件
  for (const skillName of matched) {
    void metricsFileStore.appendJsonl(deps.resolveEventsFile(), {
      type: 'knowledge:skill_used',
      source: 'agent-loop',
      payload: JSON.stringify({ skillName, workUnitId: wu.id }),
      createdAt: new Date().toISOString(),
    }).catch(() => {});
  }

  return { section: `${header}\n\n${blocks.join('\n\n')}\n\n${pointer}`, tokens, originalTokens, matched };
}

/**
 * 决策 13 + #91: 组装 `## 你的角色` 段（角色自述 + preset 声明）。
 * 内容 = role.persona ?? role.description，附 preset 带入的 skills/tools/constraints 行
 * （#91 修复：此前 preset 三字段落盘后无任何消费，角色配置形同虚设）；皆空则段省略。
 * 调用方传入有效预算（#91 定额 + 池余量），超出按 TokenEstimator 口径截断。
 */
function buildPersonaSection(role: AgentProfileData, tokenBudget: number): BuiltSection {
  const persona = role.persona ?? role.description;
  const presetLines: string[] = [];
  if (Array.isArray(role.skills) && role.skills.length > 0) {
    presetLines.push(`技能：${role.skills.join('、')}`);
  }
  if (Array.isArray(role.tools) && role.tools.length > 0) {
    presetLines.push(`工具：${role.tools.join('、')}`);
  }
  if (role.constraints && typeof role.constraints === 'object' && Object.keys(role.constraints).length > 0) {
    presetLines.push(`约束：${Object.entries(role.constraints).map(([k, v]) => `${k}=${String(v)}`).join('；')}`);
  }
  const body = [persona, ...presetLines].filter(s => s && s.length > 0).join('\n');
  if (!body || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const full = `## 你的角色\n\n${body}`;
  const originalTokens = TokenEstimator.estimateText(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: TokenEstimator.estimateText(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}

/**
 * A2A §4.1 机制 2: 组装 `## 频道成员与委派` 段（成员花名册 + DELEGATE 协议教学）。
 * 花名册 = 本频道 active 成员的 name + description + provider（排除自己——委派质量取决于
 * 模型对角色能力的理解，没有花名册的 DELEGATE 是盲派）；members 为空（历史频道未回填）
 * 时回退到全部 active profile，与 DelegationGate 的过渡期口径一致。
 * 预算：调用方传入有效预算（#91 定额 + 池余量），超出按 TokenEstimator 口径截断。
 */
async function buildRosterSection(
  wu: WorkUnitData,
  deps: PromptComposerDeps,
  tokenBudget: number,
): Promise<BuiltSection> {
  if (!wu.channelId || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const channel = await deps.fileStore.getChannel(wu.channelId);
  const memberIds = parseChannels(channel?.members);
  let members: AgentProfileData[];
  if (memberIds.length > 0) {
    const resolved = await Promise.all(memberIds.map(id => deps.fileStore.getProfile(id).catch(() => null)));
    members = resolved.filter((p): p is AgentProfileData => !!p && p.status === 'active');
  } else {
    members = await deps.fileStore.listProfiles({ status: 'active' });
  }
  members = members.filter(p => p.id !== deps.role.id);
  if (members.length === 0) return { section: '', tokens: 0, originalTokens: 0 };

  const rosterLines = members.map(p =>
    `- ${p.name}（provider: ${p.provider ?? 'claude'}）：${p.description || '（无描述）'}`
  );
  const full = `## 频道成员与委派

本频道可协作成员：
${rosterLines.join('\n')}

如需把一部分工作交给更合适的成员，输出一行：ACTION: DELEGATE:@<成员名>:<子任务 scope>（scope 为该行剩余内容）。仅可委派给上述成员，不可委派给自己；委派深度上限 ${resolveMaxDepth()} 跳（根任务 depth=0），同一任务最多委派 ${MAX_DELEGATIONS_PER_PARENT} 次，不可对同一成员重复委派。系统校验通过后会创建子任务并在频道发卡片，你继续按 PROGRESS 推进自己的部分；校验不通过则转为 NEED_INPUT 请人裁决。`;

  const originalTokens = TokenEstimator.estimateText(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: TokenEstimator.estimateText(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}

/**
 * #100: 组装 `## 角色记忆索引` 段 —— 注入 per-role MEMORY.md 索引全文（index-on-demand：
 * 每行 = topic 路径 + 一句话摘要，正文由 agent 现成文件工具按需读，不引入语义搜索/RAG）。
 * 内容源 = roleMemoryStore.readIndex(roleId)；索引不存在/为空 → 空段（section: ''，同现状）；
 * 读盘失败 → 空段 + 记日志（non-blocking，绝不阻断 prompt 组装）。段首协议行说明按需语义
 * （同 skills 段风格）。预算经调用方 runSection 传有效预算（#91 定额 300 + 池余量），
 * 超出按 TokenEstimator 口径截断，originalTokens > tokens 由 runSection 落 prompt:section_trimmed 埋点。
 */
async function buildMemorySection(roleId: string, tokenBudget: number): Promise<BuiltSection> {
  let index: string;
  try {
    index = await roleMemoryStore.readIndex(roleId);
  } catch (err) {
    // 读盘失败（非 ENOENT 的 IO/权限等异常）：空段兜底，只记日志，不阻断 prompt 组装
    logger.warn('[prompt-composer] role memory index read failed (non-blocking)', {
      roleId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { section: '', tokens: 0, originalTokens: 0 };
  }

  const body = index.trim();
  if (!body || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const header = '## 角色记忆索引\n\n以下为你在往次任务中沉淀的记忆索引（每行 = topic 路径 + 一句话摘要）；任务内容命中相关记忆时，先用文件工具按需读对应 topic 正文再据此执行，不相关则忽略。';
  const full = `${header}\n\n${body}`;
  const originalTokens = TokenEstimator.estimateText(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: TokenEstimator.estimateText(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}
