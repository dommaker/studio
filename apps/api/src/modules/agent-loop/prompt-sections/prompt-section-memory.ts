/**
 * memory 段（#671 自 prompt-composer.ts 拆出）：`## 角色记忆索引` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';

import { roleMemoryStore } from '../../role-memory/index.js';
import { getErrorMessage } from '../../../utils/errors.js';
import { sliceToTokenBudget, type BuiltSection } from '../prompt-quota.js';
import { logger } from '@dommaker/studio-shared/node';

/**
 * #100: 组装 `## 角色记忆索引` 段 —— 注入 per-role MEMORY.md 索引全文（index-on-demand：
 * 每行 = topic 路径 + 一句话摘要，正文由 agent 现成文件工具按需读，不引入语义搜索/RAG）。
 * 内容源 = roleMemoryStore.readIndex(roleId)；索引不存在/为空 → 空段（section: ''，同现状）；
 * 读盘失败 → 空段 + 记日志（non-blocking，绝不阻断 prompt 组装）。段首协议行说明按需语义
 * （同 skills 段风格）。预算经调用方 runSection 传有效预算（#91 memory 定额 + 池余量），
 * 超出按 estimateTokens 口径截断，originalTokens > tokens 由 runSection 落 prompt:section_trimmed 埋点。
 */
export async function buildMemorySection(roleId: string, tokenBudget: number): Promise<BuiltSection> {
  let index: string;
  try {
    index = await roleMemoryStore.readIndex(roleId);
  } catch (err) {
    // 读盘失败（非 ENOENT 的 IO/权限等异常）：空段兜底，只记日志，不阻断 prompt 组装
    logger.warn('[prompt-composer] role memory index read failed (non-blocking)', {
      roleId,
      error: getErrorMessage(err),
    });
    return { section: '', tokens: 0, originalTokens: 0 };
  }

  const body = index.trim();
  if (!body || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const header = '## 角色记忆索引\n\n以下为你在往次任务中沉淀的记忆索引（每行 = topic 路径 + 一句话摘要）；任务内容命中相关记忆时，先用文件工具按需读对应 topic 正文再据此执行，不相关则忽略。';
  const full = `${header}\n\n${body}`;
  const originalTokens = estimateTokens(full);
  if (originalTokens > tokenBudget) {
    // 按截断后实际内容重算 tokens，省下的余量回流共享池（#91）
    const sliced = sliceToTokenBudget(full, tokenBudget);
    return { section: sliced, tokens: estimateTokens(sliced), originalTokens };
  }
  return { section: full, tokens: originalTokens, originalTokens };
}
