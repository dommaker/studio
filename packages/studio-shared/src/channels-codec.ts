/**
 * channels/members 字段编解码（F3，从 file-store.ts 抽出）
 *
 * AgentProfile.channels / Channel.members 是「JSON 编码的字符串数组」字段，
 * 这里提供容错解析与写入端单层编码归一化。
 */

/**
 * F3: 容错解析「JSON 编码的字符串数组」字段（AgentProfile.channels / Channel.members）。
 * 历史写入 bug 曾把值二次 JSON 编码（"\"[\\\"id\\\"]\""），本函数最多解包 2 层编码；
 * 无法解析或不是字符串数组时返回 []。
 */
export function parseChannels(raw: unknown): string[] {
  let value: unknown = raw;
  for (let depth = 0; depth <= 2; depth++) {
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value !== 'string' || value.trim() === '') return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * F3: 写入端归一化 — 接受 string[] 或（可能多次编码的）JSON 字符串，
 * 输出单层 JSON 编码，保证落盘的 channels/members 字段永远只有一层编码。
 */
export function stringifyChannels(raw: unknown): string {
  return JSON.stringify(parseChannels(raw));
}
