/**
 * §10.5 角色级 token 滚动视图（只读聚合）。
 *
 * 数据源：
 *   - ~/.studio/logs/studio-events.jsonl 的 `workunit:tokens` 事件
 *     （payload: { workUnitId, injectedTokens, executionTokens|null, totalTokens }，agent-loop.ts M2）
 *   - FileStore workunits/index.json（assigneeId = 实例 id，metadata 可能含 collab.rootId）
 *   - FileStore agents/\<id\>/state.json（RuntimeState.id = 实例 id → roleId = profileId）
 *
 * 归因链：event.workUnitId → WU.assigneeId（实例）→ state.roleId（profile）。
 * 无法归因的事件（WU 缺失 / 未 claim / 实例无 state）跳过，不编造归属。
 *
 * 树口径（保持简单，文档化）：
 *   - 树 = metadata.collab.rootId 分组；无 rootId 的 WU 自成一树（key = 自身 id）。
 *   - treesParticipated = 该 profile 有 ≥1 个归因 WU 的树数。
 *   - avgTreeDepth = 这些树的平均深度，深度 = 全量 WU 索引中该树的 WU 总数（不限于本 profile）。
 *
 * 空数据返回全零，绝不抛错（路由对扫描型接口的约定）。
 */

import * as os from 'os';
import * as path from 'path';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { TREE_TOKEN_BUDGET } from '../workunit/delegation-gate.js';
import { readCollab } from '../workunit/delegation-gate.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');

/** 30s 内存缓存——该接口要扫 jsonl + WU 索引，轻量缓存避免连打 */
const CACHE_TTL_MS = 30_000;

export interface TokenUsageWindow {
  injectedTokens: number;
  executionTokens: number;
  totalTokens: number;
}

export interface AgentTokenUsage {
  profileId: string;
  totals: TokenUsageWindow;
  /** 本地自然日（与 now 同一天） */
  today: TokenUsageWindow;
  /** 滚动 7 天（now-7d ~ now） */
  rolling7d: TokenUsageWindow;
  /** 有 token 事件归因到本 profile 的去重 WU 数 */
  workUnitCount: number;
  trees: { participated: number; avgTreeDepth: number };
  generatedAt: string;
}

export interface TokenUsageOptions {
  eventsFile?: string;
  fileStore?: FileStore;
  /** 测试注入时钟 */
  now?: number;
}

interface CacheEntry {
  at: number;
  data: AgentTokenUsage;
}

const cache = new Map<string, CacheEntry>();

/** 测试/调试用：清空缓存 */
export function invalidateTokenUsageCache(): void {
  cache.clear();
}

function zeroWindow(): TokenUsageWindow {
  return { injectedTokens: 0, executionTokens: 0, totalTokens: 0 };
}

function zeroUsage(profileId: string): AgentTokenUsage {
  return {
    profileId,
    totals: zeroWindow(),
    today: zeroWindow(),
    rolling7d: zeroWindow(),
    workUnitCount: 0,
    trees: { participated: 0, avgTreeDepth: 0 },
    generatedAt: new Date().toISOString(),
  };
}

function sameLocalDay(ts: number, now: number): boolean {
  const a = new Date(ts);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 从 WU metadata（JSON 字符串）取 collab.rootId；兼容嵌套对象与点号平铺两种写法 */
function extractRootId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;
    const nested = (meta?.collab as Record<string, unknown> | undefined)?.rootId;
    if (typeof nested === 'string' && nested) return nested;
    const dotted = meta?.['collab.rootId'];
    if (typeof dotted === 'string' && dotted) return dotted;
    return null;
  } catch {
    return null;
  }
}

/**
 * 聚合指定 profile 的 token 使用视图。任何一步失败都返回全零（不抛错）。
 */
