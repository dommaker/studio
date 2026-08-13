/**
 * #96: CLI 上下文溢出纯反应式策略 —— 溢出错误识别 + 会话滚动摘要构建（纯函数，零服务依赖）。
 *
 * 纯反应式：只在 CLI 回报溢出错误时触发，不建 token 记账/阈值预警预防层（预防层不建）。
 * 溢出反应链：溢出错误 → 会话滚动摘要落盘 → 新会话带摘要注入重试一次 → 再败 NEED_INPUT。
 *
 * 摘要来源 = wu.scope + metadata.progressLog（#95 成功步环形簿记）+ errorType ——
 * 「只摘要会话内对话历史」：progressLog 是会话内逐步 action summary 的滚动记录，
 * 不递归摘要（不 LLM 摘要摘要）、不建语义搜索（YAGNI，选最简可靠来源）。
 */
import type { WorkUnitMetadata } from '../../workunit/workunit.types.js';

/**
 * 溢出错误识别正则（与 session-resume 的 RESUME_FAILURE_RE「会话不存在」是不同失败类型，别混）。
 * 依据（实证，不凭猜）：
 *  - Claude Code CLI 实测溢出报 "Prompt is too long"（anthropics/claude-code #15554 / #41536）
 *  - Anthropic API 错误类型 context_length_exceeded / "over the maximum context length"
 *  - 既有 triage/error-class.ts FAILURE_PATTERNS 分类词表 token.*limit|context.*length|maximum.*tokens
 */
export const OVERFLOW_ERROR_RE =
  /prompt is too long|context[ _]?(?:length|window|limit)|maximum (?:context|token)|too many tokens|token limit/i;

/** 溢出错误判定：detail = ExecutionResult.error（CLI 回报的失败文本，截 500 字符） */
export function isContextOverflowError(detail: string): boolean {
  return OVERFLOW_ERROR_RE.test(detail);
}

/** 溢出摘要段标题（注入新会话 prompt 用） */
export const OVERFLOW_SUMMARY_HEADER = '## 会话摘要（上下文溢出）';

/**
 * 会话滚动摘要：任务 scope + 已完成步骤（progressLog 旧→新）+ 上一步失败（errorType）。
 * 空 scope / 空 log / 无 errorType → 相应行省略；三者皆空 → 空串。
 * progressLog 条目逐字段窄断言（metadata 是 JSON 反序列化的 unknown，畸形条目跳过不渲染脏数据）。
 */
export function buildRollingSummary(scope: string | undefined, metadata: WorkUnitMetadata): string {
  const lines: string[] = [];
  if (scope && scope.trim().length > 0) {
    lines.push(`任务：${scope.trim()}`);
  }
  const log = Array.isArray(metadata.progressLog) ? metadata.progressLog : [];
  if (log.length > 0) {
    lines.push('已完成步骤：');
    for (const entry of log) {
      const step = typeof entry?.step === 'number' ? entry.step : '';
      const action = typeof entry?.action === 'string' ? entry.action : '';
      const summary = typeof entry?.summary === 'string' ? entry.summary : '';
      lines.push(`- 第 ${step} 步 [${action}]：${summary}`);
    }
  }
  if (metadata.errorType) {
    lines.push(`上一步执行失败（${metadata.errorType}）。`);
  }
  return lines.join('\n');
}
