/**
 * Knowledge Agent — 提取 prompt 单一来源
 *
 * 从 knowledge-agent.service.ts 拆分（提取/冷启动/分析分离）。
 * 本模块现仅保留提取 prompt 相关导出：
 *   - EXTRACT_FROM_TEXT_SYSTEM_PROMPT  R3 通用文本知识提取 prompt（单一来源）
 *   - getExtractFromTextSystemPrompt   E1 文件覆盖 getter
 * KnowledgeService.extractFromConversation 经门面 re-export 取用，两处不漂移。
 */

import { readPromptOverride } from '@dommaker/studio-shared';

/**
 * R3: 通用文本知识提取 prompt（KnowledgeService.extractFromConversation
 * 共用单一来源，避免两处漂移）。原 extractFromText 内的局部 EXTRACT_SYSTEM_PROMPT 提升而来。
 */
export const EXTRACT_FROM_TEXT_SYSTEM_PROMPT = `你是知识提取专家。从文本中提取结构化知识。对每条记录必须做三层分析：1) 根因（不描述表面现象），2) 责任归属（哪个 Agent/流程该预防），3) 预防措施（具体可操作）。\n\n关注类型：\n- 架构决策 (architecture) - 关于系统设计的讨论和决定\n- 设计决策 (decision) - 关于实现方式的取舍\n- 踩坑记录 (pitfall) - 遇到的问题，重点是根因而非现象\n- 流程经验 (process) - 流程中哪个环节该改进\n- 最佳实践 (guideline) - 可复用的经验和模式\n\n输出格式：{ "entries": [{ "type": "architecture|decision|pitfall|process|guideline", "title": "根因概括", "content": "根因+责任+预防", "tags": ["标签"] }] }\n只提取有价值的、可复用的知识。没有值得提取的知识则返回空数组。最多提取 5 个条目。`;

/**
 * E1 约束进化：提取 prompt 支持文件覆盖。
 * 覆盖文件 `~/.studio/prompt-overrides/knowledge.extract-from-text.md` 由进化提案
 * 批准后写入（不改写源码）；无覆盖时返回默认常量。调用点（KnowledgeService.extractFromConversation）
 * 必须经此 getter。
 */
export function getExtractFromTextSystemPrompt(): string {
  return readPromptOverride('knowledge.extract-from-text') ?? EXTRACT_FROM_TEXT_SYSTEM_PROMPT;
}
