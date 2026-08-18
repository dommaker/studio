/**
 * WU metadata 访问器（2026-08-06 Card 8）：WorkUnitMetadata 的容错解析 / 会话簿记清理 /
 * 合并视图三件套——schema 知识的单一出口，替代散落各模块的裸 `JSON.parse(...metadata)`。
 *
 * 窄接口刻意不放宽：只暴露 parseWuMetadata / clearSessionBookkeeping / mergedWuView。
 * 带特殊取值形态的点（dotted key 兼容、跨实体 metadata、窄类型断言）不收敛到这里，
 * 各自保留就地解析（见 agents/token-usage.service.ts extractRootId 等）。
 *
 * 本模块是零运行时依赖的叶子（仅 type import WorkUnitMetadata），任何模块可安全引入。
 */

import type { WorkUnitMetadata } from './workunit.types.js';

/**
 * metadata JSON 串容错解析：null/undefined/空串/坏 JSON/非对象 JSON（数组、标量）一律 `{}`。
 * 纯同步、纯内存，绝不抛异常。
 */
export function parseWuMetadata(metadata: string | null | undefined): WorkUnitMetadata {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as WorkUnitMetadata;
  } catch {
    return {};
  }
}

/**
 * 会话/执行簿记绝不继承到子 WU（2026-07-30 走查实锤）：继承 sessionId 会让子 WU
 * 误续用父 WU 的 CLI 会话 —— #94 起 agent-loop 续用判定只信档案 metadata.sessionId，
 * 共享 ~/.studio 多实例下可错位命中；且 root + bypassPermissions settings 下
 * claude --resume 自注入 --dangerously-skip-permissions 被 root guard 秒拒（code 1）。
 * 跨 WU 续用本就违反"同一 WU 内才续用"约定（异 cwd 会话不存在）。
 *
 * 本列表是这 16 个字段的唯一权威出处（原 review-dispatcher.createReviewWorkUnit 的手维护
 * delete 清单；#94 增 lastSessionResumed、#95 增 progressLog、#96 增 sessionSummary；
 * #176 增 blockedAt/resumeCount（死信计时基准/复活观测钩子，同理不继承）；
 * #171 删只写零消费方的 input_tokens 死字段 —— #67 决议：token 观测由 workunit:tokens 事件覆盖）。
 * agent-loop 新增簿记字段时必须同步加入本列表，否则会静默泄漏进 review 子 WU。
 *
 * 返回删掉簿记字段后的浅拷贝，不改入参（与 review-dispatcher 原语义一致：
 * 它 delete 的是自己 spread 出来的 childMeta 副本）。
 */
export function clearSessionBookkeeping(meta: WorkUnitMetadata): WorkUnitMetadata {
  const cleaned: WorkUnitMetadata = { ...meta };
  delete cleaned.sessionId;
  delete cleaned.startedAt;
  delete cleaned.sessionResumes;
  delete cleaned.sessionCount;   // B5: 会话预算不继承（否则父 WU 超限会连坐子 WU 直接转人工）
  delete cleaned.lastSessionResumed; // #94: 续用/新建标记不继承（子 WU 尚未起会话）
  delete cleaned.blockReason;    // B4: blocked 原因不继承（子 WU 从未被 block）
  delete cleaned.blockedAt;      // #176: 死信计时基准不继承（同上）
  delete cleaned.staleGuardBlockedAt; // #221: 陈旧守卫拦截标记不继承（子 WU 自己的 updatedAt 生命周期）
  delete cleaned.resumeCount;    // #176: 复活计数不继承（同上）
  delete cleaned.stepCount;
  delete cleaned.consecutiveStuck;
  delete cleaned.errorType;
  delete cleaned.errorDetail;
  delete cleaned.errorAt;
  delete cleaned._cumulativeTokens;
  delete cleaned.progressLog;  // #95: 父 WU 进展史不继承（子 WU 从零记自己的 progressLog）
  delete cleaned.sessionSummary; // #96: 父 WU 会话滚动摘要不继承（子 WU 从零记自己的会话）
  return cleaned;
}

/**
 * 「持久化 metadata + 本 step metadataUpdates」合并视图（agent-loop recordResult 口径）：
 * 提交守卫/自动验证必须以合并视图为准——首个 step 的 worktreePath 等字段由 agentStep 经
 * result.metadataUpdates 传入、此刻尚未落库；只看持久化值会让首 step 的 COMPLETE 退到主仓库
 * （干净）做检查而漏拦（e2e 实测：dev 在 worktree 改了未提交，守卫查主仓库放行 → 假 complete）。
 *
 * 语义 = `{ ...parseWuMetadata(persisted), ...updates }`：updates 里显式 `undefined` 的键
 * 会覆盖持久化值，序列化（JSON.stringify 丢 undefined 值键）时即清除——
 * agent-loop 的 hint 消费清除（commitGuardHint/verifyFailHint/pendingReplies 等）依赖此语义。
 */
export function mergedWuView(
  persisted: string | null | undefined,
  updates: Partial<WorkUnitMetadata> = {},
): WorkUnitMetadata {
  return { ...parseWuMetadata(persisted), ...updates };
}
