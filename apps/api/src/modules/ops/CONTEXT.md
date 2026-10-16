# apps/api/src/modules/ops

### 职责

监控/ops 合一模块（#683：原 `modules/monitoring` 指标聚合 + `modules/agent-monitor` 巡检告警 + `modules/agent-ops` 进程守护 + `src/monitoring` Prometheus 四面合并）：

- Prometheus `/metrics` 端点指标（prom-client 默认注册表 + collectDefaultMetrics，label `app: 'agent-studio'`）
- Agent Network 监控指标聚合（Agent 摘要、统计信息、飞轮指标 M1、封装开销 M2），经 HTTP 路由对外暴露
- Monitor Agent：5min 轮询健康监控 + 渐进告警 + 轨迹评估/每日洞察 + 知识沉淀闸门与每日 TTL 清理 + 实例超时巡检
- OpsService 进程级守护：preflight 启动检查、health 轮询自愈、代理守护、默认数据 ensure

由 bootstrap/services 启动链装配（monitor 为启动链第一环；启动顺序 monitor → auditor → rollup → OpsService → EvolutionScheduler）。

### 目录结构

- `prometheus-metrics.ts` — Prometheus 注册表与 `getMetrics`（#683 自 `src/monitoring/index.ts` 迁入）
- `monitoring.routes.ts` — Express 路由器，挂载 `/agents`、`/stats`、`/flywheel`、`/overhead`、`/overview`、`/efficiency` 六个 GET 端点
- `monitoring.service.ts` — `MonitoringService` 监控服务类，封装聚合逻辑，依赖 `KnowledgeMetricsSource` 获取度量数据
- `metrics.service.ts` — D16 指标聚合服务：`getOverviewMetrics({windowDays})`，60s 内存缓存，`invalidateCache()` 测试用
- `metrics-aggregate.ts` — D16 聚合核心纯函数（`aggregateOverview` / `aggregateCacheHitRate` / `aggregateSectionTrim`，经 `metrics.service.ts` re-export）
- `metrics.types.ts` — D16 类型契约（`OverviewMetrics` 等 9 组指标接口，经 `metrics.service.ts` re-export）
- `current-wu-context.ts` — #318 共享出口：当前 WU 聚合上下文（快照 + pmo 归属链 + channelId）
- `monitor.service.ts` — Monitor 门面（5min 轮询健康监控 + 渐进告警）
- `monitor-probes.ts` — WU 级探测（失败趋势/停滞/超时/池停滞/评审停滞/僵尸认领守卫——#464 起 stale_claim_guard 命中除告警外同步向 WU 所在频道发「已沉睡」milestone 提醒；#610 起 expireTriggerPendingWorkUnits——trigger 建单 pending 超期未确认自动关闭，阈值 TRIGGER_PENDING_EXPIRY_DAYS 默认 7 天，人工建的 pending 单不受影响，decision/spec/plan 豁免）
- `monitor-system-probes.ts` — 系统/知识级探测与自修复（#409 起 worktree GC 唯一入口 gcStaleWorktrees——7d 阈值、prune 走 execAsync、不调 git worktree remove；#611 起 checkKnowledgeHealth 日级门控含 consumption 归零告警；harness 3.0.0/ADR-0041 起知识健康分与自动修复改判 KnowledgeAudit 唯一正本——healthScore.before，口径由「100 − error×3 − warn×1」换 audit 打分，阈值 60 不变）
- `monitor-alerts.ts` — 告警分发/Triage 升级（指纹冷却去重 w4h/c1h）
- `monitor-reports.ts` — 轨迹评估/每日洞察/交互观察
- `monitor-lifecycle.ts` — 知识沉淀闸门+每日 TTL 清理（#653 起 studio-events.jsonl 清理已删——事件保留执法归 studio-events-rotation 单口）
- `lock-events-bridge.ts` — lock.* 事件 → Monitor 告警桥（#169；#687 自 events 模块迁入——桥消费的是 Monitor 能力，归属本模块，斩断 events 基础设施反向依赖）
- `instance-timeout-scan.ts` — 心跳过期 5min 扫描+pid 复核（依赖 monitor-alerts；#363 统一回收 terminated 实例；2026-09-24 起 terminate 死实例后连带释放其持有的 active WU 回池）
- `types.ts` — MonitorAlert/MonitorAlertSource 类型
- `ops.service.ts` — OpsService 门面 + `createOpsService` 工厂
- `ops-rules.ts` — 守护规则加载（processes_to_clean 等契约）
- `__tests__/` — monitor-* / monitoring-* / metrics / ops-* / current-wu-context 等 20 个测试

