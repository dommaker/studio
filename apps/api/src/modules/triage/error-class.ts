// Triage ErrorClass — B1-007: 八类错误标签 + 严重度三级 + 策略路由

export type ErrorClass =
  | 'syntax_error'       // 语法/编译错误
  | 'type_error'         // 类型错误
  | 'runtime_error'      // 运行时异常
  | 'test_failure'       // 测试失败
  | 'dependency_error'   // 依赖缺失/版本冲突
  | 'config_error'       // 配置文件错误
  | 'permission_error'   // 权限/认证错误
  | 'unknown_error';     // 未分类

export type Severity = 'low' | 'medium' | 'high';

export interface TriageResult {
  errorClass: ErrorClass;
  severity: Severity;
  summary: string;
  strategy: 'auto_retry' | 'manual_fix' | 'escalate' | 'ignore';
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; errorClass: ErrorClass; severity: Severity }> = [
  { pattern: /syntax error|unexpected token|unterminated|missing \)/i, errorClass: 'syntax_error', severity: 'low' },
  { pattern: /type .* is not assignable|cannot find name|property .* does not exist/i, errorClass: 'type_error', severity: 'low' },
  { pattern: /Cannot read properties of undefined|Cannot read property|null pointer|segfault/i, errorClass: 'runtime_error', severity: 'high' },
  { pattern: /test.*fail|assertion.*fail|expected .* but got|timeout.*exceeded/i, errorClass: 'test_failure', severity: 'medium' },
  { pattern: /cannot find module|module not found|import.*error|package.*not found/i, errorClass: 'dependency_error', severity: 'medium' },
  { pattern: /ENOENT|permission denied|EACCES|unauthorized|forbidden/i, errorClass: 'permission_error', severity: 'high' },
  { pattern: /config.*invalid|env.*missing|environment.*variable|\.env/i, errorClass: 'config_error', severity: 'medium' },
];

const STRATEGY_MAP: Record<ErrorClass, Record<Severity, 'auto_retry' | 'manual_fix' | 'escalate' | 'ignore'>> = {
  syntax_error:     { low: 'auto_retry', medium: 'auto_retry', high: 'manual_fix' },
  type_error:       { low: 'auto_retry', medium: 'manual_fix', high: 'manual_fix' },
  runtime_error:    { low: 'manual_fix', medium: 'escalate', high: 'escalate' },
  test_failure:     { low: 'auto_retry', medium: 'manual_fix', high: 'escalate' },
  dependency_error: { low: 'manual_fix', medium: 'manual_fix', high: 'escalate' },
  config_error:     { low: 'manual_fix', medium: 'escalate', high: 'escalate' },
  permission_error: { low: 'escalate', medium: 'escalate', high: 'escalate' },
  unknown_error:    { low: 'manual_fix', medium: 'escalate', high: 'escalate' },
};

export function classifyError(errorMessage: string): TriageResult {
  for (const { pattern, errorClass, severity } of ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return {
        errorClass,
        severity,
        summary: `${errorClass}: ${errorMessage.slice(0, 100)}`,
        strategy: STRATEGY_MAP[errorClass][severity],
      };
    }
  }

  // Default: unknown
  const severity = errorMessage.length > 200 ? 'high' : 'medium';
  return {
    errorClass: 'unknown_error',
    severity,
    summary: `unknown_error: ${errorMessage.slice(0, 100)}`,
    strategy: STRATEGY_MAP.unknown_error[severity],
  };
}

// ── System-level Triage classification (incident response) ──

export type TriageErrorClass =
  | 'timeout'              // 超时/僵死 → retry
  | 'test_failure'         // 测试失败 → 通知 Reviewer 复查
  | 'permission_denied'    // 权限/认证错误 → 检查 MCP Tier 配置/文件权限
  | 'env_error'            // 环境问题（磁盘/内存/依赖）→ 检查依赖/环境变量/Docker → @human
  | 'vendor_error'         // 外部依赖故障（LLM API/DB/限流）→ 切换模型或等重试
  | 'validation_failure'   // harness gate 失败 → 通知 Reviewer
  | 'user_abort'           // 用户主动中止 → 正常终止，不告警
  | 'param_error';         // 传参/配置错误 → 修正参数后重试

