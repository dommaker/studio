/**
 * map 段（#671 自 prompt-composer.ts 拆出）：`## PMO 地图` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';
import { projectService } from '../../pmo/index.js';
import type { WorkUnitMetadata } from '../../workunit/index.js';
import { sliceToTokenBudget, type BuiltSection } from '../prompt-quota.js';

/** #111 T5：地图段 decisions 渲染条数封顶 N（顶格完整渲染尺寸随 map 段定额一并在旧窗口反推中校准，见 __tests__/prompt-composer.test.ts 推导块；超出段预算时按 fog 保留、决策从旧到新裁） */
export const MAP_DECISIONS_MAX = 10;
/** #111 T5：单条 decision summary 紧凑截断阈值（超出加省略号；顶格单行=160 字符+省略号，estimateTokens 实测：中文内容 321tok / 纯 ASCII 41tok，决策行实际以中文类计） */
export const MAP_SUMMARY_MAX_CHARS = 160;

/**
 * #111 T5（接替 #107 T1 tracer bullet）：组装完整 `## PMO 地图` 段。
 * 紧凑文本：destination 一行 + 近 MAP_DECISIONS_MAX 条 decisions（新→旧，summary 超
 * MAP_SUMMARY_MAX_CHARS 截断加省略号）+ 开放 fog（open/in-discussion，resolved 不列）清单。
 * WU 无 pmoId / PMO 无 map（非探路型）→ 空段（不注入，行为同现状）。
 * 超预算截断策略：fog 全保留，decisions 从旧到新逐条裁（保最新）；决策裁光仍超
 * （fog+destination 病态规模）→ 按 estimateTokens 口径兜底截（与其他段同口径）。
 * originalTokens = N 封顶后完整渲染尺寸（N 封顶不算截断，只有预算裁条才落埋点）。
 */
export async function buildPmoMapSection(metadata: WorkUnitMetadata, tokenBudget: number): Promise<BuiltSection> {
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
  const originalTokens = estimateTokens(full);
  if (originalTokens <= tokenBudget) return { section: full, tokens: originalTokens, originalTokens };

  // 超预算：fog 全保留，decisions 从旧到新逐条裁（列表尾 = 最旧）
  let kept = decisionLines;
  while (kept.length > 0 && estimateTokens(render(kept)) > tokenBudget) {
    kept = kept.slice(0, -1);
  }
  let section = render(kept);
  if (estimateTokens(section) > tokenBudget) {
    // 兜底：fog+destination 自身已超预算，按 estimateTokens 口径截（与其他段同口径）
    section = sliceToTokenBudget(section, tokenBudget);
  }
  return { section, tokens: estimateTokens(section), originalTokens };
}
