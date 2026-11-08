/**
 * contract 段（#671 自 prompt-composer.ts 拆出）：`## 产出契约` 段模板正本 + 组装。
 */

import { estimateTokens } from '@dommaker/harness';
import { PLAN_TASK_CONTRACT } from '@dommaker/studio-shared';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import { sliceToTokenBudget, type BuiltSection } from '../prompt-quota.js';

/**
 * #567：plan 方向锁定契约段（插在裁决轮段之前）——存在互斥大方向时出一次方向卡
 * （NEED_INPUT + 紧随一行 DIRECTION: JSON），人锁定方向后同会话继续，结论落探路台账；
 * 解析见 agent-loop-parsers parseDirectionLine，提交链见 pmo/plan-direction.ts。
 */
export const PLAN_DIRECTION_SECTION = [
  '方向锁定（存在互斥大方向时出一次，在裁决轮之前）：输出',
  '  ACTION: NEED_INPUT:方向锁定——请选定本票方向',
  '  紧随一行 DIRECTION: {"question":"<方向抉择点>","options":[{"name":"<方向名>","summary":"<一句话>","tradeoffs":"<取舍说明>","impact":"<影响面：触及哪些模块/票>","recommended":true|false}]}',
  '  候选 2~3 个（至多 4），recommended 恰好一个；人选定后同一会话继续，方向结论落探路台账。',
  '无互斥方向（只有一条合理路径）或小需求快道：不出方向锁定，直接进裁决轮/成文拆单。',
].join('\n');

/** #567：metadata.directionPick === false 时方向锁定段的替换提示（buildContractSection 裁剪） */
export const PLAN_DIRECTION_DISABLED_HINT = '本单已关闭方向锁定（派单时显式关闭）：跳过方向锁定，直接进裁决轮/成文拆单。';

/**
 * #119：契约段按 WU type 的产出格式 + 最小模板（内容定稿随 #118 续烤迭代，先落最简模板）。
 * review → REVIEW_RESULT 协议行；implement → 测试先行 + Phase commit 格式；
 * decision（决策单）→ 结论摘要格式；analysis → research/prototype 产出载体（T3/#125）
 * + bug 路由规则与升级触发器（#121）；bug → 复现测试先行 + 防回归测试随修复同 commit（#121）。
 * #163（T8-E2）：analysis + metadata.inspection===true → 巡检契约（INSPECTION_CONTRACT，
 * 优先级高于 analysis 通用模板）。
 * 各类型契约段尾附「本环节标准打法」指引行（implement→tdd-implement、bug→diagnosing-bugs、
 * plan→requirement-clarify + to-tickets、analysis→research、review→code-review），
 * 指向 skills 段索引按需 loadSkill 读全文；decision/spec/巡检变体无对应打法 skill，不加。
 * 未列出的 type（task/feature 等）→ 空段（不注入）。
 */
