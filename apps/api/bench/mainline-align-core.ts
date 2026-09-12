/**
 * #521（spec .studio/specs/2026-09-12-channel-mainline-measurement §2，决议 #505）：
 * 频道主链路离线对齐工具——纯函数核心。
 *
 * 只读三家数据源（CLI 壳负责读取，本模块只见行数据）：
 *   1. 频道消息热文件（channels/*\/messages.jsonl）：{id, channelId, authorType, workUnitId, createdAt}
 *      —— 注意更新副本（linkWorkUnit 回填）同 id 追加在尾、createdAt 不变（#317），按 id 去重后行者胜出；
 *   2. WU 快照（workunits/index.json）：{id, channelId, createdAt, claimedAt, completedAt, metadata(JSON string)}
 *      —— metadata.traceId = 最近一次触达该 WU 的请求 traceId（#519 口径，三路径一致），
 *         metadata.anchorMessageId = 派发消息锚点（#494）；
 *   3. studio-events 事件流（logs/studio-events.jsonl）：workunit:execution_step（步级，payload.at）
 *      与 client.perf.*（前端三埋点 #520，source web-client，可能尚无样本）。
 *
 * 四段口径（映射「消息的旅程」六段中的服务端四段，spec §7）：
 *   派单      = WU.createdAt - 派发消息.createdAt
 *   等认领    = WU.claimedAt - WU.createdAt
 *   执行总时长 = WU.completedAt - WU.claimedAt（步级分解取 execution_step 事件的 at 差分，
 *               首步 delta = 步 at - claimedAt，即「认领→首步产出」）
 *   回执落库  = 首条 createdAt ≥ WU.completedAt 的 agent 消息.createdAt - WU.completedAt
 * 缺失段不静默丢样本：链上 skips[] 与分布的 skipped{} 如实标注原因。
 */

// ── 输入行类型（CLI 壳从文件读出后传入；字段宽容，缺失走跳过标注）──
export interface ChannelMessageRow {
  id: string;
  channelId: string;
  authorType: string;
  workUnitId?: string | null;
  createdAt?: string;
}

export interface WorkUnitSnapshotRow {
  id: string;
  channelId?: string | null;
  status?: string;
  createdAt?: string;
  claimedAt?: string | null;
  completedAt?: string | null;
  metadata?: string | Record<string, unknown> | null;
}

export interface StudioEventRow {
  type?: string;
  source?: string;
  payload?: unknown;
  createdAt?: string;
}

export interface AlignInput {
  messages: ChannelMessageRow[];
  workunits: WorkUnitSnapshotRow[];
  events: StudioEventRow[];
}

// ── 输出类型 ──
export interface ChainStep {
  step: number;
  at: number;
  /** 相对上一步（首步相对 claimedAt）的耗时；无从相对时为 null */
  deltaMs: number | null;
  status?: string;
}

export interface MainlineChain {
  workUnitId: string;
  traceId: string | null;
  channelId: string | null;
  wuCreatedAt: number | null;
  dispatchMessageId: string | null;
  dispatchMs: number | null;
  waitClaimMs: number | null;
  executionMs: number | null;
  steps: ChainStep[];
  receiptMessageId: string | null;
  receiptMs: number | null;
  /** 缺失段标注（如 'receipt:no_receipt_message'），不静默丢样本 */
  skips: string[];
}

export interface SegmentStats {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  skipped: Record<string, number>;
}

export interface ClientPerfStats {
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** n=0 时 'no_samples'（前端埋点数据未产生时照常可跑，如实标注） */
  note?: 'no_samples';
}

export const CLIENT_PERF_TYPES = [
  'client.perf.send_click',
  'client.perf.receipt_render',
  'client.perf.page_load',
] as const;

export interface AlignReport {
  chainCount: number;
  segments: {
    dispatch: SegmentStats;
    waitClaim: SegmentStats;
    execution: SegmentStats;
    receipt: SegmentStats;
  };
  clientPerf: Record<(typeof CLIENT_PERF_TYPES)[number], ClientPerfStats>;
  chains: MainlineChain[];
}

// ── 内部工具 ──
function ts(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function parseMetadata(raw: WorkUnitSnapshotRow['metadata']): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {}; // 同路由层 parseWuMetadata 容错口径：畸形 metadata 落 {} 不抛错
  }
}

