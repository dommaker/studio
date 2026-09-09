// alertGrouping — #398 监控页「需要处理」告警分组（spec §7.3）
// 按归一化 message 签名分组：级别 pill + 文案 + ×N + 最近发生时间。纯前端聚合，不动探针产出口径。
// 归一化 = 数字与 hex id 片段替换为占位符，使「滞留 5h」「滞留 7h」归为一类。

export interface AlertItem {
  level: 'warning' | 'critical';
  message: string;
  createdAt?: string;
}

export interface AlertGroup {
  level: 'warning' | 'critical';
  /** 展示文案：组内最近一条的原始 message */
  message: string;
  count: number;
  /** 组内最近发生时间；全部缺 createdAt 时为 undefined */
  latestAt?: string;
}

/** 归一化签名：hex id（8 位以上）与数字一律占位，消除实例/数值差异 */
export function alertSignature(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, 'N');
}

/** E4 告警下钻：告警 message → 事件检索 keyword。签名中的 <id>/N 占位无法子串匹配 payload，
    故按 hex id/数字段切分原文，取剩余最长文本段（同组不同数值的告警共享该稳定段）。
    全由数值/id 构成时返回 ''（调用方退化为仅 type 过滤）。 */
export function alertSignatureKeyword(message: string): string {
  const segments = message
    .split(/\b[0-9a-f]{8,}\b|\d+/gi)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  segments.sort((a, b) => b.length - a.length);
  return segments[0] ?? '';
}

export function groupAlertsBySignature(alerts: AlertItem[]): AlertGroup[] {
  const byKey = new Map<string, { level: AlertItem['level']; items: AlertItem[] }>();
  for (const a of alerts) {
    const key = `${a.level}|${alertSignature(a.message)}`;
    const entry = byKey.get(key);
    if (entry) entry.items.push(a);
    else byKey.set(key, { level: a.level, items: [a] });
  }

  const groups: AlertGroup[] = [];
  for (const { level, items } of byKey.values()) {
    let latest: AlertItem | undefined;
    for (const item of items) {
      if (!latest) { latest = item; continue; }
      const t = item.createdAt ? new Date(item.createdAt).getTime() : NaN;
      const lt = latest.createdAt ? new Date(latest.createdAt).getTime() : NaN;
      if (Number.isFinite(t) && (!Number.isFinite(lt) || t > lt)) latest = item;
    }
    groups.push({ level, message: latest?.message ?? items[0].message, count: items.length, latestAt: latest?.createdAt });
  }

  // critical 优先，同级按最近发生时间降序（无时间的排尾）
  groups.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'critical' ? -1 : 1;
    const ta = a.latestAt ? new Date(a.latestAt).getTime() : 0;
    const tb = b.latestAt ? new Date(b.latestAt).getTime() : 0;
    return tb - ta;
  });
  return groups;
}