export interface SystemTriageResult {
  errorClass: TriageErrorClass;
  severity: 'critical' | 'degraded' | 'minor';
  recommendedAction: string;
}

const SYSTEM_PATTERNS: Array<{
  match: (type: string, details: string) => boolean;
  errorClass: TriageErrorClass;
  severity: 'critical' | 'degraded' | 'minor';
  action: string;
}> = [
  // 系统级（已有）
  { match: (t) => t === 'service_down', errorClass: 'timeout', severity: 'critical', action: 'restart service + health check' },
  { match: (t, d) => t === 'resource_critical' && /memory/i.test(d), errorClass: 'env_error', severity: 'critical', action: 'kill zombies, check for memory leaks' },
  { match: (t) => t === 'resource_critical', errorClass: 'env_error', severity: 'degraded', action: 'clean logs/tmp, verify disk usage' },
  { match: (t) => t === 'zombie', errorClass: 'timeout', severity: 'degraded', action: 'kill zombie process + restart parent' },
  { match: (t, d) => t === 'ext_dependency' && /config/i.test(d), errorClass: 'param_error', severity: 'critical', action: 'check .env + validate config files' },
  { match: (t, d) => t === 'ext_dependency' && /rate|limit|429/i.test(d), errorClass: 'vendor_error', severity: 'minor', action: 'wait and retry with backoff' },
  { match: (t) => t === 'ext_dependency', errorClass: 'vendor_error', severity: 'critical', action: 'verify DB connection + LLM API reachability' },
  // 执行级（Monitor 升级，FL-037 Phase 1）
  { match: (t) => t === 'execution_repeated_failure', errorClass: 'timeout', severity: 'degraded', action: 'auto-retry with model tier upgrade (fast→standard→premium)' },
  { match: (t) => t === 'execution_stuck', errorClass: 'timeout', severity: 'degraded', action: 'kill stuck tmux session + re-spawn execution' },
  { match: (t) => t === 'execution_progress_stagnation', errorClass: 'timeout', severity: 'degraded', action: 'check worktree health + kill stale process + re-spawn' },
  { match: (t) => t === 'execution_heartbeat_lost', errorClass: 'timeout', severity: 'critical', action: 'kill tmux session + force re-spawn + notify human if re-spawn fails' },
  { match: (t) => t === 'execution_session_exhausted', errorClass: 'env_error', severity: 'critical', action: 'escalate to human — execution needs manual intervention' },
  { match: (t) => t === 'execution_timeout', errorClass: 'timeout', severity: 'critical', action: 'kill execution + re-spawn with model tier upgrade' },
  // 跨执行模式（Auditor/Evolution 升级，Phase 3）
  { match: (t) => t === 'agent_type_failure_trend', errorClass: 'vendor_error', severity: 'degraded', action: 'log & escalate to human — systemic agent type failure pattern needs manual investigation' },
  { match: (t) => t === 'workunit_health_degraded', errorClass: 'vendor_error', severity: 'degraded', action: 'check agent health + examine failed WorkUnits' },
  { match: (t) => t === 'review_cycle_exhausted', errorClass: 'validation_failure', severity: 'critical', action: 'escalate to human — review cycle exhausted, manual intervention required' },
];

export function classifySystemError(incidentType: string, details: string): SystemTriageResult {
  for (const { match, errorClass, severity, action } of SYSTEM_PATTERNS) {
    if (match(incidentType, details)) {
      return { errorClass, severity, recommendedAction: action };
    }
  }
  return {
    errorClass: 'env_error',
    severity: 'degraded',
    recommendedAction: 'log inspection + manual review',
  };
}

// ── Failure Classification + Routing (for pipeline failure events) ──