export async function getAgentTokenUsage(profileId: string, opts?: TokenUsageOptions): Promise<AgentTokenUsage> {
  const eventsFile = opts?.eventsFile ?? STUDIO_EVENTS_JSONL;
  const now = opts?.now ?? Date.now();

  const cacheKey = `${eventsFile}|${profileId}`;
  if (!opts?.now) {
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;
  }

  const result = await computeAgentTokenUsage(profileId, eventsFile, opts?.fileStore, now).catch(() => zeroUsage(profileId));
  cache.set(cacheKey, { at: now, data: result });
  return result;
}

async function computeAgentTokenUsage(
  profileId: string,
  eventsFile: string,
  fileStoreOpt: FileStore | undefined,
  now: number,
): Promise<AgentTokenUsage> {
  const fileStore = fileStoreOpt ?? new FileStore();
  const usage = zeroUsage(profileId);

  // 实例 → profile 映射
  const states = await fileStore.listStates().catch(() => []);
  const instanceToProfile = new Map<string, string>();
  for (const s of states) {
    if (s?.id && s?.roleId) instanceToProfile.set(s.id, s.roleId);
  }

  // WU 索引：id → snapshot；树大小按全量索引统计
  const wus = await fileStore.getIndex().catch(() => []);
  const wuById = new Map<string, WorkUnitSnapshot>(wus.map(w => [w.id, w] as [string, WorkUnitSnapshot]));
  const treeSize = new Map<string, number>();
  for (const wu of wus) {
    const key = extractRootId(wu.metadata) ?? wu.id;
    treeSize.set(key, (treeSize.get(key) ?? 0) + 1);
  }

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await fileStore.readJsonl<Record<string, unknown>>(eventsFile);
  } catch {
    rows = []; // 事件文件不存在/不可读 → 全零
  }

  const attributedWuIds = new Set<string>();
  const weekStart = now - 7 * 86_400_000;

  for (const row of rows) {
    if (row?.type !== 'workunit:tokens') continue;
    let payload: Record<string, unknown>;
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload as Record<string, unknown>) ?? {};
    } catch {
      continue; // payload 损坏的行跳过，不编造
    }
    const wuId = typeof payload.workUnitId === 'string' ? payload.workUnitId : null;
    if (!wuId) continue;

    const wu = wuById.get(wuId);
    if (!wu?.assigneeId) continue;
    if (instanceToProfile.get(wu.assigneeId) !== profileId) continue;

    const injected = typeof payload.injectedTokens === 'number' && Number.isFinite(payload.injectedTokens) ? payload.injectedTokens : 0;
    const execution = typeof payload.executionTokens === 'number' && Number.isFinite(payload.executionTokens) ? payload.executionTokens : 0;
    const total = typeof payload.totalTokens === 'number' && Number.isFinite(payload.totalTokens) ? payload.totalTokens : injected + execution;

    usage.totals.injectedTokens += injected;
    usage.totals.executionTokens += execution;
    usage.totals.totalTokens += total;
    attributedWuIds.add(wuId);

    const tsRaw = (row.createdAt ?? row.timestamp) as string | undefined;
    const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
    if (Number.isFinite(ts)) {
      if (sameLocalDay(ts, now)) {
        usage.today.injectedTokens += injected;
        usage.today.executionTokens += execution;
        usage.today.totalTokens += total;
      }
      if (ts >= weekStart && ts <= now + 60_000) {
        usage.rolling7d.injectedTokens += injected;
        usage.rolling7d.executionTokens += execution;
        usage.rolling7d.totalTokens += total;
      }
    }
  }

  usage.workUnitCount = attributedWuIds.size;

  // 树统计：profile 归因 WU 涉及的树
  const participatedKeys = new Set<string>();
  for (const wuId of attributedWuIds) {
    const wu = wuById.get(wuId);
    if (!wu) continue;
    participatedKeys.add(extractRootId(wu.metadata) ?? wu.id);
  }
  const depths = [...participatedKeys].map(k => treeSize.get(k) ?? 1);
  usage.trees = {
    participated: participatedKeys.size,
    avgTreeDepth: depths.length > 0 ? depths.reduce((a, b) => a + b, 0) / depths.length : 0,
  };

  return usage;
}

