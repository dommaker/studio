// HTTP 错误判定工具：axios 错误按 status 分类。
// 403（无权限）在组件层判定——axios 拦截器只处理 401（刷新 token 重试），不混淆两种语义（见 api/index.ts）。

/** 是否为 axios 403 响应错误（Admin-only 接口对非 Admin 的降级判定依据） */
export function isForbidden(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 403;
}
