/**
 * 审查报告类型定义
 *
 * 两阶段审查：
 *   Stage 1: 规范合规 — 对照 AC 逐条验证，审计测试质量，补写补充测试
 *   Stage 2: 代码质量 — 安全、可读性、类型安全（仅 Stage 1 全部通过后）
 *
 * 审查报告写入 worktree 根目录的 .review-report.json
 */

export interface StanceReport {
  issues: CodeQualityIssue[];
  notes: string;
}

export interface ReviewReport {
  cycle: number;
  overallApproved: boolean;
  stanceReports?: {
    skeptic: StanceReport;
    architect: StanceReport;
    executor: StanceReport;
    pragmatist: StanceReport;
  };
  acResults: AcVerificationResult[];
  testQualityAudit: TestQualityIssue[];
  supplementaryTests: SupplementaryTestResult[];
  issues: CodeQualityIssue[];
  suggestions?: string[];
}

export interface AcVerificationResult {
  ac: string;
  passed: boolean;
  evidence: string;
  /** 未通过时的缺口描述 */
  gap?: string;
}

export interface TestQualityIssue {
  executorTest: string;
  issue: string;
}

export interface SupplementaryTestResult {
  file: string;
  description: string;
  /** 补充测试是否发现了 Executor 未处理的问题 */
  catchesIssue: boolean;
}

export interface CodeQualityIssue {
  severity: 'error' | 'warning' | 'info';
  file: string;
  line?: number;
  message: string;
}

/** 生成审查 prompt（多立场轮询，替代两阶段） */
export function buildReviewPrompt(params: {
  taskDescription: string;
  acceptanceCriteria?: string[];
  cycle: number;
  previousReportPath?: string;
  /** 🆕 外部立场配置（从 RoleConfig 加载，回退硬编码） */
  stances?: { id: string; name: string; prompt: string; reviewerFocus?: string }[];
}): string {
  const { taskDescription, acceptanceCriteria, cycle, previousReportPath, stances } = params;

  const acList = acceptanceCriteria?.length
    ? acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '（验收标准未明确，请从任务描述中推断）';

  // 🆕 立场列表（外部配置优先，回退默认4立场）
  const defaultReviewStances = [
    { id: 'skeptic', name: '质疑者', focus: '逻辑错误、边界缺失、错误处理、并发时序' },
    { id: 'architect', name: '架构师', focus: '架构越界、模块耦合、安全风险' },
    { id: 'executor', name: '执行者', focus: '可维护性、可运行性、代码导航' },
    { id: 'pragmatist', name: '实用主义者', focus: '过度设计、YAGNI、复杂度' },
  ];
  const reviewStances = stances?.length
    ? stances.filter(s => ['skeptic', 'architect', 'executor', 'pragmatist'].includes(s.id)).map(s => ({
        id: s.id,
        name: s.name,
        focus: s.reviewerFocus || `代码审查 — ${s.name}视角`,
      }))
    : defaultReviewStances;
  // 确保至少有这4个
  if (reviewStances.length === 0) reviewStances.push(...defaultReviewStances);

  const stanceSection = reviewStances.map((s, i) =>
    `### 立场 ${i + 1}: ${s.name} (${s.id}) — ${s.focus}`
  ).join('\n');

  const previousInstructions = cycle > 1 && previousReportPath
    ? `\n## 上一轮审查报告\n请先读取 \`.review-report.json\`，确认上一轮发现的问题是否已修复。`
    : '';

  return `## 你的角色：代码审查者（多立场轮询）

这是第 ${cycle} 轮审查。你在一个隔离的 worktree 中，包含 Executor 的代码变更。

### 任务描述
${taskDescription}

### 验收标准
${acList}
${previousInstructions}

---

## 审查流程：切换 ${reviewStances.length} 个立场

${stanceSection}

每个立场审查相关的问题域。通用检查项：
- 读 git diff 和变更文件完整内容
- 运行 Executor 的测试，确认通过
- 逐条 AC 核对：代码逻辑是否真的满足了 AC？
- 补写边界测试，尝试打破代码

---

## 输出格式

每个立场审查完后，记录发现的问题。全部完成后，写入 \`.review-report.json\`：

\`\`\`json
{
  "cycle": ${cycle},
  "overallApproved": true,
  "stanceReports": {
    "skeptic": { "issues": [], "notes": "" },
    "architect": { "issues": [], "notes": "" },
    "executor": { "issues": [], "notes": "" },
    "pragmatist": { "issues": [], "notes": "" }
  },
  "acResults": [
    { "ac": "验收标准原文", "passed": true, "evidence": "在 file.ts:XX 行已实现", "gap": "" }
  ],
  "testQualityAudit": [
    { "executorTest": "test file path", "issue": "只测了 happy path" }
  ],
  "supplementaryTests": [
    { "file": "补充测试路径", "description": "", "catchesIssue": false }
  ],
  "issues": [
    { "severity": "warning", "file": "src/foo.ts", "line": 42, "message": "变量命名不够清晰", "stance": "executor" }
  ]
}
\`\`\`

**overallApproved** 为 true 当且仅当：
- 所有 AC 通过（acResults 中无 passed=false）
- 无 error 级别 issue
- 补充测试未发现新问题（catchesIssue 全为 false）
`;
}