export type FailureCategory = 'infra' | 'pipeline' | 'agent' | 'unknown';
export type RouteTarget = 'triage' | 'resolution_kb' | 'human';

export interface FailureClassification {
  category: FailureCategory;
  severity: 'critical' | 'warning';
  matchedPattern: string;
}

export interface FailureRouteInput {
  category: FailureCategory;
  errorMessage: string;
  goalId: string;
  executionId: string;
}

export interface FailureRouteResult {
  target: RouteTarget;
  incidentType?: string;
}

const FAILURE_PATTERNS: Array<{
  pattern: RegExp;
  category: FailureCategory;
  severity: 'critical' | 'warning';
  label: string;
}> = [
  // infra: connection, timeout, resource exhaustion
  { pattern: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|ECONNRESET/i, category: 'infra', severity: 'critical', label: 'connection_error' },
  { pattern: /out of memory|OOM|heap.*limit|ENOMEM|disk.*full|ENOSPC/i, category: 'infra', severity: 'critical', label: 'resource_exhaustion' },
  { pattern: /service.*down|unreachable|EHOSTUNREACH/i, category: 'infra', severity: 'critical', label: 'service_down' },
  // pipeline: build, test, lint failures
  { pattern: /build.*fail|compilation.*error|tsc.*error/i, category: 'pipeline', severity: 'warning', label: 'build_failure' },
  { pattern: /test.*fail|assertion.*fail|vitest.*fail|jest.*fail/i, category: 'pipeline', severity: 'warning', label: 'test_failure' },
  { pattern: /lint.*error|eslint.*error|prettier.*error/i, category: 'pipeline', severity: 'warning', label: 'lint_failure' },
  // agent: LLM errors, token limits, rate limits
  { pattern: /rate.*limit|429|too many requests|quota.*exceeded/i, category: 'agent', severity: 'warning', label: 'rate_limit' },
  { pattern: /token.*limit|context.*length|maximum.*tokens/i, category: 'agent', severity: 'warning', label: 'token_limit' },
  { pattern: /api.*key|unauthorized|401|authentication/i, category: 'agent', severity: 'critical', label: 'auth_failure' },
  { pattern: /agent.*timeout|execution.*timeout|tmux.*timeout/i, category: 'agent', severity: 'critical', label: 'agent_timeout' },
];

const CATEGORY_TO_ROUTE: Record<FailureCategory, RouteTarget> = {
  infra: 'triage',
  pipeline: 'resolution_kb',
  agent: 'triage',
  unknown: 'human',
};

const CATEGORY_TO_INCIDENT: Record<FailureCategory, string> = {
  infra: 'service_down',
  pipeline: 'validation_failure',
  agent: 'execution_repeated_failure',
  unknown: 'zombie',
};

export function classifyFailure(errorMsg: string): FailureClassification {
  for (const { pattern, category, severity, label } of FAILURE_PATTERNS) {
    if (pattern.test(errorMsg)) {
      return { category, severity, matchedPattern: label };
    }
  }
  return { category: 'unknown', severity: 'warning', matchedPattern: 'unclassified' };
}

export async function routeFailure(input: FailureRouteInput): Promise<FailureRouteResult> {
  const { category } = input;
  const target = CATEGORY_TO_ROUTE[category];
  const incidentType = CATEGORY_TO_INCIDENT[category];
  return { target, incidentType };
}

export function formatTriageMessage(result: TriageResult): string {
  const emoji = { low: '🟢', medium: '🟡', high: '🔴' };
  const classLabel: Record<ErrorClass, string> = {
    syntax_error: '语法错误', type_error: '类型错误', runtime_error: '运行时错误',
    test_failure: '测试失败', dependency_error: '依赖错误', config_error: '配置错误',
    permission_error: '权限错误', unknown_error: '未知错误',
  };
  return [
    `${emoji[result.severity]} **${classLabel[result.errorClass]}** (${result.severity})`,
    result.summary,
    `策略: ${result.strategy}`,
  ].join('\n');
}
