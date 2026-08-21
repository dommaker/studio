// NeedsAttentionSection — #184 监控页概览 Tab 顶部「需要处理」区（#62 D4 + #60 IA：行动信号 > 健康度量 > 参考资料）
// 首屏回答「现在有没有事需要我管」：告警收件箱 / 卡住计数（可下钻）/ 近 24h 失败趋势。
// 自含数据加载：三部分各自独立取数，任一部分失败只显示该部分「加载失败」，不影响页面其余区块。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { eventsApi, type StudioEventItem } from '../../api/events';
import { workunitApi } from '../../api/workunit';
import { formatAge, POOL_STAGNATION_WARN_MS } from '@dommaker/studio-shared/web';

const HOUR = 3600_000;
/** 待认领滞留阈值（对齐 #181 池滞留探针，正本在 studio-shared/constants/monitoring） */
const STALE_UNASSIGNED_MS = POOL_STAGNATION_WARN_MS;
/** 翻页防御上限（limit 200/页） */
const MAX_PAGES = 5;

interface AlertItem {
  level: 'warning' | 'critical';
  message: string;
  createdAt?: string;
}

interface StuckCounts {
  blocked: number;
  staleUnassigned: number;
  stalledActive: number;
}

interface FailureStats {
  /** 近 24h 失败次数（workunit:failed 终态 + 失败执行步，对齐 #181 失败趋势探针口径） */
  n: number;
  /** 近 24h 失败率；null = 窗口内无执行样本 */
  rate: number | null;
  /** 近 24h vs 前 24h 失败率；null = 前窗口无样本，无法比 */
  trend: 'up' | 'down' | 'flat' | null;
}

/** 沿 nextCursor 翻页取全（防御上限 MAX_PAGES 页） */
async function searchAll(params: Parameters<typeof eventsApi.search>[0]): Promise<StudioEventItem[]> {
  const out: StudioEventItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await eventsApi.search({ ...params, cursor });
    out.push(...res.data.events);
    if (!res.data.nextCursor) break;
    cursor = res.data.nextCursor;
  }
  return out;
}

/** 防御解析事件 payload JSON；非法返回 null */
function parsePayload(payload: unknown): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadAlerts(since24: string): Promise<AlertItem[]> {
  const rows = await searchAll({ type: 'monitor:alert', level: 'warning', since: since24, limit: 200 });
  const out: AlertItem[] = [];
  for (const row of rows) {
    const p = parsePayload(row.payload);
    const message = typeof p?.message === 'string' ? p.message : null;
    if (!message) continue; // 非法 JSON / 缺 message 的行跳过
    const level = row.level === 'critical' ? 'critical' : 'warning';
    out.push({ level, message, createdAt: row.createdAt });
  }
  return out;
}

async function loadStuck(now: number): Promise<StuckCounts> {
  const [blockedRes, unassignedRes, activeRes] = await Promise.all([
    workunitApi.list({ status: 'blocked', limit: 1 }),
    workunitApi.list({ status: 'unassigned', limit: 200 }),
    workunitApi.list({ status: 'active', limit: 200 }),
  ]);
  return {
    blocked: blockedRes.data.pagination.total,
    staleUnassigned: unassignedRes.data.data.filter(
      w => now - new Date(w.createdAt).getTime() > STALE_UNASSIGNED_MS,
    ).length,
    // #178 租约语义：timeoutAt 非空且已过期 = 执行 loop 失联（5min 心跳未续）
    stalledActive: activeRes.data.data.filter(
      w => w.timeoutAt && new Date(w.timeoutAt).getTime() < now,
    ).length,
  };
}

interface WindowCounts { failedSteps: number; successSteps: number; wuFailed: number }

function emptyWindow(): WindowCounts {
  return { failedSteps: 0, successSteps: 0, wuFailed: 0 };
}

async function loadFailures(now: number, since48: string): Promise<FailureStats> {
  const [stepRows, wuFailedRows] = await Promise.all([
    searchAll({ type: 'workunit:execution_step', since: since48, limit: 200 }),
    searchAll({ type: 'workunit:failed', since: since48, limit: 200 }),
  ]);
  const cutoff24 = now - 24 * HOUR;
  const recent = emptyWindow();
  const prev = emptyWindow();

  for (const row of stepRows) {
    const p = parsePayload(row.payload);
    if (!p) continue;
    const at = row.createdAt ?? (typeof p.at === 'string' ? p.at : undefined);
    if (!at) continue;
    const t = new Date(at).getTime();
    if (!Number.isFinite(t)) continue;
    const win = t >= cutoff24 ? recent : prev;
    // #172：历史事件无 status 字段 → 缺省 success
    if (p.status === 'failed') win.failedSteps++; else win.successSteps++;
  }
  for (const row of wuFailedRows) {
    if (!row.createdAt) continue;
    const t = new Date(row.createdAt).getTime();
    if (!Number.isFinite(t)) continue;
    (t >= cutoff24 ? recent : prev).wuFailed++;
  }

  const stats = (w: WindowCounts) => {
    const n = w.wuFailed + w.failedSteps;
    const denom = n + w.successSteps;
    return { n, rate: denom > 0 ? n / denom : null };
  };
  const r = stats(recent);
  const p = stats(prev);
  const trend = r.rate !== null && p.rate !== null
    ? r.rate > p.rate ? 'up' : r.rate < p.rate ? 'down' : 'flat'
    : null;
  return { n: r.n, rate: r.rate, trend };
}

