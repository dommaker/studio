// AgentLoop prompt 构建（continue/reply 模板 + skills/persona/roster 注入段，共用 2K 红线）——
// 从 agent-loop.ts 原样抽出，行为不变。
import { estimateTokens, parseChannels, FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import type { WorkUnitData } from '../workunit/workunit.service.js';
import { loadManifest } from '../skills/manifest-loader.js';
import { selectSkillsWithDomain, parseSkillHintsFromScope } from '../skills/skill-selector.js';
import { resolveMaxDepth, MAX_DELEGATIONS_PER_PARENT } from '../workunit/delegation-gate.js';
import { metricsFileStore, studioEventsJsonlPath } from './workunit-token-events.js';

/**
 * §10 P0: 注入总预算（skill 段 + 知识段共用的 2K 红线）。
 * 必须与 knowledge-service 的 INJECT_TOKEN_BUDGET 保持一致——
 * 不从 knowledge-service import：现有测试以 vi.mock 工厂替换整个 knowledge-service
 * 模块（只暴露 knowledgeService），新增命名导入会在 mock 模块上访问不到而抛错。
 */
export const INJECT_TOKEN_BUDGET = 2_000;

// ─── Prompt builders ───

export function buildContinuePrompt(wu: WorkUnitData): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。若 .studio/AGENTS.generated.md 存在，先阅读（工作区指南：可用 skill 索引 + SDD 落盘要求）；仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入

当做出设计决策（选型、架构选择、方案取舍）时，用 Write 工具追加到 ~/.studio/knowledge/decision-YYYY-MM-DD.md 记录：话题、候选方案、选择、理由。`;
}

export function buildReplyPrompt(wu: WorkUnitData, replies: string[]): string {
  const replyText = replies.join('\n');
  return `## 当前工作

${wu.scope}

## 人类新回复

${replyText}

## 要求

根据回复调整方案，继续工作。若 .studio/AGENTS.generated.md 存在，先阅读（工作区指南：可用 skill 索引 + SDD 落盘要求）；仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入`;
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
export async function buildSkillSection(acceptedTypes: string[], wu: WorkUnitData): Promise<{ section: string; tokens: number; matched: string[] }> {
  const manifest = loadManifest();
  if (manifest.length === 0) return { section: '', tokens: 0, matched: [] };

  const hints = parseSkillHintsFromScope(wu.scope ?? '');
  const ranked = selectSkillsWithDomain(wu.scope ?? '', manifest, {
    acceptedTypes,
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
    const block = `### ${entry.name}\n${entry.description || '（无描述）'}${triggerSummary}\n全文：~/.studio/skills/${entry.name}/SKILL.md`;
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
    void metricsFileStore.appendJsonl(studioEventsJsonlPath(), {
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
export function buildPersonaSection(role: AgentProfileData, tokenBudget: number): { section: string; tokens: number } {
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
export async function buildRosterSection(fileStore: FileStore, role: AgentProfileData, wu: WorkUnitData, tokenBudget: number): Promise<{ section: string; tokens: number }> {
  if (!wu.channelId || tokenBudget <= 0) return { section: '', tokens: 0 };

  const channel = await fileStore.getChannel(wu.channelId);
  const memberIds = parseChannels(channel?.members);
  let members: AgentProfileData[];
  if (memberIds.length > 0) {
    const resolved = await Promise.all(memberIds.map(id => fileStore.getProfile(id).catch(() => null)));
    members = resolved.filter((p): p is AgentProfileData => !!p && p.status === 'active');
  } else {
    members = await fileStore.listProfiles({ status: 'active' });
  }
  members = members.filter(p => p.id !== role.id);
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