export const CONTRACT_TEMPLATES: Record<string, string> = {
  review: [
    '完成审查后，除 ACTION 行外，还必须在输出的最后一行给出结构化结论：',
    'REVIEW_RESULT: {"verdict":"pass"|"reject"|"needs-info","summary":"一句话结论","issues":[{"severity":"error"|"warn"|"info","message":"问题描述"}]}',
    '（verdict=pass 通过 / reject 打回 / needs-info 上下文不足转人工；缺少该行将转人工评审。）',
    '本环节标准打法：code-review（索引见 skills 段，先 loadSkill 读全文再开工）。',
  ].join('\n'),
  implement: [
    '测试先行：先写失败测试（RED）再实现到测试全绿（GREEN），测试全绿后才算完成。',
    'Phase commit：按阶段分批提交，commit message 用 `phase(<阶段名>): <摘要>` 格式。',
    '本环节标准打法：tdd-implement（索引见 skills 段，先 loadSkill 读全文再开工）。',
  ].join('\n'),
  decision: [
    '结论摘要格式：输出末段 `## 结论摘要`，用一句话给出待决问题的结论与理由。',
  ].join('\n'),
  // #463：spec 成文单契约——输出尾部给 TASK 物化行（spec-materialization 解析契约），
  // 落 metadata.specTasks 供人工确认弹窗卡片墙预填（人审改后由后端序列化进 l3.summary）
  spec: [
    '物化清单格式：输出尾部逐行给出本成文单要拆的任务（确认后按清单自动派生任务单）：',
    '  TASK: <任务标题> [| AC: <验收标准>]... [| BLOCKEDBY: <wuId,...>] [| LEG: <gitRepo>]',
    '（无 TASK 行 = 不自动派生；清单会在人工确认时逐条评审，可改可剔。）',
  ].join('\n'),
  // #471：plan（一脉会话规划单）契约——澄清→调研→裁决→成文→拆单同会话完成；
  // 输出协议行是 agent-loop COMPLETE 解析与 #463 确认弹窗预填的数据源（契约单一来源）
  // #467：裁决轮协议（RULING 行）——fog 调研齐后向人出一次裁决卡，不逐题问人
  // #567：方向锁定协议（DIRECTION 行）——裁决轮前置可选环节，directionPick:false 时
  // 由 buildContractSection 替换为关闭提示
  plan: [
    '一脉会话（详见 skills 段 requirement-clarify / to-tickets 全文）：澄清 → fog 调研（仓外调研派 DELEGATE research 子单）→ 裁决轮 → spec 成文落业务仓 .studio/specs/ → 拆任务清单，全程不换会话。',
    '会话中断恢复：prompt「探路地图」段的台账（目的地 + 待决 + 已裁决结论）是唯一恢复事实源，以台账续跑，不整单重来。',
    PLAN_DIRECTION_SECTION,
    '裁决轮（fog 调研齐后出一次，不逐题问人）：输出',
    '  ACTION: NEED_INPUT:裁决轮——N 个待决问题请一次性裁决',
    '  紧随逐行 RULING: {"question":"<待决问题>","suggestion":"<建议结论>","default":"<人不答时的默认值，可省>"}',
    '  人一次性裁决后同一会话继续：采纳结论已落探路台账（随裁决结果注入回复）；被打回重议的题只重调该题——补充调研后重新出裁决轮。',
    '无 FOG 的小需求不进裁决轮：澄清确认一次后直接成文拆单。',
    '输出协议（规划完成时，除 ACTION 行外逐行给出）：',
    '  实现任务 3~8 条，每条可被独立认领：',
    `  ${PLAN_TASK_CONTRACT}`,
    '  FOG: <待决问题>（探路型才输出，至多 12 条；确认后入探路台账，不再单独立决策单）',
    '  DESTINATION: <一句话目标>（可选，缺省用项目标题）',
    '本环节标准打法：requirement-clarify + to-tickets（索引见 skills 段，先 loadSkill 读全文再开工）。',
  ].join('\n'),
  analysis: [
    '方法论二选一（详见 skills 段 research / prototype 全文）：',
    'research → 调研报告落业务仓 .studio/research/，并在来源工单回挂报告链接。',
    'prototype → 一次性代码落 prototype/<name> 分支（不合并、不进评审），结论（回答了什么问题）记录回工单。',
    'bug 路由（#121）：bug 默认快速路（不开图不写成文单），落任务单走「诊断→复现→修复→防回归」（diagnosing-bugs）。',
    '升级触发器：根因在需求/设计层 → 转决策单或开图；诊断事实（复现命令/已排除假设/定位结论）随票携带。',
    '本环节标准打法：research（索引见 skills 段，先 loadSkill 读全文再开工）。',
  ].join('\n'),
  // #121：bug 类契约段模板——复现测试先行（FAIL 复现 bug → 修复 → GREEN），防回归测试随修复同 commit
  bug: [
    '复现测试先行：先写 FAIL 的复现测试（断言报告的症状，确认变红），再修复到 GREEN。',
    '防回归测试随修复同 commit：复现测试最小化后即为防回归测试，与修复代码同一个 commit 提交。',
    '本环节标准打法：diagnosing-bugs（索引见 skills 段，先 loadSkill 读全文再开工）。',
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

/**
 * #119: 组装 `## 产出契约` 段 —— 按 WU type 产出格式 + 最小模板（CONTRACT_TEMPLATES）。
 * 未知/无契约 type → 空段（不注入）。超预算按 estimateTokens 口径截（与其他段同口径），
 * originalTokens > tokens 由 runSection 落 prompt:section_trimmed 埋点（定额见 SECTION_QUOTAS.contract）。
 */
export function buildContractSection(wu: WorkUnitData, metadata: WorkUnitMetadata, tokenBudget: number): BuiltSection {
  // #163（T8-E2）：巡检单契约优先于 analysis 通用模板
  let template = (wu.type === 'analysis' && metadata.inspection === true)
    ? INSPECTION_CONTRACT
    : CONTRACT_TEMPLATES[wu.type];
  // #567：plan + directionPick:false → 方向锁定段替换为关闭提示（INSPECTION_CONTRACT 变体先例的轻量版）
  if (wu.type === 'plan' && metadata.directionPick === false && template) {
    template = template.replace(PLAN_DIRECTION_SECTION, PLAN_DIRECTION_DISABLED_HINT);
  }
  if (!template || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const full = `## 产出契约\n\n${template}`;
  const originalTokens = estimateTokens(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: estimateTokens(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}
