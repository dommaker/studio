/**
 * Analyst Synthesizer — Combines Scout reports into RequirementsDoc prompt
 *
 * Output format is IDENTICAL to current Analyst output (RequirementsDocJson).
 */
import { formatConstraintsForPrompt } from '@dommaker/studio-shared';
import { skillLoader } from '@dommaker/studio-skill';
import type { ScoutScope } from './analyst-prescan.js';
import type { ScoutReport } from './analyst-scout.js';

/**
 * Build synthesizer prompt from scout reports.
 * The synthesizer session produces the exact same RequirementsDocJson
 * as the current single-session Analyst.
 */
export function buildSynthesizerPrompt(
  requirement: string,
  scope: ScoutScope,
  scoutReports: ScoutReport[],
  outputFile: string,
): string {
  const constraintSection = formatConstraintsForPrompt('analyst');
  const analystSkills = skillLoader.load({ agentType: 'analyst' });
  const skillSection = analystSkills.length > 0
    ? '\n' + skillLoader.formatForPrompt(analystSkills) + '\n'
    : '';

  // Format scout reports into structured input
  const scoutSection = scoutReports.map(r => {
    const status = r.success ? '✅' : '❌ FAILED';
    const content = r.success ? r.content : `Error: ${r.error || 'unknown'}`;
    return `### ${r.type} Scout ${status} (${r.durationMs}ms)\n\n\`\`\`json\n${content}\n\`\`\``;
  }).join('\n\n');

  const failedTypes = scoutReports.filter(r => !r.success).map(r => r.type);
  const failureNote = failedTypes.length > 0
    ? `\n**注意**: 以下 Scout 失败，相关维度信息缺失: ${failedTypes.join(', ')}。请基于可用信息合成，对缺失维度做保守假设。\n`
    : '';

  return [
    constraintSection,
    skillSection,
    '',
    '你是一个需求分析专家。基于代码探索结果，生成结构化的 RequirementsDoc。',
    '',
    '**铁律：只输出用户明确要求的需求。**',
    '**铁律：AC 描述必须动词开头。**',
    '**铁律：已实现的需求不创建 WorkUnit。**',
    '',
    '## 探索范围',
    `模块: ${scope.modules.join(', ') || 'N/A'}`,
    `关键文件: ${scope.keyFiles.join(', ') || 'N/A'}`,
    `关注点: ${scope.concerns.join(', ')}`,
    '',
    '## Scout 探索报告',
    scoutSection,
    '',
    failureNote,
    '',
    '## 原始需求',
    requirement,
    '',
    '## 输出要求',
    `将完整 JSON 写入文件: ${outputFile}`,
    '',
    'JSON 格式:',
    '```json',
    '{',
    '  "requirement": { "title": "", "summary": "", "tier": "fast|standard|premium", "tierReason": "", "acGroups": [{ "id": "", "acs": [""], "files": [""], "dependencies": [] }], "constraints": [], "tags": [] },',
    '  "design": { "acGroups": [{ "id": "", "implementationNotes": "", "architectureContext": { "functions": [], "callChain": "", "imports": [], "typesInScope": [], "testMock": [], "dangerZones": [], "verifiedAt": "" }, "codePatterns": [], "gotchas": [], "modelTier": "fast|standard|premium" }] },',
    '  "task": { "acGroups": [{ "id": "", "contractTests": [{ "file": "", "content": "" }], "testFiles": [], "contractTestsSkipReason": "" }] }',
    '}',
    '```',
    '',
    '利用 Scout 报告中的函数签名、调用链、类型定义填写 architectureContext。不需要再探索代码库。',
    '',
    '写完 JSON 后，在 stdout 输出 "DONE"。',
  ].join('\n');
}
