/** WU id 显示截短（#241/#242 共用）：长 id（UUID 形态）→ 前 8 位 + …；短 id（WU-N 形态）原样。全量 id 由 title/路由参数承载 */
export function shortWuId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
