/**
 * channels/members 字段编解码（F3，从 file-store.ts 抽出）
 *
 * AgentProfile.channels / Channel.members 是「JSON 编码的字符串数组」字段，
 * 这里提供容错解析与写入端单层编码归一化。
 */

/**
 * F3: 解析「JSON 编码的字符串数组」字段（AgentProfile.channels / Channel.members）。
 * 单层解码：非数组/非字符串数组/损坏 JSON 一律返回 []。
 * （历史双重编码兼容层随 #696 存量验收退役——验收确认双侧零双编码存量。）
 */
export function parseChannels(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * F3: 写入端归一化 — 接受 string[] 或单层 JSON 字符串，
 * 输出单层 JSON 编码，保证落盘的 channels/members 字段永远只有一层编码。
 */
export function stringifyChannels(raw: unknown): string {
  return JSON.stringify(parseChannels(raw));
}
