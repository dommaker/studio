// 频道图片附件 URL 判定；凭证交换由 AttachmentImage 异步完成，不进入消息历史。

/** 本系统频道附件相对 URL 判定（扩展名白名单与后端一致） */
export const CHANNEL_ATTACHMENT_SRC_RE =
  /^\/api\/v1\/channels\/[^/]+\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i;

/** 兼容既有调用方：URL 本身永不追加登录凭证。 */
export function resolveAttachmentSrc(src: string | undefined): string | undefined {
  return src;
}
