# 可观测性现状盘点：日志、进度查看、agent 监控

> Research 票：GitHub issue #59（地图 #53 子票）。只读盘点，2026-08-09。
> 触发事件：PMO-12 的 WU（`3a86c8c0-…`）因每步 120s 硬超时三连失败后转 blocked，过程对频道静默。
> 本文所有「实证」均来自生产 `~/.studio/` 只读采样与 journalctl 小采样。

## TL;DR — 主要缺口

1. **执行失败过程全链路静默**：CLI 失败/超时按设计不发频道（`agent-loop.ts:742-764` 显式失败分支、`:1255-1258` failed 不迁移不发帖），且 `workunit:execution_step` 只在**成功路径**落盘（`agent-loop.ts:795` 在 `result.success===false` 分支之后）——失败的步在频道、Web 执行过程面板、事件流三处都看不到。PMO-12 实证：约 6 分钟 3 次超时期间频道 0 条消息，仅最后收到 1 条 blocked 里程碑。
2. **失败详情无结构化事件**：失败原因只落在 ① journalctl 的 `[AgentLoop] agentStep execution failed` 文本行 ② WU `metadata.blockReason`。事件流里没有 `workunit:failed` 一类事件，监控/报表无法聚合失败。
3. **事件流信噪比低**：`studio-events.jsonl` 近 7 天 15,836 行中 88% 是 `knowledge:skill_used`（13,944 行）；同期 `monitor:alert` 0 条、`workunit:execution_step` 仅 6 条。
4. **告警无落地入口**：Monitor 探测链存在且阈值完整，但 warning/critical 告警的归宿是「事件文件 + 系统频道/企微 webhook」，Web UI 没有告警列表/失败率/stuck 历史面板；实证近 7 天未产生过一条 `monitor:alert`。
5. **日志分散且无统一检索**：事件文件 / journalctl / deploy.log / audit.jsonl / incidents.jsonl 五处分散，除事件文件（7 天截断）外均无明确保留策略；deploy.log 无轮转（不在 `/etc/logrotate.d/`）。
6. **失败趋势探测与 WU 数据脱节**：`checkFailureTrend` 读的是 `~/.studio/data/tasks/`（旧 Task 概念），不是 `data/workunits/`——WU 维度的失败率没有探测覆盖。

---

## 1. 日志收集

### 1.1 `~/.studio/logs/studio-events.jsonl`（统一业务事件流，D18）

- **Schema**：`{ type, source?, payload: JSON string, createdAt: ISO8601 }`，见 `apps/api/src/utils/studio-events.ts:12-13`。
- **路径解析**：`resolveStudioEventsFile()`（`utils/studio-events.ts:28-30`），默认 `~/.studio/logs/studio-events.jsonl`，可被 `STUDIO_EVENTS_FILE` / `STUDIO_EVENTS_JSONL` env 覆盖；测试期隔离到 `os.tmpdir()/studio-test-logs/`（`utils/studio-log-path.ts`）。
- **写入入口**：唯一入口 `writeStudioEvent()`（`utils/studio-events.ts:63`）——永不抛出，空 payload 拒绝落盘。另有 REST 入口 `POST /api/v1/events` 与批量 `POST /api/v1/events/agent-events`（`modules/events/event.routes.ts:41,119`）。
- **写方**（按生产实测 source 分布）：`agent-loop`（14,956 行：workunit:tokens、knowledge:skill_used、tool:call、workunit:execution_step）、`knowledge-bus`（493）、`system-executor`（146：system:tokens）、`agent-executor`（131：session:start/end）、`monitor`（37）、`prompt-inject`、`startup`、`execution:claude` 等。写点代码位置：`agent-loop.ts:72,783`、`loop/execution-step-events.ts:8`、`agents/system-executor.ts:62`、`agents/monitor/monitor-alerts.ts:31-35`、`agents/ops/ops.service.ts:449`、`mcp/system.tools.ts:80`。
- **读方**：`GET /api/v1/events` 回放（`event.routes.ts:77-111`，支持 type/since/limit/workUnitId 过滤，上限 200 条）；`ExecutionSteps` 组件 REST 回放；`monitoring.service.ts:359` getOverheadStats（workunit:tokens 聚合）；`knowledge/knowledge-metrics.ts:246`、`knowledge/pattern-miner.ts:18`、`agents/auditor/auditor-reports.ts:24`、`skills/skill-demotion.ts:29`、`agents/token-usage.service.ts:31`、`workunit/delegation-gate.ts:88`、`evolution/signals.ts:43`、`triggers/trigger.routes.ts:66`。
- **实测事件分布**（2026-08-02 ~ 08-09，15,836 行）：

  | 行数 | type |
  |---|---|
  | 13,944 | knowledge:skill_used |
  | 965 | workunit:tokens |
  | 487 | knowledge:entry_created |
  | 146 | system:tokens |
  | 82 | tool:call |
  | 42+42 | session:start / session:end |
  | 23 | daily_reflection |
  | 14 | monitor:info |
  | 6 | workunit:execution_step |
  | **0** | **monitor:alert（近 7 天无一条告警事件）** |

  样例路径：`~/.studio/logs/studio-events.jsonl`（3.2MB，活跃写入中）。

