// 频道阅读位置持久化（#290 清单 #27，参照 dsh chatScroll.read()/save() 语义）
// 直调 localStorage（站内 ThemeContext 同款模式，不抽象通用 storage hook）。
// 存档语义：{mid, top} = 锚消息行 + 视口相对位置（抗重排）；null = 钉在底部；
// 无存档（undefined）= 首次进入，定位底部。
// jsdom 无布局，序列化/解析抽纯函数单测；组件侧只负责捕获/恢复时机。

const KEY_PREFIX = 'studio-channel-reading-pos:';

export interface ReadingPosition {
  mid: string;
  top: number;
}

/** 序列化存档（含 null=钉底）；返回值即 localStorage 写入内容 */
export function serializeReadingPosition(pos: ReadingPosition | null): string {
  return JSON.stringify(pos);
}

/**
 * 解析存档原文：raw 为 null（未写过）→ undefined（无存档）；
 * 合法 JSON null → null（钉底）；合法 {mid, top} → 锚点；
 * 腐化数据按无存档处理（不阻断进入频道）。
 */
export function parseReadingPosition(raw: string | null): ReadingPosition | null | undefined {
  if (raw === null) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null) return null;
    if (typeof v === 'object' && v !== null) {
      const { mid, top } = v as { mid?: unknown; top?: unknown };
      if (typeof mid === 'string' && mid.length > 0 && typeof top === 'number' && Number.isFinite(top)) {
        return { mid, top };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveReadingPosition(channelId: string, pos: ReadingPosition | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY_PREFIX + channelId, serializeReadingPosition(pos));
  } catch { /* 隐私模式/quota 满：阅读位置是增强体验，静默降级 */ }
}

export function loadReadingPosition(channelId: string): ReadingPosition | null | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return parseReadingPosition(window.localStorage.getItem(KEY_PREFIX + channelId));
  } catch {
    return undefined;
  }
}