function parsePayload(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** nearest-rank 分位；空数组 → null */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function segmentStats(chains: MainlineChain[], pick: (c: MainlineChain) => number | null, prefix: string): SegmentStats {
  const samples: number[] = [];
  const skipped: Record<string, number> = {};
  for (const c of chains) {
    const v = pick(c);
    if (v !== null) {
      samples.push(v);
    } else {
      for (const s of c.skips) {
        if (s.startsWith(`${prefix}:`)) skipped[s] = (skipped[s] ?? 0) + 1;
      }
    }
  }
  samples.sort((a, b) => a - b);
  return {
    n: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    minMs: samples.length ? samples[0] : null,
    maxMs: samples.length ? samples[samples.length - 1] : null,
    skipped,
  };
}

/** 消息按 id 去重（更新副本后行者胜出；createdAt 由消息自身携带、副本不变） */
function dedupeMessages(rows: ChannelMessageRow[]): Map<string, ChannelMessageRow> {
  const byId = new Map<string, ChannelMessageRow>();
  for (const m of rows) {
    if (m && typeof m.id === 'string') byId.set(m.id, m);
  }
  return byId;
}

// ── 核心：对齐出单链 ──
export function buildChains(input: AlignInput): MainlineChain[] {
  const msgById = dedupeMessages(input.messages);

  // 频道内按 workUnitId 索引（人类消息 / agent 消息分开）
  const humanByWu = new Map<string, ChannelMessageRow[]>();
  const agentByWu = new Map<string, ChannelMessageRow[]>();
  for (const m of msgById.values()) {
    if (!m.workUnitId) continue;
    const bucket = m.authorType === 'agent' ? agentByWu : m.authorType === 'human' ? humanByWu : null;
    if (!bucket) continue;
    const list = bucket.get(m.workUnitId) ?? [];
    list.push(m);
    bucket.set(m.workUnitId, list);
  }

  // execution_step 事件按 workUnitId 索引
  const stepsByWu = new Map<string, Array<{ step: number; at: number; status?: string }>>();
  for (const e of input.events) {
    if (e?.type !== 'workunit:execution_step') continue;
    const p = parsePayload(e.payload);
    const wuId = typeof p?.workUnitId === 'string' ? p.workUnitId : null;
    const at = ts(p?.at) ?? ts(e.createdAt);
    if (!wuId || at === null) continue;
    const list = stepsByWu.get(wuId) ?? [];
    list.push({
      step: typeof p?.step === 'number' ? p.step : list.length + 1,
      at,
      status: typeof p?.status === 'string' ? p.status : undefined,
    });
    stepsByWu.set(wuId, list);
  }

  const chains: MainlineChain[] = [];
  for (const wu of input.workunits) {
    if (!wu || typeof wu.id !== 'string') continue;
    const meta = parseMetadata(wu.metadata);
    const skips: string[] = [];
    const wuCreated = ts(wu.createdAt);
    const claimed = ts(wu.claimedAt);
    const completed = ts(wu.completedAt);

    // ── 派单段：anchorMessageId 优先；回退最早的人类消息（合并窗口搭车消息晚于建单，排除）──
    let dispatchMessageId: string | null = null;
    let dispatchMs: number | null = null;
    if (wuCreated === null) {
      skips.push('dispatch:no_wu_createdAt');
    } else {
      let dispatchMsg: ChannelMessageRow | undefined;
      if (typeof meta.anchorMessageId === 'string') dispatchMsg = msgById.get(meta.anchorMessageId);
      if (!dispatchMsg) {
        const candidates = (humanByWu.get(wu.id) ?? [])
          .filter(m => { const t = ts(m.createdAt); return t !== null && t <= wuCreated; })
          .sort((a, b) => ts(a.createdAt)! - ts(b.createdAt)!);
        dispatchMsg = candidates[0];
      }
      if (dispatchMsg && ts(dispatchMsg.createdAt) !== null) {
        dispatchMessageId = dispatchMsg.id;
        dispatchMs = wuCreated - ts(dispatchMsg.createdAt)!;
      } else {
        skips.push('dispatch:no_dispatch_message');
      }
    }

    // ── 等认领段 ──
    let waitClaimMs: number | null = null;
    if (wuCreated === null) skips.push('waitClaim:no_wu_createdAt');
    else if (claimed === null) skips.push('waitClaim:no_claimedAt');
    else waitClaimMs = claimed - wuCreated;

    // ── 执行总时长 + 步级分解 ──
    let executionMs: number | null = null;
    if (claimed === null) skips.push('execution:no_claimedAt');
    else if (completed === null) skips.push('execution:no_completedAt');
    else executionMs = completed - claimed;

    const rawSteps = (stepsByWu.get(wu.id) ?? []).sort((a, b) => a.step - b.step || a.at - b.at);
    const steps: ChainStep[] = rawSteps.map((s, i) => ({
      step: s.step,
      at: s.at,
      deltaMs: i === 0 ? (claimed !== null ? s.at - claimed : null) : s.at - rawSteps[i - 1].at,
      ...(s.status ? { status: s.status } : {}),
    }));

    // ── 回执落库段：首条 createdAt ≥ completedAt 的 agent 消息 ──
    let receiptMessageId: string | null = null;
    let receiptMs: number | null = null;
    if (completed === null) {
      skips.push('receipt:no_completedAt');
    } else {
      const candidates = (agentByWu.get(wu.id) ?? [])
        .filter(m => { const t = ts(m.createdAt); return t !== null && t >= completed; })
        .sort((a, b) => ts(a.createdAt)! - ts(b.createdAt)!);
      const receipt = candidates[0];
      if (receipt) {
        receiptMessageId = receipt.id;
        receiptMs = ts(receipt.createdAt)! - completed;
      } else {
        skips.push('receipt:no_receipt_message');
      }
    }

    chains.push({
      workUnitId: wu.id,
      traceId: typeof meta.traceId === 'string' ? meta.traceId : null,
      channelId: typeof wu.channelId === 'string' ? wu.channelId : null,
      wuCreatedAt: wuCreated,
      dispatchMessageId,
      dispatchMs,
      waitClaimMs,
      executionMs,
      steps,
      receiptMessageId,
      receiptMs,
      skips,
    });
  }
  return chains;
}

// ── 时间窗过滤（按 WU 建成时间；无建成时间的链在设窗时排除）──
export function filterChainsByWindow(
  chains: MainlineChain[],
  window: { sinceMs?: number | null; untilMs?: number | null },
): MainlineChain[] {
  const { sinceMs = null, untilMs = null } = window;
  if (sinceMs === null && untilMs === null) return chains;
  return chains.filter(c => {
    if (c.wuCreatedAt === null) return false;
    if (sinceMs !== null && c.wuCreatedAt < sinceMs) return false;
    if (untilMs !== null && c.wuCreatedAt > untilMs) return false;
    return true;
  });
}

// ── 汇总：四段分布 + 前端埋点段 ──
export function summarizeChains(chains: MainlineChain[], events: StudioEventRow[] = []): AlignReport {
  const clientPerf = Object.fromEntries(
    CLIENT_PERF_TYPES.map(type => {
      const msSamples = events
        .filter(e => e?.type === type)
        .map(e => {
          const p = parsePayload(e.payload);
          return typeof p?.ms === 'number' && Number.isFinite(p.ms) ? p.ms : null;
        })
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      const n = events.filter(e => e?.type === type).length;
      const stats: ClientPerfStats = {
        n,
        p50Ms: percentile(msSamples, 50),
        p95Ms: percentile(msSamples, 95),
        ...(n === 0 ? { note: 'no_samples' as const } : {}),
      };
      return [type, stats];
    }),
  ) as AlignReport['clientPerf'];

  return {
    chainCount: chains.length,
    segments: {
      dispatch: segmentStats(chains, c => c.dispatchMs, 'dispatch'),
      waitClaim: segmentStats(chains, c => c.waitClaimMs, 'waitClaim'),
      execution: segmentStats(chains, c => c.executionMs, 'execution'),
      receipt: segmentStats(chains, c => c.receiptMs, 'receipt'),
    },
    clientPerf,
    chains,
  };
}

// ── 按 traceId 查单链明细 ──
export function findChainsByTraceId(chains: MainlineChain[], traceId: string): MainlineChain[] {
  return chains.filter(c => c.traceId === traceId);
}
