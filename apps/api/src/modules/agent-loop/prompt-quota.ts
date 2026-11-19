/**
 * prompt 注入段定额与截断共享件（#671 自 prompt-composer.ts 拆出）：
 * SECTION_QUOTAS 九段软定额表、BuiltSection 段组装产出型、sliceToTokenBudget 截断器。
 * 段组装函数（prompt-section-*.ts）与编排（prompt-composer.ts）共用；定额数值的
 * 推导即测试正本 = __tests__/prompt-composer.test.ts「九段定额换尺子反推」块。
 */

import { estimateTokens } from '@dommaker/harness';

/**
 * #91（#88 决策 2）：注入段分段软定额（替代单池 2K 优先级制）。
 * 定额职责 = 防注入劣化（防注入段膨胀挤占对话空间、防噪声稀释信噪比），
 * 不防 CLI 上下文溢出（溢出归反应式策略管）；base prompt 不截断，CLI 脚手架不在管辖内。
 *
 * 软定额 + 池内余量共享：按 persona → roster → skills → map → memory → knowledge → files
 * → contract → handoff 顺序逐段组装，段有效预算 = 本段定额 + 共享池余量；段实际用量低于有效预算时，
 * 差额流入共享池供后续段借用（注入总量封顶 = 定额总和 ~5.3K）。
 * 定额数值 = harness 1.16.0 estimateTokens 新尺子口径，逐段「旧窗口反推」所得（不是系数）：
 * 用生产入口把该段渲染到不截断 → 旧尺子（harness ≤1.15，任一中文字整串按 len/1.5）在旧定额
 * （300/400/600/800/300/1000/400/200/800）下放行的最长前缀 → estimateTokens 对同一前缀的读数。
 * 推导即测试正本 = __tests__/prompt-composer.test.ts「九段定额换尺子反推（推导即测试 = 定数正本）」块：
 * 改尺子或改常量后，该块直接报出该是多少。方向不唯一（ASCII 为主段新尺子读数更小、中文为主段
 * 更大），禁一把系数套到底。
 * map 段 = #111 T5 探路地图完整渲染（destination + N 封顶中文决策行 + 开放雾清单反推）。
 * files 段 = #285（决策 #257）@文件引用注入段「## 引用文件」（ASCII 路径为主 + 中文标注，
 * 新尺子读数低于旧 400，方向为降；见 buildFilesSection）。
 * contract 段 = #119 契约段生成器（按全部真实模板逐一反推取最大值；见 buildContractSection）。
 * memory / handoff 段内容源分别归 #100（角色记忆索引常驻注入）与 #95（handoff 前序
 * 进展段）。
 */
export const SECTION_QUOTAS = {
  persona: 703,
  roster: 493,
  skills: 635,
  map: 1181,
  memory: 318,
  knowledge: 493,
  files: 213,
  contract: 396,
  handoff: 834,
} as const;

export type InjectSectionName = keyof typeof SECTION_QUOTAS;

/** 单个注入段的组装产出：tokens = 截断后实际用量；originalTokens = 未截断的原始尺寸（> tokens 即发生了截断） */
export interface BuiltSection {
  section: string;
  tokens: number;
  originalTokens: number;
  /** #285（决策 #257 D7-2/D9）：截断明细——存在时由 runSection merge 进 prompt:section_trimmed payload */
  trimDetail?: { keptCount: number; droppedPaths: string[]; droppedCount: number };
}

/**
 * #150 A2: 按 token 预算截断文本（estimateTokens 口径，替代 chars/4 反推 slice(0, budget*4)）。
 * 旧反推只在纯 ASCII 下成立：含中文文本按估算器口径（CJK 逐字 2 token）会超预算。
 * 二分求 estimateTokens 口径下最长的预算适配前缀，与估算器严格一致，不再复制启发式。
 */
export function sliceToTokenBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  if (estimateTokens(text) <= tokenBudget) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= tokenBudget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