### 核心导出

- `index.ts` — 模块公共出口 barrel：`getMetrics`、`loadCurrentWuContexts` + `CurrentWuContext`（type）、`scanStaleAgentInstances`、`initLockEventsBridge`、`dispatchMonitorAlerts` / `emitMonitorEvent`、`monitorService`、`MonitorAlert` / `MonitorAlertSource`（type）、`createOpsService`
- `default` (Router) — `monitoring.routes.ts`（深路径动态 import 仅限 route-registry 白名单）
- `MonitoringService` / `MetricsService` / `INJECTED_TOKEN_BUDGET` / `OVERHEAD_RATIO_BUDGET` 等维持深路径消费现状（bench、模块内测试、prompt-composer 测试）
- `KnowledgeMetricsSource` (接口) — 知识度量源接口（DI 注入，默认 lazy 获取生产单例，避免模块加载期副作用），定义 `getFlywheelMetrics` 和 `getAuditReport`
- `FlywheelStats` / `OverheadStats` / `AgentSummary` / `AgentCurrentWorkUnit` / `AgentPmoSummary` / `MonitoringServiceDeps`（接口）— M1/M2 指标类型与 /monitoring/agents 聚合类型

### 依赖关系

- 上游：`@dommaker/studio-shared`（FileStore 等）、`modules/agents`（barrel：AgentInstanceService/INSTANCE_ALIVE_TIMEOUT_MS）、`modules/triage`（barrel：triageService 告警升级）、`modules/knowledge`、`modules/workunit`、`modules/pmo`（current-wu-context 归属链）、`modules/auth`（hashPassword）、`core/`（store/proc-probes/exec-async）、`utils/`；动态 import `modules/mcp`、`modules/channels`
- 下游：`app.ts`（/metrics 动态 import barrel）、`route-registry.ts`（monitoring.routes 深路径动态 + /health 探针 barrel 动态）、`bootstrap/`（services/lifecycle/migrations/handlers/bridges）、`cli/server.ts` / `cli/run-web.ts`、`modules/agent-loop`（loop-lifecycle 静态 barrel / dispatch-reconciliation 告警出声）、`modules/pmo`（analysis-handoff 动态）、`modules/workunit`（in-review-inbox 动态）、`bench/walk5-page-load.ts`（monitoring.service 深路径）

### 注意事项

