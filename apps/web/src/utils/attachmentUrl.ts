// 频道图片附件 URL 助手（2026-09，「频道里加上截图」）。
// 消息体只存相对 URL（不带 token——token 不落库不进历史）；<img> 无法带 Authorization 头，
// 渲染时现拼 ?token= JWT（buildSseUrl 同款现取 useAuthStore token）。
import { useAuthStore } from '../stores/authStore';

/** 本系统频道附件相对 URL 判定（扩展名白名单与后端一致） */
export const CHANNEL_ATTACHMENT_SRC_RE =
  /^\/api\/v1\/channels\/[^/]+\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i;

/**
 * img src 解析：命中频道附件 URL → 拼当前登录 token；其余 src 原样透传。
 * 无 token（未登录/免登录模式 STUDIO_AUTH=none 无 session）→ 原样，由后端鉴权语义决定成败。
 */
export function resolveAttachmentSrc(src: string | undefined): string | undefined {
  if (!src || !CHANNEL_ATTACHMENT_SRC_RE.test(src)) return src;
  const token = useAuthStore.getState().token;
  return token ? `${src}?token=${encodeURIComponent(token)}` : src;
}
