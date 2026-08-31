// #394 频道动态右栏（spec §4.2）纯函数：四站 stepper 推导 / 动态条目构建 / REQ 归属分流
// 数据源只读现成面：messages（卡片 / agent WU 消息）、channelReqs、waitingWus、/requirements/:id/chain
import type { ChannelMessage } from '../../api/channel';
import type { Requirement, RequirementChainWorkUnit } from '../../api/requirements';
import { parseMeta } from '../../utils/messageMeta';
import type { NeedInputTodo } from './ChannelNeedInputChip';

export type StepKey = 'discuss' | 'req' | 'wu' | 'deliver';
export type StepState = 'done' | 'current' | 'upcoming';

export interface ChainStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** WU 站可点目标：第一个非终态 WU；全终态回落最后一个；无 WU 缺省（不可点） */
  wuId?: string;
}

const WU_TERMINAL = new Set(['done', 'closed']);

/**
 * 四站 stepper「讨论 → REQ → WU n/m → 交付」状态推导：
 * 讨论恒 done；REQ 拆出 WU 即 done（否则 current）；WU 全终态 done / 有 WU 未终 current / 无 WU upcoming；
 * 交付在 WU 全终后 current；REQ 终态（done/archived）全线 done。
 */
export function deriveChainSteps(req: Requirement, wus: RequirementChainWorkUnit[]): ChainStep[] {
  const total = wus.length;
  const done = wus.filter(w => WU_TERMINAL.has(w.status)).length;
  const wuLabel = `WU ${done}/${total}`;
  const inflight = wus.find(w => !WU_TERMINAL.has(w.status)) ?? wus[wus.length - 1];
  if (req.status === 'done' || req.status === 'archived') {
    return [
      { key: 'discuss', label: '讨论', state: 'done' },
      { key: 'req', label: 'REQ', state: 'done' },
      { key: 'wu', label: wuLabel, state: 'done', ...(inflight ? { wuId: inflight.id } : {}) },
      { key: 'deliver', label: '交付', state: 'done' },
    ];
  }
  return [
    { key: 'discuss', label: '讨论', state: 'done' },
    { key: 'req', label: 'REQ', state: total > 0 ? 'done' : 'current' },
    {
      key: 'wu', label: wuLabel,
      state: total === 0 ? 'upcoming' : done === total ? 'done' : 'current',
      ...(inflight ? { wuId: inflight.id } : {}),
    },
    { key: 'deliver', label: '交付', state: done === total && total > 0 ? 'current' : 'upcoming' },
  ];
}

export interface ChannelActivityItem {
  id: string;
  kind: 'wu' | 'req' | 'card';
  text: string;
  /** ISO 时间戳；pinned 条目（NEED_INPUT 待办）无真实事件时刻，缺省 */
  at?: string;
  wuId?: string;
  reqId?: string;
  /** NEED_INPUT 待办：无时间字段，固定置顶排序，不伪造时间戳 */
  pinned?: boolean;
}

function metaCardType(meta: ChannelMessage['meta']): string | null {
  const ct = parseMeta(meta).cardType;
  return typeof ct === 'string' && ct ? ct : null;
}

function firstLine(s: string, max = 60): string {
  const line = (s || '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 频道动态条目：卡片消息 / agent WU 消息 / REQ / NEED_INPUT 待办，按时间倒序 */
export function buildChannelActivity(input: {
  messages: ChannelMessage[];
  reqs: Requirement[];
  waitingWus: NeedInputTodo[];
}): ChannelActivityItem[] {
  const items: ChannelActivityItem[] = [];
  for (const m of input.messages) {
    const ct = metaCardType(m.meta);
    if (ct) {
      items.push({
        id: m.id,
        kind: 'card',
        text: `${ct} 卡片 · ${firstLine(m.content, 40)}`,
        at: m.createdAt,
        ...(m.workUnitId ? { wuId: m.workUnitId } : {}),
      });
    } else if (m.authorType === 'agent' && m.workUnitId) {
      items.push({
        id: m.id,
        kind: 'wu',
        text: firstLine(m.content),
        at: m.createdAt,
        wuId: m.workUnitId,
      });
    }
  }
  for (const r of input.reqs) {
    items.push({
      id: `req-${r.id}`,
      kind: 'req',
      text: `${r.id} ${r.title} · ${r.status}`,
      at: r.createdAt,
      reqId: r.id,
    });
  }
  for (const w of input.waitingWus) {
    items.push({
      id: `wait-${w.wuId}`,
      kind: 'wu',
      text: `等待人工回复：${firstLine(w.question || w.scope || w.wuId.slice(0, 8), 48)}`,
      pinned: true,
      wuId: w.wuId,
    });
  }
  // pinned（NEED_INPUT 待办）恒置顶，其余按时间倒序
  return items.sort((a, b) =>
    Number(b.pinned ?? false) - Number(a.pinned ?? false) || (b.at ?? '').localeCompare(a.at ?? ''),
  );
}

/** REQ 归属分流：reqId 直挂优先，wuId 经 chain 归属映射，无归属落 other（「其他动态」） */
export function attributeActivity(
  items: ChannelActivityItem[],
  wuToReq: Map<string, string>,
): { byReq: Record<string, ChannelActivityItem[]>; other: ChannelActivityItem[] } {
  const byReq: Record<string, ChannelActivityItem[]> = {};
  const other: ChannelActivityItem[] = [];
  for (const it of items) {
    const reqId = it.reqId ?? (it.wuId ? wuToReq.get(it.wuId) : undefined);
    if (reqId) (byReq[reqId] ??= []).push(it);
    else other.push(it);
  }
  return { byReq, other };
}

export function fmtRelTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}