- 所有路由走 `core/http.ts` defineRoute（契约驱动迁移 2026-10 批次 5/7）：响应统一 `{ data }` 壳，错误统一 `{ error: { code, message } }`；契约正本 = `packages/studio-contract/src/monitoring.ts`
- 成本红线常量 (`INJECTED_TOKEN_BUDGET`、`OVERHEAD_RATIO_BUDGET`) 与 vision §3 对齐，修改需同步文档。
- 监控数据窗口默认 30 天，由 `KnowledgeMetricsSource` 的 `windowDays` 参数控制。
- **鉴权（2026-07-24 收紧）**：`/api/v1/monitoring` 挂载级 `requireAuth()+requireAdmin()`（route-registry）。GET 端点此前无挂载中间件、仅靠 Lurk Wall 大门兜底。
- **fs 直写保留理由（P2-e 登记）**：`gcStaleWorktrees` 的 worktrees 目录扫描/删除是目录级 GC 操作（FileStore 不管的形态）；目录口径 P2-e 起为 `WORKTREES_DIR > studioPath('worktrees')`（契约 §8 双口径收编，fallback 与 bootstrap 注入值同源）。原 `system-health.ts` runGC（worktrees/sessions 目录清理）因无生产接线已于 2026-10 死代码批次整体删除（ADR 2026-09-15 决策 3 的 needs-triage 接线票以删除收口）。
- **周期循环 scan-sharing（候选 3，2026-09-08）**：monitor `check()` 一轮开头一次 `getIndex()`，快照作 caller-private 传给 6 个 WU 探针（收 `snapshots` 参数、内存 filter，不再各自 getIndex；动作前新鲜度复核 `getIndex({id})` 点读不受影响）——**新 WU 探针一律收快照不自己读**；跨 job 不共享
- **monitor-round 零同步子进程（#374）**：全部同步 exec 收口 `core/exec-async.ts`（gcStaleWorktrees `git worktree prune`、dailyReflection git log/diff 等；fail-open 语义与超时不变）
- **decision/spec 豁免超时巡检（#553 裁决）**：checkTotalExecutionTime 跳过 DECISION_SPEC_TYPES——裁剪状态机无 closed、决策/成文单可等关键人多天，语义选「跳过巡检」
- **WU 删除走 service.delete 单口（#538）**：monitor-lifecycle 每日 TTL 的筛选逻辑留调用方，删除循环改调 `service.delete(id, { reason })`；#540 起加终态守卫——仅删 done/closed。原 system-health runGC 同口径改造后仍无生产接线，已随 2026-10 死代码批次删除
- **monitor-reports 知识质量审计构造（harness 1.8.0 / #134①；#559 收口）**：`new KnowledgeAudit(store, 阈值?)`——日兜底走 `sharedStore` 单例，调用点为类型完整动态导入（无 `as any`）
- **Idle 心跳 45s**，超时扫描 5min；**isOnline** = loop 存活+心跳新鲜（≤5min）；#345 起 isOnline/每角色最新 error 聚合单源 `summarizeRoleStates`（agents 模块 agent-instance.service），agent-profile list 与 instance-timeout-scan 的 5min 窗口同源（INSTANCE_ALIVE_TIMEOUT_MS）
- **Ops 看门狗探针语义（2026-09-21，生产假阴性自杀循环事故修复）**：`ops.service getStatus()` 探针打免鉴权 `/health`（app.ts 注册于鉴权中间件之前，不依赖任何业务路由），**收到任何 HTTP 响应（含 401/403/5xx）即判活，只有连接失败/超时才判死**——严禁改回「业务路由 + statusCode===200」判定（防回归测试：`__tests__/ops-health-probe.test.ts`）。已知残留假阴性面（未修，仅记录）：判死后 daemon-busy 豁免检查的 `fileStore.getIndex` 读失败被 catch 静默吞掉 → 有活跃执行 session 也照 exit
- **系统探测 /proc 单出口（#344）**：新探测先落 `core/proc-probes.ts`（零子进程）。磁盘 = statfs (blocks−bavail)/blocks；内存 = MemTotal−MemAvailable；僵尸 = /proc/<pid>/stat state=Z。#418 起命令行类探测同出口
- **worktree GC 唯一入口 = `monitor-system-probes.gcStaleWorktrees`（#409）**：Ops 版 cleanupWorktrees 及其 hourly 挂载已删；#571 起 frontend dist 检查委托 utils/frontend-dist.ts（npm 形态缺 dist = 包损坏 critical abort，auto-build 仅 monorepo dev 形态保留）
- preflight 其余同步 exec（vite build/cloudflared nohup spawn）为启动一次性路径，#374 方案未列，保留
