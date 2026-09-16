/**
 * cloudflared — 隧道启停判定（#571 冲突 5 冻结结论：外联隧道默认关）
 *
 * 仅显式 CLOUDFLARED_ENABLED=true 才拉起隧道；未设置/其他值一律不启用。
 * 现有服务器形态部署需在其 config.env 显式开启（行为翻转，发布说明标注）。
 */

export function isCloudflaredEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOUDFLARED_ENABLED === 'true';
}
