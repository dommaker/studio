/**
 * 监听地址解析（2026-08-25 安全收口）
 *
 * 默认绑 127.0.0.1：服务器模式（nginx/cloudflared 同机回环反代）与 npm 自托管
 * 模式（STUDIO_AUTH=none 免登录）都不需要对非回环地址监听；确需对外暴露时
 * 显式 HOST=0.0.0.0。
 *
 * 硬守卫：STUDIO_AUTH=none（免登录，所有请求注入 Admin）下绑定非回环地址
 * 等于把 Admin 控制面暴露给整个网络——直接拒绝启动。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export function resolveListenHost(env: { HOST?: string; STUDIO_AUTH?: string }): string {
  const host = env.HOST || '127.0.0.1';
  const authNone = (env.STUDIO_AUTH || 'none') === 'none';
  if (authNone && !isLoopbackHost(host)) {
    throw new Error(
      `STUDIO_AUTH=none（免登录模式）禁止绑定非回环地址 HOST=${host}：` +
        `所有请求会被注入 Admin 身份，对外监听等于公开 Admin 控制面。` +
        `请设 HOST=127.0.0.1，或显式 STUDIO_AUTH=on 开启认证。`
    );
  }
  return host;
}
