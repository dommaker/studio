/**
 * 监听地址解析（2026-08-25 安全收口）
 *
 * 默认绑 127.0.0.1：服务器模式（nginx/cloudflared 同机回环反代）与 npm 自托管
 * 模式（STUDIO_AUTH=none 免登录）都不需要对非回环地址监听；确需对外暴露时
 * 显式 HOST=0.0.0.0。
 *
 * 暴露策略由 bootstrap/exposure-policy 在全部配置加载后统一校验。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function resolveListenHost(env: { HOST?: string }): string {
  return env.HOST || '127.0.0.1';
}
