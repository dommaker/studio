// NeedsAttentionSection — #184 监控页概览 Tab 顶部「需要处理」区（#62 D4 + #60 IA：行动信号 > 健康度量 > 参考资料）
// 首屏回答「现在有没有事需要我管」：告警收件箱 / 卡住计数（可下钻）/ 近 24h 失败趋势。
// #398（spec §7.3）：告警按归一化 message 签名分组（×N + 最近发生时间，>3 组折叠），纯前端不动探针口径。
// #456：stuck/failure 计数改读 /monitoring/overview 扩段（服务端单源，消「拉全量客户端统计」的
// 先截后滤漏单）；告警行明细仍前端翻页（triage 拍板：签名分组不挪服务端）。
// 自含数据加载：告警与 overview 各自独立取数，任一部分失败只显示该部分「加载失败」，不影响页面其余区块。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { eventsApi, type StudioEventItem } from '../../api/events';
import { monitoringApi } from '../../api/monitoring';
import { useAsyncData } from '../../hooks/useAsyncData';
import { formatAge } from '@dommaker/studio-shared/web';
import { groupAlertsBySignature, type AlertGroup, type AlertItem } from './alertGrouping';
import { MonitorSection } from './MonitorSection';
import { SkeletonText } from '../ui';

const HOUR = 3600_000;
/** 翻页防御上限（limit 200/页） */
const MAX_PAGES = 5;
/** 告警分组展示上限：超过折叠为「还有 N 类」（§7.3） */
const ALERT_GROUP_LIMIT = 3;

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

export function NeedsAttentionSection({ onAlertClick }: { onAlertClick?: (group: AlertGroup) => void }) {
  // #350 useAsyncData 收一次性拉取样板：两部分独立取数，各自 data/error/loading，互不阻塞
  const alerts = useAsyncData(() => loadAlerts(new Date(Date.now() - 24 * HOUR).toISOString()), []);
  // #456：stuck/failure 服务端单源（60s 服务端缓存；与 MonitoringPage 头部概览调用同端点）
  const overview = useAsyncData(async () => (await monitoringApi.getOverview()).data, []);
  const [showAllGroups, setShowAllGroups] = useState(false);

  const stuck = overview.data?.stuck;
  const failure = overview.data?.failure24h;
  const groups = alerts.data ? groupAlertsBySignature(alerts.data) : [];
  const visibleGroups = showAllGroups ? groups : groups.slice(0, ALERT_GROUP_LIMIT);
  const stuckTotal = stuck ? stuck.blocked + stuck.staleUnassigned + stuck.stalledActive : 0;
  const allClear =
    !alerts.error && !overview.error &&
    groups.length === 0 && stuckTotal === 0 && (failure?.n ?? 0) === 0;
  const loading = alerts.loading || overview.loading;

  return (
    <MonitorSection
      title="需要处理"
      subtitle="系统发现、需要人处理的事"
      stat={loading ? undefined : groups.length}
      statTestId="alert-group-count"
    >
      {loading ? (
        <SkeletonText lines={3} className="space-y-2" />
      ) : allClear ? (
        <div className="text-sm u-ok">现在没有需要你处理的事</div>
      ) : (
        <div className="space-y-3">
          {/* 告警收件箱：按归一化 message 签名分组（§7.3）；message 本身即大白话（#181 巡检探针产出） */}
          {alerts.error ? (
            <div className="text-sm u-err">告警加载失败</div>
          ) : groups.length > 0 ? (
            <div>
              <div className="space-y-1">
                {visibleGroups.map((g, i) => {
                  const row = (
                    <>
                      <span className={`text-xs px-2 py-0.5 rounded ${g.level === 'critical' ? 'u-err-dim u-err' : 'u-warn-dim u-warn'}`}>
                        {g.level === 'critical' ? '严重' : '警告'}
                      </span>
                      <span className="u-text" style={{ flex: 1, minWidth: 0 }}>{g.message}</span>
                      {g.count > 1 && <span className="text-xs font-bold u-text-2">×{g.count}</span>}
                      <span className="text-xs u-text-3">{formatAge(g.latestAt)}</span>
                    </>
                  );
                  // E4 告警下钻：点击告警组 → 事件检索 tab 预填签名过滤（onAlertClick 由 MonitoringPage 注入）
                  return onAlertClick ? (
                    <button
                      key={i}
                      type="button"
                      className="flex items-center gap-2 text-sm w-full text-left rounded px-1 -mx-1 u-hover-bg"
                      title="在事件检索中查看此类告警"
                      onClick={() => onAlertClick(g)}
                    >
                      {row}
                    </button>
                  ) : (
                    <div key={i} className="flex items-center gap-2 text-sm">{row}</div>
                  );
                })}
              </div>
              {groups.length > ALERT_GROUP_LIMIT && (
                <button className="u-btn-reset text-xs u-text-3 u-hover-accent mt-1" onClick={() => setShowAllGroups(v => !v)}>
                  {showAllGroups ? '收起' : `还有 ${groups.length - ALERT_GROUP_LIMIT} 类`}
                </button>
              )}
            </div>
          ) : (
            <div className="text-sm u-text-2">暂无告警</div>
          )}

          {/* 卡住计数：非零才显示，点击下钻到任务列表对应状态筛选 */}
          {overview.error ? (
            <div className="text-sm u-err">任务状态加载失败</div>
          ) : stuck && stuckTotal > 0 ? (
            <div className="flex flex-wrap gap-4 text-sm">
              {stuck.blocked > 0 && (
                <Link to="/workunits?status=blocked" className="u-err u-hover-accent">
                  阻塞 {stuck.blocked} 个
                </Link>
              )}
              {stuck.staleUnassigned > 0 && (
                <Link to="/workunits?status=unassigned" className="u-warn u-hover-accent">
                  待领取滞留 {stuck.staleUnassigned} 个
                </Link>
              )}
              {stuck.stalledActive > 0 && (
                <Link to="/workunits?status=active" className="u-warn u-hover-accent">
                  执行中停滞 {stuck.stalledActive} 个
                </Link>
              )}
            </div>
          ) : null}

          {/* 近 24h 失败趋势（事件流口径，对齐 #181 失败趋势探针；不画图） */}
          {overview.error ? (
            <div className="text-sm u-err">失败统计加载失败</div>
          ) : failure && failure.n > 0 ? (
            <div className="text-sm u-text-2">
              近 24 小时失败 {failure.n} 次 · 失败率 {Math.round((failure.rate ?? 0) * 100)}% · 比前一天{' '}
              {failure.trend === 'up' ? (
                <span className="u-err font-bold">↑</span>
              ) : failure.trend === 'down' ? (
                <span className="u-ok font-bold">↓</span>
              ) : failure.trend === 'flat' ? (
                <span className="u-text-3 font-bold">→</span>
              ) : (
                <span className="u-text-3">–</span>
              )}
            </div>
          ) : failure && failure.rate === null ? (
            <div className="text-sm u-text-2">近 24 小时无执行</div>
          ) : null}
        </div>
      )}
    </MonitorSection>
  );
}
