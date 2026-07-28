# triage

> 此文件描述 apps/api/src/modules/triage 目录的职责和上下文

## 职责

实现错误的分类（triage）与严重度评估，提供策略路由（auto_retry / manual_fix / escalate / ignore），支持开发者错误和系统级事件的分类。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `ErrorClass` | error-class.ts | 八类错误标签（syntax_error 等） |
| `Severity` | error-class.ts | 严重度等级（low / medium / high） |
| `TriageResult` | error-class.ts | 错误分类结果（含 class、severity、summary、strategy） |
| `classifyError` | error-class.ts | 根据错误消息返回匹配的 TriageResult |
| `TriageErrorClass` | error-class.ts | 系统级错误分类（timeout / test_failure 等） |
| `SystemTriageResult` | error-class.ts | 系统级分类结果（含 errorClass、severity、recommendedAction） |

## 依赖关系

**上游依赖**：无（不依赖其他目录模块）
**下游依赖**：
- apps/api/src/modules/agents/triage.service.ts（agents 模块）
- apps/api/tests/b2-unit.test.ts（测试模块）

## 注意事项

- 错误模式匹配按数组顺序，先匹配优先，未匹配则归为 `unknown_error`
- `classifyError` 截取错误消息前 100 字符作为 summary
- `SystemTriageResult` 为另一套独立分类，与 `classifyError` 无直接关联
- 策略映射 `STRATEGY_MAP` 和模式数组 `ERROR_PATTERNS` 未对外导出