- **保留策略**：`monitor-lifecycle.ts:193-221`——每日 dataLifecycle（`monitor.service.ts:84-85` 注释：23:55）把事件文件截断到最近 7 天；已沉淀（precipitated）事件 30 天再清一轮（`:225-239`）。无归档，截断即丢失。

### 1.2 journalctl（`studio-api.service`）

- 覆盖：pino HTTP 请求日志（`Request completed` method/path/status/duration）+ 应用 `logger.*` 全部输出（含 `[MonitorService]`、`[AgentLoop]` 等）。unit 未配置日志保留（`/etc/systemd/system/studio-api.service`，无 LogRateLimit/Storage 定制），走 journald 默认。
- 实证样例（PMO-12 三次超时，这是失败详情唯一留痕处之一）：

  ```
  Aug 09 17:01:24 studio-api[…]: [ERROR] [AgentLoop] agentStep execution failed for 3a86c8c0-…: Command timed out after 2min {}
  Aug 09 17:03:40 …（同上）
  Aug 09 17:05:56 …（同上）
  ```

### 1.3 `/var/log/studio-deploy.log`

- 覆盖：部署脚本 stdout/stderr（前端构建、API 重启、健康检查结果）。写入点 `apps/api/src/modules/deploy/webhook.routes.ts:62`（`DEPLOY_LOG` env，默认该路径）。
- 实测：最后写入 2026-07-31，1.8MB 单文件持续 append，**无轮转**（`/etc/logrotate.d/` 无对应条目）。

### 1.4 同目录其它日志

| 文件 | 写方 | 保留策略 |
|---|---|---|
| `audit.jsonl`（744KB，活跃） | `middleware/audit-logger.ts` + `@dommaker/studio-audit`，SEC-009 关键写操作审计（频道 POST/PUT、auth、pmo 等），requestId 与 WU traceId 同值 | 未见 TTL |
| `incidents.jsonl`（1.1MB） | `agents/triage/triage.service.ts:15` | 未见 TTL |
| `notifications.jsonl`（530B） | 通知出口 | 未见 TTL |
| `tasks-YYYY-MM-DD.jsonl` | 历史 Task 执行日志，2026-05 ~ 07-27，已停写 | — |

---

## 2. 进度查看

### 2.1 频道消息（里程碑粒度）

- 统一出口 `postWuSystemMessage()`（`apps/api/src/modules/workunit/wu-messenger.ts:73`）：挂在 WU 频道线程 anchor 下，`authorType:'agent'`，走 eventBus + SSE 实时可见；`milestone=true` 时 meta 带 `atHuman:true` + pmoId（NotificationBell 会响）。
- 发帖点（`agent-loop.ts`）：progress 简报（`:1223`）、complete 汇报（`:1231`）、need_input（`:1248`）、连续 3 步无新提交提醒（`:1177`）、验证失败 blocked（`:1186`）、步骤超限（`:1206`）、**stuck blocked（`:1215`）**。
- **静默区（设计如此）**：`result.success===false` 显式失败分支注释明写「不发频道消息；连续 3 次走 blocked 路径」（`:742-745`）；`case 'failed'` 注释「不发频道消息、不做状态迁移」（`:1255-1258`）。即重试中的每一次失败/超时都不产生任何频道消息。

