/**
 * CLI 失败分类器（#565 阶段 3）— 纯函数
 *
 * stderr/退出码已知特征 → 「去哪修」指引（给用户看）；与 apps/api triage 的
 * classifyFailure（内部路由策略：auto_retry/escalate）两套并存（2026-09-16 人审决策），
 * 不共用模式表：triage 管路由，本分类器管给人看的修复指引。
 *
 * 放 studio-shared/llm（与 stream-json-parser 同层）：studio-agent（runner 失败路径）
 * 与 apps/api 都可导入。指引文本必须是产品语言，不含内部路径/环境信息。
 *
 * 模式表样本来源：2026-09-16 各 CLI 实测（见 __tests__/failure-classifier.test.ts）。
 */

export type CliFailureCategory =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'cli_not_found'
  | 'flag_unsupported'
  | 'unknown';

export interface CliFailureClass {
  category: CliFailureCategory;
  /** 去哪修：具体命令或配置位置（产品语言） */
  guidance: string;
}

export interface CliFailureInput {
  provider: string;
  exitCode?: number;
  /** stderr + stdout 尾部拼接 */
  output: string;
}

/** auth 类失败的 per-provider 登录指引 */
const LOGIN_GUIDANCE: Record<string, string> = {
  claude: '登录态失效：运行 claude login 重新登录（或检查 ANTHROPIC_API_KEY 环境变量）',
  codex: '登录态失效：运行 codex login 登录',
  kimi: '登录态失效：运行 kimi login 重新登录',
  opencode: '凭证失效：运行 opencode auth login 配置凭证（或检查对应 API key 环境变量）',
};

interface FailurePattern {
  category: Exclude<CliFailureCategory, 'unknown'>;
  pattern: RegExp;
  /** 命中时产出指引；缺省用固定文案 */
  guidance: (provider: string) => string;
}

// 顺序即优先级：auth > quota > rate_limit > cli_not_found > flag_unsupported
const PATTERNS: FailurePattern[] = [
  {
    category: 'auth',
    pattern: /invalid api key|not logged in|unauthorized|authentication[_ ]error|invalid x-api-key|api key (is )?invalid/i,
    guidance: p => LOGIN_GUIDANCE[p] ?? `登录态失效：重新登录 ${p} CLI（或检查其 API key 配置）`,
  },
  {
    category: 'quota',
    pattern: /insufficient[_ ]quota|quota exceeded|exceeded your current quota|credit balance|insufficient credits|余额不足/i,
    guidance: () => '额度耗尽：到对应提供商控制台充值/升档，或切换账号、模型后重试',
  },
  {
    category: 'rate_limit',
    pattern: /\b429\b|too many requests|rate limit/i,
    guidance: () => '触发限流：稍后重试，或降低并发/切换模型',
  },
  {
    category: 'cli_not_found',
    pattern: /command not found|ENOENT|not recognized as an internal or external command/i,
    guidance: p => `找不到 ${p} 命令：确认已安装且在 PATH 中（which ${p}），未安装请先安装`,
  },
  {
    category: 'flag_unsupported',
    pattern: /unknown option|unrecognized option|unknown argument|unexpected argument/i,
    guidance: p => `当前 ${p} CLI 版本不支持该启动参数：升级 ${p} 到最新版本后重试`,
  },
];

/**
 * 分类 CLI 执行失败。返回 null = 无已知特征，调用方走原有透传。
 * exitCode 127 直接判 cli_not_found（shell 惯例：command not found）。
 */
export function classifyCliFailure(input: CliFailureInput): CliFailureClass | null {
  if (input.exitCode === 127) {
    return { category: 'cli_not_found', guidance: PATTERNS.find(p => p.category === 'cli_not_found')!.guidance(input.provider) };
  }
  for (const p of PATTERNS) {
    if (p.pattern.test(input.output)) {
      return { category: p.category, guidance: p.guidance(input.provider) };
    }
  }
  return null;
}
