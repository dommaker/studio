// ── readiness 状态（2026-10-03 根因修复 B 批）──
// listen 前移（ff546ba9）后「端口可服务 ≠ 全量就绪」：/health 只证 liveness，
// deploy 健康检查若拿它判就绪，会在后台初始化（core services / agent loop /
// channels / trigger handlers）完成前判绿，回滚护栏形同虚设。
// 本模块承载进程级 readiness：bootstrap 初始化链尾 markReady()，/readyz 据此
// 返 200；此前一律 503。bootstrap 拒启（catch → exit(1)）时进程死亡、/readyz
// 永不到 200——部署健康检查失败即回滚，语义与 listen 前移前对齐。

let readyAt: string | null = null;

/** bootstrap 全量初始化链尾调用一次（幂等） */
export function markReady(): void {
  if (!readyAt) readyAt = new Date().toISOString();
}

export function isReady(): boolean {
  return readyAt !== null;
}

export function readyTimestamp(): string | null {
  return readyAt;
}

/** 测试专用：重置进程内 readiness（跨用例隔离） */
export function resetReadiness(): void {
  readyAt = null;
}
