// Task Logger — 结构化任务日志，供审计/进化/调试
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';

export interface TaskLog {
  timestamp: string;
  session: string;
  sessionId: string;
  taskIndex: number;
  model: string;
  phase: string;           // analyst | executor | review
  command: string;         // cli 命令（隐藏 api key）
  durationMs: number;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  exitCode?: number;
  errorType?: string;      // session_expired | cli_error | timeout | llm_error | parse_error | unknown
  errorDetail?: string;    // 人可读的错误描述
  stdoutPreview?: string;  // 前 500 字符
  stderrPreview?: string;  // 前 500 字符
  outputFile?: string;     // 产出文件路径
  outputSize?: number;     // 产出大小
}

const LOG_DIR = path.join(os.homedir(), '.studio', 'logs');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function classifyTaskError(message: string): string {
  if (/invalid session id|must be a valid uuid/i.test(message)) return 'cli_error';
  if (/session.*not found|no previous session|no conversation/i.test(message)) return 'session_expired';
  if (/timeout|ETIMEDOUT|killed/i.test(message)) return 'timeout';
  if (/api.*error|rate.limit|429|503|unauthorized|invalid.*api/i.test(message)) return 'llm_error';
  if (/json|parse|syntax/i.test(message)) return 'parse_error';
  return 'unknown';
}

export function writeTaskLog(log: TaskLog): void {
  ensureLogDir();
  const date = log.timestamp.slice(0, 10);
  const logFile = path.join(LOG_DIR, `tasks-${date}.jsonl`);

  try {
    fs.appendFileSync(logFile, JSON.stringify(log) + '\n', 'utf-8');
  } catch (e) {
    logger.error('[TaskLog] Failed to write task log', { error: String(e) });
  }

  // Also emit structured log for live monitoring
  const msg = log.success
    ? `${log.session}#${log.taskIndex} OK ${log.durationMs}ms tokens=${log.inputTokens}/${log.cacheHitTokens}/${log.outputTokens}`
    : `${log.session}#${log.taskIndex} FAIL [${log.errorType}] ${log.errorDetail?.slice(0, 80)}`;
  logger.info(`[TaskLog] ${msg}`);
}
