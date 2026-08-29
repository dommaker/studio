// #393 频道首页重定向：最近访问频道记忆（localStorage）+ 落点决策纯函数
// 写入方 = ChannelDetailPage（进频道工作区即记）；消费方 = ChannelHomeRedirect（/ 与 /channels）
export const LAST_CHANNEL_KEY = 'studio:lastChannelId';

export function loadLastChannelId(storage: Pick<Storage, 'getItem'> = window.localStorage): string | null {
  return storage.getItem(LAST_CHANNEL_KEY);
}

export function saveLastChannelId(id: string, storage: Pick<Storage, 'setItem'> = window.localStorage): void {
  storage.setItem(LAST_CHANNEL_KEY, id);
}

/**
 * 重定向落点决策：最近访问（仍在列表）→ rnd 默认频道（B2-010 既有约定）→ 列表首个 → null（零频道，调用方渲染空态）
 */
export function resolveChannelHome(
  channels: ReadonlyArray<{ id: string; type?: string }>,
  lastId: string | null,
): string | null {
  if (channels.length === 0) return null;
  const hit = (id: string | null | undefined) => channels.find(c => c.id === id);
  const target = hit(lastId) ?? channels.find(c => c.type === 'rnd') ?? channels[0];
  return `/channels/${target.id}`;
}
