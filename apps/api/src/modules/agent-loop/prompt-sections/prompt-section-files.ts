/**
 * files 段（#671 自 prompt-composer.ts 拆出）：`## 引用文件` 段组装。
 */

import { estimateTokens } from '@dommaker/harness';
import { stripTrailingSlashes } from '@dommaker/studio-shared';
import type { WorkUnitMetadata } from '../../workunit/index.js';
import type { BuiltSection } from '../prompt-quota.js';

/**
 * #285（决策 #257 D1/D2/D4/D6/D7/D9）：组装 `## 引用文件` 段 —— WU metadata.fileRefs
 * （#281 路由层校验后的 kept refs，message-routing 建 WU 时落档）注入稳定前缀最末。
 *
 * 内容：每引用一条块 —— 绝对路径 = repo/path（repo 尾斜杠归一，拼接防双斜杠）；
 * 与 metadata.workspaceRoot（尾斜杠归一）同仓 → 标注「本工程内，相对路径：<path>」，
 * 否则（含 workspaceRoot 缺失）标注「位于本工程之外」；段尾固定行（D6 原文）只读约束。
 * 防御性解析：fileRefs 非数组/畸形条目跳过；无有效引用 → 空段不注入。
 *
 * 截断（D2/D4，estimateTokens 口径）：块级截断保注入序前缀 —— 段头+固定行保留，
 * 引用块按序填充超预算即停；有未注入引用时段尾标注「另有 N 条引用未注入」（标注自身
 * 计入预算，加标注超预算则再少保一条，迭代收敛）。病态超预算（段头+固定行都装不下）
 * → 空段不注入（不半截输出）。截断明细经 trimDetail 回传（runSection merge 进
 * prompt:section_trimmed payload：keptCount/droppedPaths(≤5)/droppedCount，D7-2/D9）。
 */
export function buildFilesSection(metadata: WorkUnitMetadata, tokenBudget: number): BuiltSection {
  // 防御性解析：metadata 是反序列化 JSON，旧版本/手改可能残留畸形数据
  const raw = Array.isArray(metadata.fileRefs) ? metadata.fileRefs : [];
  const refs = raw.filter((r): r is { repo: string; path: string } =>
    !!r && typeof r === 'object'
    && typeof (r as { repo?: unknown }).repo === 'string' && (r as { repo: string }).repo.length > 0
    && typeof (r as { path?: unknown }).path === 'string' && (r as { path: string }).path.length > 0);
  if (refs.length === 0 || tokenBudget <= 0) return { section: '', tokens: 0, originalTokens: 0 };

  const workspaceRoot = typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot
    ? stripTrailingSlashes(metadata.workspaceRoot)
    : null;

  const blocks = refs.map(r => {
    const repo = stripTrailingSlashes(r.repo);
    const rel = r.path.replace(/^[/\\]+/, '');
    const abs = `${repo}/${rel}`;
    const note = workspaceRoot !== null && repo === workspaceRoot
      ? `本工程内，相对路径：${rel}`
      : '位于本工程之外';
    return { abs, line: `- ${abs}（${note}）` };
  });

  // D6 原文（逐字，与 #285 票体固定行一致）
  const FOOTER = '以下引用中位于本工程之外的文件为只读上下文，请勿修改；跨仓写入请显式提出并等人确认。大文件请按需分段读取，不要全文吞入。';
  const render = (kept: typeof blocks, droppedCount: number): string => {
    const lines = ['## 引用文件', '', ...kept.map(b => b.line), '', FOOTER];
    if (droppedCount > 0) lines.push('', `另有 ${droppedCount} 条引用未注入`);
    return lines.join('\n');
  };

  const full = render(blocks, 0);
  const originalTokens = estimateTokens(full);
  if (originalTokens <= tokenBudget) return { section: full, tokens: originalTokens, originalTokens };

  // 病态超预算：段头 + 固定行（含标注）都装不下 → 空段不注入（不半截输出）
  if (estimateTokens(render([], blocks.length)) > tokenBudget) {
    return { section: '', tokens: 0, originalTokens: 0 };
  }

  // 块级截断保注入序前缀：按序填充，超预算即停；「另有 N 条」标注计入预算
  // （加标注超预算则再少保一条，迭代收敛——引用数量级小，逐条重估可承受）
  let keptCount = 0;
  while (
    keptCount < blocks.length
    && estimateTokens(render(blocks.slice(0, keptCount + 1), blocks.length - keptCount - 1)) <= tokenBudget
  ) {
    keptCount++;
  }
  // 标注计数位宽变化（9→10 等）可能把末态顶超预算：再少保一条直至收敛
  while (keptCount > 0 && estimateTokens(render(blocks.slice(0, keptCount), blocks.length - keptCount)) > tokenBudget) {
    keptCount--;
  }

  const droppedCount = blocks.length - keptCount;
  const section = render(blocks.slice(0, keptCount), droppedCount);
  return {
    section,
    tokens: estimateTokens(section),
    originalTokens,
    trimDetail: {
      keptCount,
      droppedPaths: blocks.slice(keptCount, keptCount + 5).map(b => b.abs),
      droppedCount,
    },
  };
}
