# apps/api/src/modules/agent-ops

### 职责

进程级守护（P2-d 刀3 自 modules/agents/ops 提升为顶层模块）：preflight 启动检查、health 轮询自愈、代理守护、默认数据 ensure。OpsService 由 bootstrap/services 启动链装配（monitor → auditor → rollup → OpsService → EvolutionScheduler）。

### 目录结构

- `ops.service.ts` — OpsService 门面 + `createOpsService` 工厂（唯一公共导出）；`createHealthRoutes`（/healthz 健康端点，当前无消费方）
- `ops-rules.ts` — 守护规则加载（processes_to_clean 等契约）
- `system-health.ts` — collectSystemHealth / checkThresholds / runGC（done/closed 且 completedAt >30 天 WU 清理，无生产接线仅测试可达）
- `__tests__/` — ops-health-probe（探针语义防回归）、ops-agent-resilience、ops-worktree-gc、system-health

### 核心导出

- `index.ts` — 模块公共出口 barrel：`createOpsService`
- `ops.service`（preflight 启动检查/health 轮询自愈/代理守护/默认数据 ensure；#409 起 worktree GC 已归一到 agents/monitor 的 monitor-system-probes.gcStaleWorktrees 单实现，Ops 版 cleanupWorktrees 及其 hourly 挂载删除；#571 起 frontend dist 检查委托 utils/frontend-dist.ts——npm 形态缺 dist = 包损坏 critical abort，auto-build 仅 monorepo dev 形态保留）
- 系统探测 /proc 单出口在 `core/proc-probes.ts`（P2-c 下沉；本模块委托消费，原 agents/ops/proc-probes.ts 门面随本刀删除）

### 依赖关系

- 上游：`core/`（store/proc-probes）、`modules/auth`（hashPassword）、`utils/`（studio-events/frontend-dist）、动态 import `modules/knowledge` / `modules/channels` / `modules/workunit`（自愈动作，压环）
- 下游：`bootstrap/services.ts`、`cli/run-web.ts`、`cli/server.ts`、`route-registry.ts`（/health 探针）

### 注意事项

- **Ops 看门狗探针语义（2026-09-21，生产假阴性自杀循环事故修复）**：`ops.service getStatus()` 探针打免鉴权 `/health`（app.ts 注册于鉴权中间件之前，不依赖任何业务路由），**收到任何 HTTP 响应（含 401/403/5xx）即判活，只有连接失败/超时才判死**——严禁改回「业务路由 + statusCode===200」判定（2026-09-15 /api/v1/channels 加 requireAuth 后恒 401 → apiResponding 恒 false → healthCheck 每 5 分钟 process.exit(1) → systemd 拉起，单日 193 次重启、真实流量物理不可达）。防回归测试：`__tests__/ops-health-probe.test.ts`。已知残留假阴性面（未修，仅记录）：判死后 daemon-busy 豁免检查的 `fileStore.getIndex` 读失败被 catch 静默吞掉 → 有活跃执行 session 也照 exit
- **系统探测 /proc 单出口（#344）**：新探测先落 `core/proc-probes.ts`（零子进程）。磁盘 = statfs (blocks−bavail)/blocks（含 root 保留块，比 df Use% 偏高 1–5pp）；内存 = MemTotal−MemAvailable；僵尸 = /proc/<pid>/stat state=Z。#418 起命令行类探测同出口：readProcessCmdline/countProcessesByCmdline/listPidsByCmdline/listZombieProcesses
- **WU 删除走 service.delete 单口（#538，ADR 2026-09-15 决策 3）**：system-health runGC 的筛选逻辑留调用方，删除循环改调 `service.delete(id, { reason })`；runGC 接线与否仍为独立 needs-triage 票
- preflight 其余同步 exec（vite build/cloudflared nohup spawn）为启动一次性路径，#374 方案未列，保留
