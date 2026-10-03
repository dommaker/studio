// WorkUnit 事件负载本地类型（P3-a 自 api/workunit.ts 迁出——api 层不声明导出类型）。
// 均为 /events + SSE 负载形状（非 workunit REST，不在契约范围）；
// 对应解析器留在 api/workunit.ts。

/** M2 成本红线度量：agent-loop 写入的 workunit:tokens 事件（payload 解析后） */
export interface WorkunitTokenEvent {
  workUnitId: string;
  executionId?: string;
  /** 注入上下文估算 tokens（estimateTokens 口径） */
  injectedTokens: number;
  /** 执行总 tokens；CLI 未回报 usage 时为 null（不编造 0） */
  executionTokens: number | null;
  executionSource?: string;
  totalTokens: number;
  createdAt?: string;
}

/** WU 过程可视化：agent-loop 每步执行结束写入的 workunit:execution_step 事件（payload 解析后） */
export interface ExecutionStepToolCall {
  tool: string;
  /** 面向人读的输入摘要（file_path / command / pattern…，已截断） */
  summary: string;
}

export interface ExecutionStepEvent {
  workUnitId: string;
  executionId: string;
  sessionId?: string;
  /** 1 基步号 */
  step: number;
  action?: string;
  /** #172（#60 决策 Q1）：本步成败（历史事件无该字段 → 缺省 success） */
  status: 'success' | 'failed';
  /** #172: 失败步错误分类（execution_failed 等） */
  errorType?: string;
  /** #172: 失败步错误详情（已截断） */
  errorDetail?: string;
  /** 模型思考摘要（≤3 条，已截断） */
  thinking: string[];
  /** 本步工具调用（≤30 条） */
  toolCalls: ExecutionStepToolCall[];
  /** 本步注入的 skill 名单 */
  skills: string[];
  text?: string;
  usage?: { inputTokens: number; outputTokens: number; model?: string };
  at: string;
}

/** Layer B 步内流式 chunk（SSE `workunit.execution.stream`，SSE-only 无 REST 回放——落盘归档是 execution_step 的事） */
export interface ExecutionStreamChunk {
  workUnitId: string;
  executionId: string;
  step: number;
  /** #240: 增加 tool-result（user 事件 tool_result 块提炼，与 tool chunk 按 toolUseId 配对） */
  kind: 'step-start' | 'thinking' | 'text' | 'tool' | 'tool-result' | 'result';
  text?: string;
  tool?: string;
  summary?: string;
  /** #240: tool/tool-result 配对锚点（tool_use.id ↔ tool_result.tool_use_id） */
  toolUseId?: string;
  isError?: boolean;
  at: string;
}