// ── §8.4.3 树聚合（AC-5.5）──

export interface TreeTokenReport {
  rootId: string;
  nodes: Array<{
    workUnitId: string;
    profileName: string | null;
    status: string;
    injectedTokens: number | null;
    executionTokens: number | null;
    totalTokens: number | null;
  }>;
  rootTotal: number;
  budgetRemaining: number;
}

/**
 * 按 rootId 聚合树内每 WU 的 token 开销（只读，不修改事件文件）。
 * 文件不存在/索引为空 -> 返回全零报告（不抛错）。
 */
export async function aggregateTreeTokens(
  rootId: string,
  fileStore: FileStore,
  opts?: { eventsFile?: string },
): Promise<TreeTokenReport> {
  const eventsFile = opts?.eventsFile ?? STUDIO_EVENTS_JSONL;

  // 1. 找出子树 WU + 建立 workUnitId -> snapshot 映射
  const snapshots = await fileStore.getIndex().catch(() => [] as WorkUnitSnapshot[]);
  const treeNodes = new Map<string, WorkUnitSnapshot>();
  const root = snapshots.find(s => s.id === rootId);
  if (root) treeNodes.set(rootId, root);
  for (const s of snapshots) {
    const collab = readCollab(s.metadata);
    if (collab?.rootId === rootId) treeNodes.set(s.id, s);
  }

  // 2. 读 events 聚合每 WU 的 tokens
  const perWuTokens = new Map<string, { injected: number; execution: number }>();
  try {
    const events = await fileStore.readJsonl<Record<string, unknown>>(eventsFile);
    for (const evt of events) {
      if (evt?.type !== 'workunit:tokens') continue;
      let payload: Record<string, unknown>;
      try {
        payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : (evt.payload as Record<string, unknown>) ?? {};
      } catch {
        continue;
      }
      const wuId = typeof payload.workUnitId === 'string' ? payload.workUnitId : null;
      if (!wuId || !treeNodes.has(wuId)) continue;
      const prev = perWuTokens.get(wuId) ?? { injected: 0, execution: 0 };
      const injected = typeof payload.injectedTokens === 'number' ? payload.injectedTokens : 0;
      const execution = typeof payload.executionTokens === 'number' ? payload.executionTokens : 0;
      prev.injected += injected;
      prev.execution += execution;
      perWuTokens.set(wuId, prev);
    }
  } catch {
    // 文件不存在 -> 全零
  }

  // 3. 读 profiles 拿 name（assigneeId 是 instance id，需经 state.roleId 反查 profile）
  const allStates = await fileStore.listStates().catch(() => []);
  const allProfiles = await fileStore.listProfiles().catch(() => []);
  const instanceToProfile = new Map<string, string>();
  for (const st of allStates) {
    if (st?.id && st?.roleId) instanceToProfile.set(st.id, st.roleId);
  }
  const profileNameById = new Map<string, string>();
  for (const p of allProfiles) {
    profileNameById.set(p.id, p.name);
  }

  // 4. 组装 nodes
  const nodes: TreeTokenReport['nodes'] = [];
  let rootTotal = 0;
  for (const [wuId, snap] of treeNodes) {
    const tokens = perWuTokens.get(wuId);
    const profileId = snap.assigneeId ? instanceToProfile.get(snap.assigneeId) : undefined;
    const profileName = profileId ? profileNameById.get(profileId) ?? null : null;
    const injected = tokens?.injected ?? null;
    const execution = tokens?.execution ?? null;
    const total = tokens ? tokens.injected + tokens.execution : null;
    nodes.push({
      workUnitId: wuId,
      profileName,
      status: snap.status,
      injectedTokens: injected,
      executionTokens: execution,
      totalTokens: total,
    });
    if (typeof execution === 'number') rootTotal += execution;
  }

  return {
    rootId,
    nodes,
    rootTotal,
    budgetRemaining: TREE_TOKEN_BUDGET - rootTotal,
  };
}
