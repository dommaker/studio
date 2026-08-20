/**
 * 消息 meta object×string 双型解析（#264 人审卡片全灭修复定下的口径）。
 *
 * 存储层 meta 是 JSON 字符串；部分读取路径（shapeMessageData 等）已解析为 object。
 * 与前端 apps/web/src/utils/messageMeta.ts parseMeta 同一逻辑的后端正本：
 * object 直接取用；string 则 JSON.parse，解析失败回退 {}（不抛出）。
 */
export function parseMessageMeta(
  meta?: string | Record<string, unknown> | null,
): Record<string, unknown> {
  if (typeof meta === 'string') {
    try { return JSON.parse(meta || '{}'); } catch { return {}; }
  }
  return meta ?? {};
}
