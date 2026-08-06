/**
 * 审查报告类型定义
 *
 * 两阶段审查：
 *   Stage 1: 规范合规 — 对照 AC 逐条验证，审计测试质量，补写补充测试
 *   Stage 2: 代码质量 — 安全、可读性、类型安全（仅 Stage 1 全部通过后）
 *
 * 审查报告写入 worktree 根目录的 .review-report.json
 *
 * verdict/issue 语义归 review-contract.ts 所有 —— overallApproved 是 legacy 二态，
 * 与规范 verdict（pass/reject/needs-info）的映射与裁决规则见该模块。
 */

import type { ReviewIssueSeverity } from './review-contract.js';

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
  /** TDD-09: AC 覆盖率报告 */
  acCoverage?: {
    total: number;
    covered: number;
    missing: string[];
  };
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
  /** TDD-08: 测试是否已保留到 __tests__/ 目录 */
  retained?: boolean;
}

export interface CodeQualityIssue {
  severity: ReviewIssueSeverity;
  file: string;
  line?: number;
  message: string;
}

/** 生成审查 prompt（多立场轮询，替代两阶段） */
export function buildReviewPrompt(params: {
  taskDescription: string;
  acceptanceCriteria?: string[];
  cycle: number;
  /** 🆕 外部立场配置（从 RoleConfig 加载，回退硬编码） */
  stances?: { id: string; name: string; prompt: string; reviewerFocus?: string }[];
  /** D7: Analyst 产物上下文（files, gotchas, architectureContext） */
  acGroupContext?: {
    files?: string[];
    gotchas?: string[];
    architectureContext?: Record<string, unknown>;
    implementationNotes?: string;
  };
}): string {
  const { taskDescription, acceptanceCriteria, cycle, stances, acGroupContext } = params;

  const acList = acceptanceCriteria?.length
    ? acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '（验收标准未明确，请从任务描述中推断）';

  // 🆕 立场列表（外部配置优先，回退默认6立场）
  const defaultReviewStances = [
    { id: 'forensic', name: '根因侦探', focus: 'fallback/default 掩盖上游 bug、hack 而非 root fix、同问题反复出现' },
    { id: 'skeptic', name: '质疑者', focus: '逻辑错误、边界缺失、错误处理、并发时序' },
    { id: 'architect', name: '架构师', focus: '架构越界、模块耦合、安全风险' },
    { id: 'executor', name: '执行者', focus: '可维护性、可运行性、代码导航' },
    { id: 'pragmatist', name: '实用主义者', focus: '过度设计、YAGNI、复杂度' },
    { id: 'ac-compliance', name: '规范合规者', focus: 'diff vs AC 范围逐项对照、非目标变更检测、未授权删除检测' },
  ];
  const reviewStances = stances?.length
    ? stances.filter(s => ['skeptic', 'architect', 'executor', 'pragmatist', 'forensic', 'ac-compliance'].includes(s.id)).map(s => ({
        id: s.id,
        name: s.name,
        focus: s.reviewerFocus || `代码审查 — ${s.name}视角`,
      }))
    : defaultReviewStances;
  // 确保至少有这5个
  if (reviewStances.length === 0) reviewStances.push(...defaultReviewStances);

  const stanceSection = reviewStances.map((s, i) =>
    `### 立场 ${i + 1}: ${s.name} (${s.id}) — ${s.focus}`
  ).join('\n');

  return `## 你的角色：代码审查者（多立场轮询）

这是第 ${cycle} 轮审查。你在一个隔离的 worktree 中，包含 Executor 的代码变更。

### 任务描述
${taskDescription}

### 验收标准
${acList}
${acGroupContext ? `
### Analyst 探索结果（重点审查范围）
**相关文件**: ${acGroupContext.files?.join(', ') || '未指定'}
**已知风险**: ${acGroupContext.gotchas?.join('; ') || '无'}
${acGroupContext.implementationNotes ? `**实现指南**: ${acGroupContext.implementationNotes}` : ''}
${acGroupContext.architectureContext?.dangerZones ? `**危险区域**: ${(acGroupContext.architectureContext.dangerZones as string[]).join('; ')}` : ''}

优先审查上述文件，特别关注已知风险和危险区域。
` : ''}
### Executor 设计笔记
读 \`.progress.json\` 的 \`designNotes\` 字段（如果存在）。它包含 Executor 在实现过程中的关键决策:
- \`decisions\`: 为什么选这个方案而不是别的
- \`failedAttempts\`: 尝试过但放弃的路径及原因
- \`uncertainties\`: Executor 自己不确定、需要重点审查的区域
- \`constraintsDiscovered\`: 实现过程中发现的 AC 未覆盖的限制

使用这些信息来理解**为什么**这样实现，而不只是**做了什么**。如果 Executor 标记了 uncertainties，这些区域是审查重点。

---

## 审查流程：切换 ${reviewStances.length} 个立场

${stanceSection}

每个立场审查相关的问题域。通用检查项：
- 读 git diff 和变更文件完整内容
- 读 .progress.json 的 designNotes（如果有）
- 运行 Executor 的测试，确认通过
- 逐条 AC 核对：代码逻辑是否真的满足了 AC？
- 补写边界测试，尝试打破代码

forensic (根因侦探) 专项检查:
- 新增的 default/fallback/兜底值是否掩盖了上游 bug？追踪数据的完整链路
- 连续 commit 是否有"反复修同一个问题"的模式？（2+ commits 同 symptom）
- fallback 是否有注释说明根因？无说明 = hgih risk
- 异常处理是否真正修复了根因，还是只吞掉了错误？
- 对照 designNotes.failedAttempts：放弃的路径是否留下了未清理的代码或注释？

ac-compliance (规范合规者) 专项检查:
- 逐条 AC 对照 diff：diff 中的每一处变更都必须属于某个 AC 的范围
- 不属于任何 AC 的变更 → severity='error'，标注为"非目标变更"
- 被删除的内容（原命令行参数、原代码逻辑）逐项检查：是否在 AC 中明确要求删除？
- 不在 AC 中的删除 → severity='error'，标注为"未授权的删除"
- 对照 designNotes.decisions：方案选择是否合理？是否存在 AC 要求但 decisions 中回避了的部分？

**阻断规则**:
- 任何 severity='error' 的问题 → overallApproved 必须为 false。error 不是"建议"，是阻断。
- 非目标变更（改了不该改的）→ error
- 未授权删除（删了不该删的）→ error
- designNotes.uncertainties 中标记的区域如果确实有问题 → error（因为 Executor 已经知道了风险但没处理好）

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
    "pragmatist": { "issues": [], "notes": "" },
    "forensic": { "issues": [], "notes": "" },
    "ac-compliance": { "issues": [], "notes": "" }
  },
  "acResults": [
    { "ac": "验收标准原文", "passed": true, "evidence": "在 file.ts:XX 行已实现", "gap": "" }
  ],
  "testQualityAudit": [
    { "executorTest": "test file path", "issue": "只测了 happy path" }
  ],
  "supplementaryTests": [
    { "file": "__tests__/boundary-ac1.test.ts", "description": "null input handling", "catchesIssue": false, "retained": true }
  ],
  "acCoverage": {
    "total": 5,
    "covered": 5,
    "missing": []
  },
  "issues": [
    { "severity": "warning", "file": "src/foo.ts", "line": 42, "message": "变量命名不够清晰", "stance": "executor" }
  ]
}
\`\`\`

**补充测试要求（TDD-08）**：
- 补写的边界测试必须写入 \`__tests__/\` 目录（与 Analyst 的契约测试同级）
- 测试文件必须是可执行的 vitest 代码，不是伪代码
- 在 supplementaryTests 中记录 \`retained: true\` 表示测试已保留到测试套件
- 测试套件 = Analyst 契约测试 + Reviewer 边界测试

**AC 覆盖率检查（TDD-09）**：
- 检查每条 AC 是否有对应的契约测试
- AC 覆盖率 = 有契约测试的 AC / 总 AC
- 在 acCoverage 中报告覆盖率数据
- missing 列出没有契约测试的 AC 编号

**overallApproved** 为 true 当且仅当：
- 所有 AC 通过（acResults 中无 passed=false）
- 无 error 级别 issue
- 补充测试未发现新问题（catchesIssue 全为 false）
`;
}
