/**
 * prompt/上下文组装（2026-08 从 agent-loop.agentStep 抽出，行为一字不改）：
 * agentStep 的 prompt 组装与上下文注入段 —— hint/traceId 邻接的 hint 读取、
 * base prompt 选择（pendingReplies > newReplies > continue）、三类 guard hint 注入、
 * skill > persona > roster > knowledge 共用 2K 预算注入，以及 hint 消费清除增量。
 *
 * 职责边界：
 *   - 本模块 = prompt 组装政策：hint 读取/注入/消费清除、注入段预算分配与截断、
 *     skill_used 度量落盘。三个 build 段函数（skill/persona/roster）同为模块级私有函数。
 *   - agent-loop.agentStep = 编排：traceId/channelVersion 读取（下游仍消费，留在 agentStep）→
 *     调 composeStepPrompt → 会话管理 → worktree 准备 → 执行与簿记。
 *
 * 可测试性：role/acceptedTypes/fileStore/事件文件路径全部经 deps 注入；
 * knowledgeService 为模块级单例直接 import（现有测试以 vi.mock 工厂替换整个
 * knowledge-service 模块，同一模块 ID 解析到同一绝对路径，mock 照常生效）。
 */

import { estimateTokens, parseChannels, FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { knowledgeService } from '../../knowledge/knowledge-service.js';
import { loadManifest } from '../../skills/manifest-loader.js';
import { selectSkillsWithDomain, parseSkillHintsFromScope } from '../../skills/skill-selector.js';
import { resolveMaxDepth, MAX_DELEGATIONS_PER_PARENT } from '../../workunit/delegation-gate.js';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import { buildContinuePrompt, buildReplyPrompt } from './agent-loop-parsers.js';
import { metricsFileStore } from './agent-loop-events.js';

/**
 * §10 P0: 注入总预算（skill 段 + 知识段共用的 2K 红线）。
 * 必须与 knowledge-service 的 INJECT_TOKEN_BUDGET 保持一致——
 * 不从 knowledge-service import：现有测试以 vi.mock 工厂替换整个 knowledge-service
 * 模块（只暴露 knowledgeService），新增命名导入会在 mock 模块上访问不到而抛错。
 */
const INJECT_TOKEN_BUDGET = 2_000;

/** prompt 组装输入。metadata 为 agentStep 入口解析的持久化视图（hint 消费读取同一来源）。 */
export interface PromptComposerCtx {
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  /** §4.2 观察层新回复的消息正文（target.newReplies.map(r => r.content)），优先级低于 pendingReplies */
  newReplies?: string[];
}

/** prompt 组装外部依赖（loop 绑定状态下传；skill_used 度量事件路径惰性解析，测试可改 env 生效）。 */
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
 *  1. hint 读取（pendingReplies / commitGuardHint / verifyFailHint / childGuardHint，注入后即消费）；
 *  2. base prompt：pendingReplies > target.newReplies > continue；
 *  3. 三类 guard hint 段注入；
 *  4. 注入段共用 2K 红线，优先级 skills > persona > roster > knowledge（逐段扣减剩余额度）；
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

  const basePrompt = pendingReplies.length > 0
    ? buildReplyPrompt(wu, pendingReplies)
    : ctx.newReplies?.length
      ? buildReplyPrompt(wu, ctx.newReplies)
      : buildContinuePrompt(wu);
  let prompt = basePrompt;
  if (commitGuardHint) prompt = `${prompt}\n\n## 提交提醒\n\n${commitGuardHint}`;
  if (verifyFailHint) prompt = `${prompt}\n\n## 验证失败\n\n${verifyFailHint}`;
  if (childGuardHint) prompt = `${prompt}\n\n## 子任务提醒\n\n${childGuardHint}`;

  // GAP-5: Knowledge injection — non-blocking
  // R1 反馈环: 接住 injectContext 返回的 injectedIds，贯穿到 recordOutcome /
  // extractFromExecution 的 consumedKnowledge（断点 A：此前注入 id 被丢弃，
  // outcome 永远上报 consumedKnowledge: []，飞轮无反馈数据）。
  // §10 P0 + 决策 7/13: 注入段共用 2K 红线，优先级 skills > persona > roster > knowledge——
  // skill 段（## 本次任务 Skills）step 时计算，先占预算；persona 段（## 你的角色）次之；
  // 成员花名册段（## 频道成员与委派）再次；剩余额度传给 injectContext。
  let skillSection = '';
  let skillTokens = 0;
  let skillMatched: string[] = [];
  try {
    const composed = await buildSkillSection(wu, deps);
    skillSection = composed.section;
    skillTokens = composed.tokens;
    skillMatched = composed.matched;
  } catch {
    // Non-blocking: agent continues without skill section
  }

  // 决策 13: `## 你的角色` 段（persona ?? description；为空则省略）。纯字符串组装，不抛错
  const persona = buildPersonaSection(deps.role, Math.max(0, INJECT_TOKEN_BUDGET - skillTokens));
  const personaSection = persona.section;
  const personaTokens = persona.tokens;

  let rosterSection = '';
  let rosterTokens = 0;
  try {
    const roster = await buildRosterSection(wu, deps, Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - personaTokens));
    rosterSection = roster.section;
    rosterTokens = roster.tokens;
  } catch {
    // Non-blocking: agent continues without roster section
  }

  let knowledgeContext = '';
  let injectedKnowledgeIds: string[] = [];
  try {
    const injected = await knowledgeService.injectContext(wu.type, {
      tags: [wu.type],
      maxTokens: Math.max(0, INJECT_TOKEN_BUDGET - skillTokens - personaTokens - rosterTokens),
    });
    knowledgeContext = injected.prompt;
    injectedKnowledgeIds = injected.injectedIds ?? [];
  } catch {
    // Non-blocking: agent continues without knowledge context
  }
  const leadSections = [skillSection, personaSection, rosterSection].filter(s => s.length > 0).join('\n\n');
  if (leadSections) {
    knowledgeContext = knowledgeContext
      ? `${leadSections}\n\n## 项目上下文\n${knowledgeContext}`
      : leadSections;
  }

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

  return { prompt, pendingReplies, knowledgeContext, skillMatched, injectedKnowledgeIds, consumedHintUpdates };
}

