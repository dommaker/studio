/**
 * CORS Origin 白名单判定（2026-08-25 安全收口）。
 *
 * 生产 web 与 API 同源（dommaker.cn），本不需要 CORS；白名单覆盖：
 * - env CORS_ORIGINS 显式列表（逗号分隔，缺省 dommaker.cn 两域）
 * - 本地开发（localhost / 127.0.0.1 任意端口，vite dev 等）
 * - cloudflared quick tunnel（*.trycloudflare.com，临时隧道域名每次重启都变）
 */
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const QUICK_TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

const DEFAULT_ORIGINS = 'https://dommaker.cn,https://www.dommaker.cn';

export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? DEFAULT_ORIGINS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  // 无 Origin 头 = 非浏览器跨域场景（同源导航 / curl / agent CLI），不由 CORS 管
  if (!origin) return true;
  return (
    allowedOrigins().includes(origin) ||
    LOCALHOST_RE.test(origin) ||
    QUICK_TUNNEL_RE.test(origin)
  );
}