### 2.2 Web UI

- `WorkUnitDetailPage.tsx`：状态/类型徽章、创建/认领/完成时间、`failureType`（`:182`）、归属四跳（PMO/REQ/频道/认领 agent）、证据台账 L1/L2/L3、Token 开销抽屉、讨论区。
- `ExecutionSteps` 组件（`components/workunit/ExecutionSteps.tsx`，复用于详情页/频道抽屉/列表展开/AgentDetailPage）：
  - REST 回放 `workunit:execution_step` 事件（每步 thinking ≤3×500 字符、toolCalls ≤30×160 字符摘要、skills 注入名单、usage）；
  - SSE 实时：`workunit.execution.step`（步级）+ `workunit.execution.stream`（步内行级 chunk，只发 SSE 不落盘）。
  - **关键限制**：`emitExecutionStepEvent` 只在执行成功路径调用（`agent-loop.ts:795`，位于 `success===false` return 之后）——失败的步没有任何步级事件，详情页显示「暂无执行过程记录」。
- 完整 transcript 无 UI 入口：需人工查 agent HOME 的 `.claude/projects/<cwd-slug>/<sessionId>.jsonl`（`agents/CONTEXT.md:51`）。

### 2.3 API

- `GET /api/v1/workunits/:id`（状态、metadata.blockReason/errorType/errorDetail、claimedAt 等）。
- `GET /api/v1/events?type=…&workUnitId=…&since=…&limit≤200`（`event.routes.ts:77`）——唯一的事件查询 API，无认证（同文件只有 POST 要 JWT），全文件线性扫描。
- SSE：`workunit.status_changed`、`workunit.execution.step|stream`、`agent.instance.status_changed`（前端订阅见 `hooks/useAgentRoster.ts:3-5`）。

### 2.4 PMO-12 实证（WU `3a86c8c0-0eda-4c19-b5c9-a9fafe697740`）

- 17:01:24 / 17:03:40 / 17:05:56 三次「Command timed out after 2min」（journalctl），期间频道 **0 条消息**。
- 17:05:56 转 blocked，频道收到唯一 1 条：`连续 3 步无进展（CLI 执行失败: Command timed out after 2min），等待人类介入`（meta `atHuman:true`；样例：`~/.studio/data/channels/70668707-…/messages.jsonl`）。
- 事件流中该 WU 仅有：`session:start/end` ×3、`workunit:tokens` ×3、`knowledge:skill_used` ×42；**`workunit:execution_step` 0 条**——Web 详情页执行过程为空。
- `metadata.blockReason` = `stuck: 连续 3 步无进展（CLI 执行失败: Command timed out after 2min）`（落盘逻辑 `agent-loop.ts:1149-1162`，B4 事故后补的）。

---

## 3. agent 监控

### 3.1 数据面

- `GET /api/v1/monitoring/agents`（`monitoring/monitoring.routes.ts:11` → `monitoring.service.ts:246` getAgentSummary）：实例 id/roleId/name/status（idle/active/error/terminated）/currentWorkUnitId/startedAt/lastError+lastErrorAt，并聚合当前 WU 快照（标题/状态/claimedAt）、归属 PMO、频道。数据源：FileStore `listStates()`（`~/.studio/data/agents/`）。
- `GET /api/v1/monitoring/stats`（WU 状态分布、agent 计数、24h 完成/失败阻塞计数）；`/flywheel`、`/overhead`、`/overview`（证据台账）。
- 强制停止：`monitoringApi.terminateInstance`（任务转人工）。

### 3.2 现有页面覆盖