interface PartState<T> {
  data: T | null;
  error: boolean;
}

export function NeedsAttentionSection() {
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<PartState<AlertItem[]>>({ data: null, error: false });
  const [stuck, setStuck] = useState<PartState<StuckCounts>>({ data: null, error: false });
  const [failure, setFailure] = useState<PartState<FailureStats>>({ data: null, error: false });

  useEffect(() => {
    const now = Date.now();
    const since24 = new Date(now - 24 * HOUR).toISOString();
    const since48 = new Date(now - 48 * HOUR).toISOString();
    // 三部分独立加载，互不阻塞；setState 全部在 promise 回调里
    loadAlerts(since24)
      .then(data => setAlerts({ data, error: false }))
      .catch(() => setAlerts({ data: null, error: true }))
      .finally(() => setLoading(false));
    loadStuck(now)
      .then(data => setStuck({ data, error: false }))
      .catch(() => setStuck({ data: null, error: true }));
    loadFailures(now, since48)
      .then(data => setFailure({ data, error: false }))
      .catch(() => setFailure({ data: null, error: true }));
  }, []);

  const stuckTotal = stuck.data ? stuck.data.blocked + stuck.data.staleUnassigned + stuck.data.stalledActive : 0;
  const allClear =
    !alerts.error && !stuck.error && !failure.error &&
    (alerts.data?.length ?? 0) === 0 && stuckTotal === 0 && (failure.data?.n ?? 0) === 0;

  return (
    <div className="card p-4 mt-4">
      <h2 className="mc-block-label" style={{ margin: '0 0 10px' }}>需要处理</h2>
      {loading ? (
        <div className="text-sm u-text-2">加载中...</div>
      ) : allClear ? (
        <div className="text-sm u-ok">现在没有需要你处理的事</div>
      ) : (
        <div className="space-y-3">
          {/* 告警收件箱：monitor:alert 的 message 本身即大白话（#181 巡检探针产出） */}
          {alerts.error ? (
            <div className="text-sm u-err">告警加载失败</div>
          ) : alerts.data && alerts.data.length > 0 ? (
            <div>
              <div className="text-sm u-text-3 mb-1">告警（{alerts.data.length}）</div>
              <div className="space-y-1">
                {alerts.data.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className={`text-xs px-2 py-0.5 rounded ${a.level === 'critical' ? 'u-err-dim u-err' : 'u-warn-dim u-warn'}`}>
                      {a.level === 'critical' ? '严重' : '警告'}
                    </span>
                    <span className="u-text" style={{ flex: 1, minWidth: 0 }}>{a.message}</span>
                    <span className="text-xs u-text-3">{formatAge(a.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-sm u-text-2">暂无告警</div>
          )}

          {/* 卡住计数：非零才显示，点击下钻到任务列表对应状态筛选 */}
          {stuck.error ? (
            <div className="text-sm u-err">任务状态加载失败</div>
          ) : stuck.data && stuckTotal > 0 ? (
            <div className="flex flex-wrap gap-4 text-sm">
              {stuck.data.blocked > 0 && (
                <Link to="/workunits?status=blocked" className="u-err u-hover-accent">
                  阻塞 {stuck.data.blocked} 个
                </Link>
              )}
              {stuck.data.staleUnassigned > 0 && (
                <Link to="/workunits?status=unassigned" className="u-warn u-hover-accent">
                  待认领滞留 {stuck.data.staleUnassigned} 个
                </Link>
              )}
              {stuck.data.stalledActive > 0 && (
                <Link to="/workunits?status=active" className="u-warn u-hover-accent">
                  执行中停滞 {stuck.data.stalledActive} 个
                </Link>
              )}
            </div>
          ) : null}

          {/* 近 24h 失败趋势（事件流口径，对齐 #181 失败趋势探针；不画图） */}
          {failure.error ? (
            <div className="text-sm u-err">失败统计加载失败</div>
          ) : failure.data && failure.data.n > 0 ? (
            <div className="text-sm u-text-2">
              近 24 小时失败 {failure.data.n} 次 · 失败率 {Math.round((failure.data.rate ?? 0) * 100)}% · 比前一天{' '}
              {failure.data.trend === 'up' ? (
                <span className="u-err font-bold">↑</span>
              ) : failure.data.trend === 'down' ? (
                <span className="u-ok font-bold">↓</span>
              ) : failure.data.trend === 'flat' ? (
                <span className="u-text-3 font-bold">→</span>
              ) : (
                <span className="u-text-3">–</span>
              )}
            </div>
          ) : failure.data && failure.data.rate === null ? (
            <div className="text-sm u-text-2">近 24 小时无执行</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
