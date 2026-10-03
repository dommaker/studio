# apps/api/src/modules/agent-monitor

### 职责

Monitor Agent（P2-d 刀6 自 modules/agents/monitor 提升为顶层模块）：5min 轮询健康监控 + 渐进告警 + 轨迹评估/每日洞察 + 知识沉淀闸门与每日 TTL 清理 + 实例超时巡检。命名避开既有 `monitoring` 模块（指标聚合只读面）。由 bootstrap/services 启动链装配（monitor 为启动链第一环）。

### 目录结构

- `monitor.service.ts` — 门面（5min 轮询健康监控 + 渐进告警）
- `monitor-probes.ts` — WU 级探测（失败趋势/停滞/超时/池停滞/评审停滞/僵尸认领守卫——#464 起 stale_claim_guard 命中除告警外同步向 WU 所在频道发「已沉睡」milestone 提醒；#610 起 expireTriggerPendingWorkUnits——trigger 建单 pending 超期未确认自动关闭，阈值 TRIGGER_PENDING_EXPIRY_DAYS 默认 7 天，人工建的 pending 单不受影响，decision/spec/plan 豁免）
- `monitor-system-probes.ts` — 系统/知识级探测与自修复（#409 起 worktree GC 唯一入口 gcStaleWorktrees——7d 阈值、prune 走 execAsync、不调 git worktree remove；#611 起 checkKnowledgeHealth 日级门控含 consumption 归零告警）
- `monitor-alerts.ts` — 告警分发/Triage 升级（指纹冷却去重 w4h/c1h）
- `monitor-reports.ts` — 轨迹评估/每日洞察/交互观察
- `monitor-lifecycle.ts` — 知识沉淀闸门+每日 TTL 清理（#653 起 studio-events.jsonl 清理已删——事件保留执法归 studio-events-rotation 单口）
- `instance-timeout-scan.ts` — 心跳过期 5min 扫描+pid 复核（P2-d 刀6 自 agents 根随迁——依赖 monitor-alerts；#363 统一回收 terminated 实例；2026-09-24 起 terminate 死实例后连带释放其持有的 active WU 回池）
- `types.ts` — MonitorAlert/MonitorAlertSource 类型（P2-d 刀1 自 agents/types.ts 拆分归属）
- `exec-async` 已下沉 `core/exec-async.ts`（P2-d 刀1）
- `__tests__/` — monitor-* ×8 + instance-timeout-scan

### 核心导出

- `index.ts` — 模块公共出口 barrel：`monitorService`、`dispatchMonitorAlerts`、`emitMonitorEvent`、`scanStaleAgentInstances`、`MonitorAlert`/`MonitorAlertSource`（type）

### 依赖关系

- 上游：`modules/agents`（barrel：AgentInstanceService/INSTANCE_ALIVE_TIMEOUT_MS，instance-timeout-scan 消费）、`modules/triage`（barrel：triageService 告警升级）、`modules/knowledge`、`modules/workunit`、`core/`（store/proc-probes/exec-async）、`utils/`；动态 import `modules/mcp`、`modules/channels`
- 下游：`bootstrap/`（services/lifecycle/migrations/handlers）、`modules/events`（lock-events-bridge 静态）、`modules/pmo`（analysis-handoff 动态）、`modules/workunit`（in-review-inbox 动态）、`modules/agent-loop`（dispatch-reconciliation 告警出声）

### 注意事项

- **fs 直写保留理由（P2-e 登记）**：`gcStaleWorktrees` 的 worktrees 目录扫描/删除是目录级 GC 操作（FileStore 不管的形态）；目录口径 P2-e 起为 `WORKTREES_DIR > studioPath('worktrees')`（契约 §8 双口径收编，fallback 与 bootstrap 注入值同源）。
- **周期循环 scan-sharing（候选 3，2026-09-08）**：monitor `check()` 一轮开头一次 `getIndex()`，快照作 caller-private 传给 6 个 WU 探针（收 `snapshots` 参数、内存 filter，不再各自 getIndex；动作前新鲜度复核 `getIndex({id})` 点读不受影响）——**新 WU 探针一律收快照不自己读**；跨 job 不共享
- **monitor-round 零同步子进程（#374）**：全部同步 exec 收口 `core/exec-async.ts`（gcStaleWorktrees `git worktree prune`、dailyReflection git log/diff 等；fail-open 语义与超时不变）
- **decision/spec 豁免超时巡检（#553 裁决）**：checkTotalExecutionTime 跳过 DECISION_SPEC_TYPES——裁剪状态机无 closed、决策/成文单可等关键人多天，语义选「跳过巡检」
- **WU 删除走 service.delete 单口（#538）**：monitor-lifecycle 每日 TTL 筛选逻辑留调用方，删除循环改调 `service.delete(id, { reason })`；#540 起加终态守卫——仅删 done/closed
- **monitor-reports 知识质量审计构造（harness 1.8.0 / #134①；#559 收口）**：`new KnowledgeAudit(store, 阈值?)`——日兜底走 `sharedStore` 单例，调用点为类型完整动态导入（无 `as any`）；`__tests__/monitor-reports.test.ts` 的 #559 用例绕开文件级 harness mock 钉住「store 首参」契约
- **Idle 心跳 45s**，超时扫描 5min；**isOnline** = loop 存活+心跳新鲜（≤5min）；#345 起 isOnline/每角色最新 error 聚合单源 `summarizeRoleStates`（agents 模块 agent-instance.service），agent-profile list 与 instance-timeout-scan 的 5min 窗口同源（INSTANCE_ALIVE_TIMEOUT_MS）
