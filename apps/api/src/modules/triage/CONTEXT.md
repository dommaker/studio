# apps/api/src/modules/triage

### 职责

错误分类（triage）与严重度评估 + Triage Agent 事件响应。两层同域合并（P2-d 刀2，agents 超级域拆分）：

- **分类层**（error-class.ts）：提供策略路由（auto_retry / manual_fix / escalate / ignore），支持开发者错误和系统级事件的分类。
- **Agent 层**（triage.service.ts，自 modules/agents/triage 并入）：incident response 管线 diagnose → classify → act → resolve/escalate；incident-store = incidents.jsonl append-only；incident-notification（#468）：incident.created/escalated 落 NotificationService type=incident（severity 进 content 首行），取代断裂的 SSE 桥。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| index.ts | 模块公共出口（barrel） | P2-c 立界：跨模块唯一合法 import 面（实际消费反推生成）；深路径 import 由 eslint `local/no-deep-module-import` 拦截 |
| `ErrorClass` | error-class.ts | 八类错误标签（syntax_error 等） |
| `Severity` | error-class.ts | 严重度等级（low / medium / high） |
| `TriageResult` | error-class.ts | 错误分类结果（含 class、severity、summary、strategy） |
| `classifyError` | error-class.ts | 根据错误消息返回匹配的 TriageResult |
| `TriageErrorClass` | error-class.ts | 系统级错误分类（timeout / test_failure 等） |
| `SystemTriageResult` | error-class.ts | 系统级分类结果（含 errorClass、severity、recommendedAction） |
| `classifySystemError` | error-class.ts | 系统级错误分类入口（triage.service 与告警升级链消费） |
| `triageService` | triage.service.ts | Triage Agent 单例（handleAlert 入口；Monitor 告警升级消费方走 barrel） |
| `TriageIncidentInput` / `TriageIncidentType` / `TriageLogEntry` | types.ts | incident 类型契约（P2-d 自 agents/types.ts 拆分归属） |

### 依赖关系

**上游依赖**：modules/knowledge（knowledgeService，triage.service 诊断段）、core（store/proc-probes/exec-async）、@dommaker/studio-notification（incident-notification）
**下游依赖**：
- apps/api/src/modules/agents/monitor/*（monitor-alerts/monitor-system-probes 告警升级，走 barrel；P2-d 刀6 后归 modules/agent-monitor）
- apps/api/tests/b2-unit.test.ts（测试模块）

### 注意事项

- 错误模式匹配按数组顺序，先匹配优先，未匹配则归为 `unknown_error`
- `classifyError` 截取错误消息前 100 字符作为 summary
- `SystemTriageResult` 为另一套独立分类，与 `classifyError` 无直接关联
- 策略映射 `STRATEGY_MAP` 和模式数组 `ERROR_PATTERNS` 未对外导出
- **契约驱动迁移（2026-10 批次 7/8）结论**：本模块无 HTTP 面（纯错误分类逻辑，消费方 = Monitor/Auditor 内部调用），无 REST 契约可迁。