- `AgentDashboardPage.tsx`（/agents）：角色名册（profile × runtime 合并），每卡：状态 pill（`utils/agentStatus.ts` deriveAgentStatus）、当前 WU 链接 + 已耗时、PMO/频道链接、最近动态（SSE 步级/流式事件 + 30s 轮询，`useAgentRoster.ts`）、lastError 警示、运行时长、强制停止；顶部统计（总数/在线/执行中/不可用/已停用）。
- `AgentDetailPage.tsx`（/agents/:profileId）：正在执行大卡（内嵌 ExecutionSteps 实时流）、历史任务最近 20 条、统计行（历史总数/完成/在途/失败——由最近 20 条**客户端推导**，非全量失败率）、强制停止。
- `MonitoringPage.tsx`（/monitoring）：运营度量——WU 状态分布、agent 利用率、24h 完成/失败、证据台账、飞轮指标、封装开销红线。**无告警、无 stuck 列表、无失败率趋势**。

### 3.3 stuck / 失败检测链（后端有，前端无入口）

- MonitorService 每 5 分钟 check（`agents/monitor/monitor.service.ts:26,68-95`）：
  - `checkFailureTrend`（`monitor-probes.ts:30`）：近 1h 失败 ≥3 → warning；失败率 >50% → critical。**但读的是 `~/.studio/data/tasks/`（旧 Task 目录），不是 WorkUnit**——WU 维度无失败趋势探测。
  - `checkProgressStagnation`（`:78`）：active WU `updatedAt` 停滞 >15min info / >30min critical。
  - `checkTotalExecutionTime`（`:107`）：1h info / 2h warning / 2.5h critical + 主动 stop 并转 closed。
  - `autoAbandonStaleBlocked`（`:167`）：blocked 超 24h 自动转 closed（只记日志，不发频道）。
  - `checkToolPatterns`（`:229`）：工具错误率 >50% / 零成功告警。
  - `systemHealthCheck`（`monitor-system-probes.ts:214`）：内存/磁盘/僵尸进程/CPU/存储，3 次确认 → Triage。
- 告警出口（`monitor-alerts.ts:38-57`）：logger 分级 + warning/critical 写 `monitor:alert` 事件 + `notifyAlert`（`utils/notifier.ts:27`：系统频道 + 企业微信 webhook）；critical 升级 Triage（`:63`）；写 KnowledgeBus pattern（`:101`）。
- WU 粒度兜底：agent-loop `consecutiveStuck >= 3` → blocked + 频道里程碑（`agent-loop.ts:1210-1217`）。
- **实证：近 7 天事件流中 `monitor:alert` 0 条、`monitor:info` 14 条**——告警链实际很少触发（阈值 vs 现实不匹配，或告警走了频道但事件未达 warning 级）。

---

## 4. 缺口清单（汇总，供 #53 后续决策票引用）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | 执行失败/重试过程频道静默（设计如此），用户最长 ~6 分钟零反馈 | `agent-loop.ts:742-745,1255-1258`；PMO-12 实证 §2.4 |
| G2 | 失败的步无 execution_step 事件，Web 执行过程面板对失败 WU 为空 | `agent-loop.ts:795` 在失败分支之后；§2.4 事件计数 |
| G3 | 无结构化失败事件（`workunit:failed` 等），失败详情只有 journalctl 文本 + blockReason | journalctl 样例 §1.2；`agent-loop.ts:749,1149-1162` |
| G4 | 事件流信噪比差：88% knowledge:skill_used；无按 WU/会话的检索 UI（GET /events 线性扫全文件、上限 200） | §1.1 分布表；`event.routes.ts:90-104` |
| G5 | 告警无 Web 入口：无告警列表、无失败率/stuck 趋势面板；monitor:alert 近 7 天 0 产出 | §3.2、§3.3 实证 |
| G6 | WU 维度失败趋势探测缺失：checkFailureTrend 读 data/tasks 旧数据 | `monitor-probes.ts:35-44` |
| G7 | blocked 24h 自动放弃只记日志不通知，WU 可被静默关闭 | `monitor-probes.ts:167-189` |
| G8 | 日志五处分散（events/journalctl/deploy.log/audit/incidents），无统一检索；deploy.log 无轮转，audit/incidents 无 TTL | §1.2-1.4 |
| G9 | 完整 transcript 需登服务器翻 agent HOME 文件，无任何入口 | `agents/CONTEXT.md:51` |
| G10 | agent 实例无心跳/健康历史，只有当前态（lastError 单条）；实例状态靠 FileStore，进程崩了状态可能滞留 active | `monitoring.service.ts:246-290` |