/**
 * §10 P0 + 决策 7/11: 组装 `## 本次任务 Skills` 段 —— step 时计算（不再读 claim 落盘的
 * metadata.matchedSkills，消竞态并吃到 skill 库最新版）。
 * 匹配（selectSkillsWithDomain）：+skill 显式点名（wu.scope 解析）> 域匹配
 * （role.acceptedTypes ∪ 归一化 wu.type ∩ skill.agentTypes）> scope 文本 > 其余按热度——
 * 产出相关度排序全量列表，由 2K 预算块级截断（取代封顶 3）。
 * index-on-demand：索引行 = name + description + triggers 摘要 + 全文指针
 * （~/.studio/skills/<name>/SKILL.md，agent 按需阅读），不注入正文；段首协议行说明按需语义。
 * 返回 matched = 实际进入注入段的 skill 名（调用方落盘 metadata.matchedSkills；
 * 此处并发 knowledge:skill_used 事件，fire-and-forget，供度量/被无视率）。
 */
async function buildSkillSection(
  wu: WorkUnitData,
  deps: PromptComposerDeps,
): Promise<{ section: string; tokens: number; matched: string[] }> {
  const manifest = loadManifest();
  if (manifest.length === 0) return { section: '', tokens: 0, matched: [] };

  const hints = parseSkillHintsFromScope(wu.scope ?? '');
  const ranked = selectSkillsWithDomain(wu.scope ?? '', manifest, {
    acceptedTypes: deps.acceptedTypes,
    wuType: wu.type,
  }, hints);
  if (ranked.length === 0) return { section: '', tokens: 0, matched: [] };

  const header = '## 本次任务 Skills\n\n以下 skill 按相关度排序；任务内容命中其触发条件时，先读全文再按此执行；不相关则忽略。';
  let tokens = estimateTokens(header.length);
  const blocks: string[] = [];
  const matched: string[] = [];
  for (const entry of ranked) {
    const triggerSummary = Array.isArray(entry.triggers) && entry.triggers.length > 0
      ? `｜触发：${entry.triggers.slice(0, 5).join(', ')}`
      : '';
    const block = `### ${entry.name}\n${entry.description || '（无描述）'}${triggerSummary}\n全文：${studioPath('skills', entry.name, 'SKILL.md')}`;
    const blockTokens = estimateTokens(block.length + 2); // + \n\n 分隔符
    if (tokens + blockTokens > INJECT_TOKEN_BUDGET) {
      // 首个块即超预算：截断塞入，保证段不为空（沿用原整段截断口径）
      if (blocks.length === 0) {
        blocks.push(block.slice(0, Math.max(0, (INJECT_TOKEN_BUDGET - tokens) * 4)));
        matched.push(entry.name);
        tokens = INJECT_TOKEN_BUDGET;
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

  return { section: `${header}\n\n${blocks.join('\n\n')}`, tokens, matched };
}

/**
 * 决策 13: 组装 `## 你的角色` 段（角色自述）。
 * 内容 = role.persona ?? role.description（皆空则段省略）；
 * 与 skill/roster/知识段共用 2K 红线（skills > persona > roster > knowledge），
 * 调用方传入剩余额度，超出按 chars/4 口径截断。
 */
function buildPersonaSection(role: AgentProfileData, tokenBudget: number): { section: string; tokens: number } {
  const persona = role.persona ?? role.description;
  if (!persona || tokenBudget <= 0) return { section: '', tokens: 0 };

  let section = `## 你的角色\n\n${persona}`;
  let tokens = estimateTokens(section.length);
  if (tokens > tokenBudget) {
    section = section.slice(0, tokenBudget * 4);
    tokens = tokenBudget;
  }
  return { section, tokens };
}

/**
 * A2A §4.1 机制 2: 组装 `## 频道成员与委派` 段（成员花名册 + DELEGATE 协议教学）。
 * 花名册 = 本频道 active 成员的 name + description + provider（排除自己——委派质量取决于
 * 模型对角色能力的理解，没有花名册的 DELEGATE 是盲派）；members 为空（历史频道未回填）
 * 时回退到全部 active profile，与 DelegationGate 的过渡期口径一致。
 * 预算：与 skill/知识段共用 2K 红线，优先级 skills index > roster > knowledge——
 * 调用方传入 skill 之后的剩余额度，超出按 chars/4 口径截断。
 */
async function buildRosterSection(
  wu: WorkUnitData,
  deps: PromptComposerDeps,
  tokenBudget: number,
): Promise<{ section: string; tokens: number }> {
  if (!wu.channelId || tokenBudget <= 0) return { section: '', tokens: 0 };

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
  if (members.length === 0) return { section: '', tokens: 0 };

  const rosterLines = members.map(p =>
    `- ${p.name}（provider: ${p.provider ?? 'claude'}）：${p.description || '（无描述）'}`
  );
  let section = `## 频道成员与委派

本频道可协作成员：
${rosterLines.join('\n')}

如需把一部分工作交给更合适的成员，输出一行：ACTION: DELEGATE:@<成员名>:<子任务 scope>（scope 为该行剩余内容）。仅可委派给上述成员，不可委派给自己；委派深度上限 ${resolveMaxDepth()} 跳（根任务 depth=0），同一任务最多委派 ${MAX_DELEGATIONS_PER_PARENT} 次，不可对同一成员重复委派。系统校验通过后会创建子任务并在频道发卡片，你继续按 PROGRESS 推进自己的部分；校验不通过则转为 NEED_INPUT 请人裁决。`;

  let tokens = estimateTokens(section.length);
  if (tokens > tokenBudget) {
    section = section.slice(0, tokenBudget * 4);
    tokens = tokenBudget;
  }
  return { section, tokens };
}
