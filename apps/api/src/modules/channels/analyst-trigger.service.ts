// Analyst Trigger Service — B1-001: @Analyst detection → RequirementsDoc
// Upgraded: Claude Code agent (persistent worktree) instead of one-shot API call
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { formatConstraintsForPrompt } from '@dommaker/studio-shared';
const getFormatConstraintsForPrompt = async (): Promise<(role: string) => string> => formatConstraintsForPrompt;
import { classifyError, formatTriageMessage } from '../triage/error-class.js';
import { channelMessageService } from './channel-message.service.js';
import { daemon } from '../../daemon/studio-daemon.js';
import { recordPipelineRun } from '../../daemon/metrics.js';
import * as fs from 'fs';
import * as path from 'path';

const ANALYST_DIR = process.env.ANALYST_DIR || path.join(process.env.REPO_DIR || process.cwd(), '.analyst');
const KNOWLEDGE_FILE = path.join(ANALYST_DIR, 'knowledge.md');

function perInvocationOutputFile(): string {
  return path.join(ANALYST_DIR, `output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
}

interface RequirementsDocJson {
  title: string;
  summary: string;
  interfaceVerification?: {
    verified: string[];
    unverified: string[];
    newRequired: string[];
  };
  acGroups: Array<{
    id: string;
    acs: string[];
    files: string[];
    dependencies: string[];
    implementationNotes: string;
    architectureContext?: {
      functions: string[];
      callChain: string;
      imports: string[];
      typesInScope: string[];
      testMock: string[];
      dangerZones: string[];
      verifiedAt: string;
    };
    codePatterns: string[];
    gotchas: string[];
    modelTier?: 'fast' | 'standard' | 'premium';
    modelTierReason?: string;
  }>;
  constraints: string[];
  tags: string[];
  discoveries?: Array<{
    type: string;
    severity: string;
    file: string;
    title: string;
    description?: string;
    category?: string;
  }>;
}

// ── Persistent Analyst Session ──

function ensureWorktree(): void {
  if (!fs.existsSync(ANALYST_DIR)) {
    fs.mkdirSync(ANALYST_DIR, { recursive: true });
  }
}

function loadKnowledge(): string {
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      const content = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
      // Only include if fresh (< 24h)
      const stat = fs.statSync(KNOWLEDGE_FILE);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        return content;
      }
    }
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to load knowledge', { error: String(e) });
  }
  return '';
}

function saveKnowledge(analysisTitle: string, findings: string): void {
  ensureWorktree();
  const entry = `\n## ${new Date().toISOString().slice(0, 10)} — ${analysisTitle}\n${findings}\n`;
  try {
    const existing = fs.existsSync(KNOWLEDGE_FILE)
      ? fs.readFileSync(KNOWLEDGE_FILE, 'utf-8')
      : '# Analyst 知识积累\n\n代码库探索记录，跨分析会话复用。\n';
    fs.writeFileSync(KNOWLEDGE_FILE, existing + entry, 'utf-8');
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to save knowledge', { error: String(e) });
  }
}

/**
 * Q7: 按 `## ` 标题分割知识文档，选取与需求关键词匹配的段落
 * 避免无关历史分析污染 Analyst 上下文。无匹配时回退到末尾段落。
 */
function selectRelevantSections(knowledge: string, requirement: string, maxChars: number): string {
  if (!knowledge || knowledge.length <= maxChars) return knowledge;

  const sections = knowledge.split(/(?=^## )/m).filter(s => s.trim());
  if (sections.length <= 1) return knowledge.slice(-maxChars);

  // 从需求提取关键词
  const reqWords = new Set(
    requirement.toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );

  // 按匹配关键词数降序排列段落
  const scored = sections.map(s => {
    const lower = s.toLowerCase();
    const hits = [...reqWords].filter(w => lower.includes(w)).length;
    return { section: s, hits };
  });
  scored.sort((a, b) => b.hits - a.hits);

  // 取 Top-N 段落（不超过 maxChars）
  let result = '';
  for (const { section } of scored) {
    if (result.length + section.length > maxChars) break;
    result += section + '\n';
  }

  // 回退：无匹配时取最末尾的段落（最新知识）
  if (!result.trim()) {
    result = sections.slice(-2).join('\n').slice(-maxChars);
  }

  return result;
}

async function buildAnalystPrompt(requirement: string, knowledge: string, accuracyReflection = '', outputFile: string): Promise<string> {
  // Q7: 按段落分割知识，取与需求相关的前 N 段落（而非简单的 tail -8000chars）
  const relevantKnowledge = selectRelevantSections(knowledge, requirement, 6000);
  const knowledgeSection = knowledge
    ? `\n## 历史分析积累\n以下是你之前分析这个代码库时积累的知识（按相关性筛选），可以直接复用：\n\n${relevantKnowledge}\n`
    : '\n这是首次分析这个代码库。请先探索项目结构（CLAUDE.md、package.json、关键模块），将发现记录到 .analyst/knowledge.md 以便后续复用。\n';

  const fmtFn = await getFormatConstraintsForPrompt();
  const constraintSection = fmtFn('analyst');

  // Detect if preContext was injected (from CST trigger)
  const hasPreContext = requirement.includes('[PRE_CONTEXT]');
  const preContextInstruction = hasPreContext
    ? `\n## 已有上下文（来自前置讨论）\n以下文件和决策已在前期讨论中确认。请先验证这些文件是否仍然存在且未变更（git log -1 <file>），然后直接基于已有上下文生成 RequirementsDoc。只对未覆盖的路径做补充探索。\n`
    : '';

  return [
    '你是一个需求分析专家，在 Agent Studio 项目中工作。',
    '',
    '## 你的任务',
    '分析用户需求，输出结构化的 RequirementsDoc。',
    '',
    '**铁律：只输出用户明确要求的需求。** 代码探索中发现的改进机会（如"这个模块可以升级"）→ 写入 .analyst/knowledge.md，不创建额外的 RequirementsDoc。',
    '',
    '## 分析深度分级（先评估任务复杂度，再决定探索深度）',
    '**Simple**（改 1-2 文件，无新建文件，无 schema 变更）：',
    '  → 只读目标文件 + 直接调用方，30s 内完成分析。写精简 architectureContext（至少含 functions、dangerZones、imports、verifiedAt）',
    '**Medium**（改 3-5 文件，有新建文件，跨模块）：',
    '  → 读相关模块 + 调用链，2min 内完成。写关键 architectureContext',
    '**Complex**（新模块、auth/migration/schema 变更、架构重构）：',
    '  → 完整架构上下文 + 全库探索。写完整 architectureContext',
    '',
    '**自检**：任务描述中有 "修复"/"改"/"替换"/"移除" 关键字 + 指定了具体文件路径 → Simple',
    '',
    accuracyReflection,
    constraintSection,
    knowledgeSection,
    '## 工作流',
    '### 0. 修改点溯源（每个拟改动的文件/函数/命令，先追问三段）',
    '   **a. 为什么存在** — 查 git blame / commit message / 注释，理解原始设计意图',
    '     - 例：`2>&1` 不是随手的写法——它把 stderr 合并到 stdout，为了让 execSh 能捕获错误信息',
    '     - 例：`tee -a logFile` 不是装饰——下游消费者（审计/Auditor/调试）依赖 .agent.log',
    '   **b. 谁在用** — grep 引用链、调用方、import chain、消费者',
    '     - 删除一个参数 → 查所有调用方是否还在传',
    '     - 删除一个输出 → 查下游谁在消费（Prisma relation / API consumer / log parser）',
    '   **c. 边界标注** — 在 AC 里明确标注"只能改 X，不能动 Y，Y 被 Z 消费需要保留"',
    '     - AC 中标注禁区：`AC1.1: 把 cat pipe 改成 file redirect（⚠ 不要删 2>&1——execSh 依赖它捕获 stderr）`',
    '     - files 中可以标注行级范围：`session-manager.ts:L128-L143（仅管道部分，不碰 2>&1 和异常处理）`',
    '   **此步骤是新增的质量闸门——跳过直接进入步骤 1 产生的 AC 会在 RequirementGate 被驳回。**',
    '',
    '### 0.1 CONTEXT.md 目录索引（先读缓存，减少重复探索）',
    '对每个拟改动的目录，先检查 CONTEXT.md：',
    '  - **存在且有效**：`verifiedAt` 对应的 commit 仍在 HEAD 的历史中 → 直接复用，跳过探索',
    '  - **存在但已过期**（⚠️ SessionSummaryAgent 标注了变更文件）：重新验证变更文件，更新 verifiedAt',
    '  - **不存在**：正常探索 → 留下简短 CONTEXT.md。**注意：CONTEXT.md 是目录索引（≤2KB），不是 archCtx。不要写函数签名、行号、调用链。**',
    '',
    '    ```',
    '    ## 本目录',
    '    一句话描述职责',
    '',
    '    ## 核心导出',
    '    filename.ts → ExportName (一句话说明)',
    '',
    '    ## 消费方',
    '    who-depends-on-this-dir → 说明',
    '',
    '    ## 禁区',
    '    不要碰的关键行/函数',
    '',
    '    verifiedAt: <commit hash>',
    '    ```',
    '  **archCtx 仍然由步骤 6a 按需生成（任务级精度）。CONTEXT.md 只做目录定位。**',
    '',
    '1. 读 CLAUDE.md 了解项目架构',
    '2. 探索代码库中和需求相关的模块',
    '3. 识别需要改动的文件和可复用的代码模式',
    '4. 验证接口假设（Schema First）— 方案中提及的每个外部接口必须验证存在：',
    '   - hook 事件 → 搜索 settings.json/hook schema 确认事件名有效',
    '   - MCP tool → 确认 .mcp.json 中已注册',
    '   - API endpoint → 确认 route 已注册（方法+路径）',
    '   - CLI 命令 → 确认 bin/harness.js 中已注册',
    '   - DB field → 确认 Prisma schema 中已定义',
    '   - 不存在的接口 → 标记为"需新增"，不可作为"已存在"引用',
    '5. 按架构边界拆分为 AC 组。默认每组 3-5 AC，合并后 ≤8 可接受',
    '5a. **依赖合并（减少串行等待）**：有依赖关系的两组 → 优先合并为一个组：',
    '   - 组 B 依赖组 A（B 的代码在 A 修改的文件上构建）→ 合并 A+B，总 AC ≤ 8 即合并',
    '   - 合并后 AC 数 > 8 → 保持拆分，但标记 B 的 "dependencies"',
    '   - 绝不让 Executor 等待另一个 Executor 完成后才能开始——合并优于依赖链',
    '5b. **依赖分析（拆分时用）**：不合并时，逐对检查 AC 组之间是否存在实现依赖：',
    '   - 组 B 的 AC 是否调用了组 A 将要创建的函数/类型/接口？',
    '   - 组 B 的 AC 是否在组 A 将要修改的同一文件中插入代码？',
    '   - 组 B 的 AC 是否导入了组 A 将要创建的文件？',
    '   - 有依赖 → 在组 B 的 "dependencies" 中列出组 A 的 id',
    '   - 无依赖 → dependencies 为空数组',
    '   - ⚠️ 依赖分析失误是管线最高成本的缺陷（重复实现 3 次），必须严肃对待',
    '6. 为每个 AC 组写实现指南（文件路径、函数名、代码模式、坑位）',
    '6a. **架构上下文（关键）**：对每个 AC 组输出 architectureContext，让 Executor 不需要自己探索代码库：',
    '   - functions: 关联函数签名+行号（如 handleGoalSucceeded(goalId): Promise<void> @ L612）',
    '   - callChain: 调用链说明（谁调用了这个函数，怎么触发的）',
    '   - imports: 本组需要的 import 语句（完整，可直接复制）',
    '   - typesInScope: 相关类型定义位置和字段',
    '   - testMock: mock 设置模板（jest/vi.mock 语句）',
    '   - dangerZones: 文件中的禁区（不要碰的函数、容易出错的早期 return、共享的中间件）',
    '   - verifiedAt: 你验证这些信息时的 commit hash 或时间戳',
    '   - ⚠️ 这个字段是 Executor 不探索代码库的基础，信息错误会导致 Executor 在错误位置插入代码。必须精确。',
    '',
    '## 行为约束',
    '- 不确定的文件路径不要编造，探索后确认',
    '- 实现指南要具体到函数名和行号',
    '- **AC 必须标注边界**：每个 AC 末尾标注 "（⚠ 保留 X、Y、Z——他们被 A、B、C 消费）"',
    '- 标记潜在坑位：Prisma JSON 序列化、权限中间件、类型生成、schema 迁移等',
    '- dependencies 必须精确填写：有函数/类型/文件依赖→填组 id，无依赖→空数组[]，不确定→标注"可能依赖"并填组 id',
    '- 将代码库发现写入 .analyst/knowledge.md（新 markdown section）',
    '- **接口假设必须验证**：实现指南中引用的每个 hook/API/MCP tool/CLI 命令，必须在代码库中确认存在',
    '- **gotchas 要用红线格式**：标注"不可删除: X (下游: Y)"、"不可修改: A (消费者: B)"',
    '- **modelTier 决策**：为每个 AC 组标注执行模型档位（你探索过代码，知道真实复杂度）：',
    '  - fast: files ≤ 2，implementationNotes 精确到函数名+行号，gotchas 为空或仅信息性，无跨模块依赖',
    '  - standard: files 3~4，implementationNotes 有方向但缺部分细节，gotchas 有约束但非红线，模块内依赖',
    '  - premium: files ≥ 5，architectureContext 有完整调用链，gotchas 包含红线约束，涉及架构变更/安全/外部 API，需要 Executor 自己探索',
    '  - 核心区别：fast 照着做，standard 想着做，premium 探着做',
    '  - **fast 必须验证性探索**（表面简单 ≠ 实际简单）：',
    '    1. 文件被多少模块 import？（grep import 路径）→ 超过 3 个消费者 → 升级 standard',
    '    2. 类型/数据是否序列化到外部？（grep JSON.stringify/DB/webhook）→ 有序列化边界 → 升级 standard',
    '    3. 函数是否有下游消费者？（grep 函数名）→ 有非本模块调用者 → 升级 standard',
    '    - 验证成本极低（几秒），但能过滤 80% 假 fast。未验证就标 fast = 赌博',
    '',
    '## 输出格式',
    `将 RequirementsDoc JSON 写入 ${outputFile}：`,
    '```json',
    '{',
    '  "title": "需求标题",',
    '  "summary": "一句话总结",',
    '  "interfaceVerification": {',
    '    "verified": ["已验证存在的接口: hook:PostToolUse - .claude/settings.json schema"],',
    '    "unverified": ["未找到但方案引用的接口: hook:afterTurn - 不在有效事件列表中"],',
    '    "newRequired": ["需要新建的接口: POST /api/knowledge/upsert"]',
    '  },',
    '  "acGroups": [{',
    '    "id": "组名（架构边界）",',
    '    "acs": ["可验证的验收标准"],',
    '    "files": ["具体文件路径"],',
    '    "dependencies": ["依赖的组 id"],',
    '    "implementationNotes": "实现指南：步骤+函数名+关键决策",',
    '    "architectureContext": {',
    '      "functions": ["handleGoalSucceeded(goalId: string): Promise<void> @ L612"],',
    '      "callChain": "checkGoalCompletion() → handleGoalSucceeded() → finalizeGoalSucceeded()",',
    '      "imports": ["import { writeTrace } from \'../monitoring/trace-pipeline.service\'"],',
    '      "typesInScope": ["TraceContext { goalId: string; projectId: string; phase: string; timestamp: number } @ trace-pipeline.service.ts:L15"],',
    '      "testMock": ["vi.mock(\'../monitoring/trace-pipeline.service\', () => ({ writeTrace: vi.fn().mockResolvedValue(undefined) }))"],',
    '      "dangerZones": ["L640 有早期 return，不要在它之后插入代码"],',
    '      "verifiedAt": "abc1234 (commit hash)"',
    '    },',
    '    "codePatterns": ["参考实现（文件:行号）"],',
    '    "gotchas": ["⚠️ 潜在坑位"],',
    '    "modelTier": "fast|standard|premium",',
    '    "modelTierReason": "选档理由（一句话）"',
    '  }],',
    '  "constraints": ["约束"],',
    '  "tags": ["标签"],',
    '  "discoveries": [{',
    '    "type": "tech_debt|bug|improvement|security|deprecation|observation",',
    '    "severity": "low|medium|high|critical",',
    '    "file": "文件路径",',
    '    "title": "简短标题",',
    '    "description": "1-3 句话描述",',
    '    "effort": "minutes|hours|days|unknown"',
    '  }]',
    '}',
    '```',
    '',
    '写完 JSON 后，在 stdout 输出 "DONE"。',
    '',
    '**发现（Discoveries）**：探索过程中发现的不属于本次需求但值得注意的问题 → 写入 discoveries 字段。',
    '- 不阻塞主需求，不影响 RequirementsDoc 生成',
    '- 示例：发现某模块使用了废弃的 API、某处存在潜在安全风险',
    '---',
    '',
    '## 用户需求',
    preContextInstruction,
    requirement,
  ].join('\n');
}

// O1d: accept optional claudeArgs for tool restriction on Simple tasks
async function runClaudeCode(prompt: string, outputFile: string, claudeArgs?: string[]): Promise<{ doc: RequirementsDocJson; usage?: { inputTokens: number; outputTokens: number; cacheHitTokens: number } }> {
  ensureWorktree();

  // Use ad-hoc session for concurrent @Analyst support
  const result = await daemon.submitAdhocJob({
    prompt,
    outputFile,
    ...(claudeArgs ? { claudeArgs } : {}),
  }, {
    worktree: process.env.REPO_DIR || process.cwd(), // needs access to project source, not .analyst/
    modelTier: 'premium',
  });

  if (!result.success) {
    throw new Error(`Analyst daemon task failed: ${result.error}`);
  }

  const raw = result.output || '';

  // --output-format json → Claude Code 返回 JSON envelope: { result, usage }
  let text = raw;
  let usage: { inputTokens: number; outputTokens: number; cacheHitTokens: number } | undefined;
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result) text = envelope.result;
    if (envelope.usage) {
      usage = {
        inputTokens: envelope.usage.input_tokens || 0,
        outputTokens: envelope.usage.output_tokens || 0,
        cacheHitTokens: envelope.usage.cache_read_input_tokens || envelope.usage.cache_creation_input_tokens || 0,
      };
    }
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to parse JSON envelope', { error: String(e) });
  }

  // Read the output JSON file (Claude Code writes structured output here)
  if (fs.existsSync(outputFile)) {
    const json = fs.readFileSync(outputFile, 'utf-8');
    try {
      return { doc: JSON.parse(json), usage };
    } catch {
      const match = json.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match?.[1]) return { doc: JSON.parse(match[1].trim()), usage };
    }
  }

  // Fallback: try to parse RequirementsDoc from result text
  const jsonMatch = text.match(/\{[\s\S]*"acGroups"[\s\S]*\}/);
  if (jsonMatch) return { doc: JSON.parse(jsonMatch[0]), usage };

  throw new Error(`Analyst did not produce valid output. text: ${text.slice(0, 500)}`);
}

// ── Service ──

class AnalystTriggerService {
  async trigger(channelId: string, triggerMessageId: string, content: string): Promise<void> {
    // 1. Dedup: use daemon session state, not ChannelMessage (失败消息不应阻断重试)
    const status = daemon.getStatus('analyst') as { isBusy: boolean; lastUsed: number } | null;
    const COOLDOWN_MS = 5 * 60 * 1000;
    if (status) {
      if (status.isBusy) {
        logger.info('[AnalystTrigger] Skipped — analyst session is busy', { channelId });
        return;
      }
      if (status.lastUsed > 0 && (Date.now() - status.lastUsed) < COOLDOWN_MS) {
        logger.info('[AnalystTrigger] Skipped — analysis completed recently', {
          channelId,
          secondsAgo: Math.round((Date.now() - status.lastUsed) / 1000),
        });
        return;
      }
    }

    // 1b. Pre-flight: verify API key + Claude availability before spending tokens
    try {
      const token = process.env.ANTHROPIC_AUTH_TOKEN;
      if (!token || token.length < 10) {
        logger.error('[AnalystTrigger] Pre-flight failed — ANTHROPIC_AUTH_TOKEN missing or invalid');
        return;
      }
    } catch { /* best-effort */ }

    // 2. Post "thinking" message
    const thinkingMsg = await channelMessageService.createAgentMessage(
      channelId,
      'Analyst',
      '🔍 正在探索代码库并分析需求... (0s)',
      { meta: { status: 'thinking' } },
    );

    // Progress heartbeat — update thinking message every 30s
    const startTime = Date.now();
    const progressInterval = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      try {
        await channelMessageService.updateMessage(thinkingMsg.id, {
          content: `🔍 正在探索代码库并分析需求... (${elapsed}s)`,
        });
      } catch (e) {
        logger.error('[AnalystTrigger] Failed to update progress message', { error: String(e) });
      }
    }, 30000);

    try {
      // 3. Load accumulated knowledge + build prompt
      const fileKnowledge = loadKnowledge();

      // G-001~005: 加载 DB 知识（KK 提取的 pitfall/pattern + 偏好 + 规则 + 环境）
      let dbKnowledge = '';
      try {
        const { knowledgeQuery } = await import('../knowledge/knowledge-query.service.js');
        const allKnowledge = await knowledgeQuery.formatAllForPrompt('analyst');
        // P0.2: 按需求相关性评分查询历史知识（与"最近N条"互补）
        const relevantKnowledge = await knowledgeQuery.queryRelevantForRequirement(content, 8);
        dbKnowledge = [allKnowledge, relevantKnowledge].filter(Boolean).join('\n');
      } catch (e) {
        logger.warn('[AnalystTrigger] Failed to load DB knowledge, continuing with file only', { error: String(e) });
      }

      // Analyst accuracy 闭环: 加载上次预测准确率 → 定向纠正
      let accuracyReflection = '';
      try {
        const { sharedStore } = await import('../knowledge/knowledge-bus.service.js');
        const accuracyEntries = sharedStore.list({ tags: ['analyst_accuracy'] })
          .filter(e => e.maturity !== 'archived')
          .sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))
          .slice(0, 3);
        if (accuracyEntries.length > 0) {
          const lines = [
            '## 预测反思（自动分析）',
            '以下是你在之前分析中的预测准确率记录，请针对性改进：',
          ];
          for (const e of accuracyEntries) {
            const content = e.content || '';
            const fileMatch = content.match(/AC匹配率:\s*(\d+)%/);
            const missed = content.match(/漏预测文件:\s*([^\]]+)/);
            const extra = content.match(/多预测文件:\s*([^\]]+)/);
            const missedDeps = content.match(/漏预测依赖:\s*([^\]]+)/);
            const suggestions: string[] = [];
            if (missed) suggestions.push(`文件遗漏: ${missed[1].trim()}`);
            if (extra) suggestions.push(`文件多报: ${extra[1].trim()}`);
            if (missedDeps) suggestions.push(`依赖遗漏: ${missedDeps[1].trim()}`);
            if (!missed && !extra && !missedDeps && fileMatch) {
              suggestions.push('预测准确，继续保持');
            }
            const matchRate = fileMatch ? `${fileMatch[1]}%` : 'N/A';
            lines.push(`- ⚠️ [准确率:${matchRate}] ${e.title}: ${suggestions.join('; ') || content.slice(0, 200)}`);
          }
          lines.push(
            '',
            '**改进提示**: 以上述模式为鉴，重点检查是否漏报了文件、是否漏声明了依赖关系。',
          );
          accuracyReflection = lines.join('\n') + '\n';
        }
      } catch (e) {
        logger.warn('[AnalystTrigger] Failed to load analyst accuracy', { error: String(e) });
      }

      const knowledge = [fileKnowledge, dbKnowledge].filter(Boolean).join('\n');
      const outputFile = perInvocationOutputFile();
      const prompt = await buildAnalystPrompt(content, knowledge, accuracyReflection, outputFile);

      // 4. Run Claude Code agent (ad-hoc session, supports concurrent @Analyst)
      // O1d: Restrict tool access for Simple tasks (short content, no schema change keywords)
      const isSimpleTask = content.length < 500 && !/(schema|migration|migrate|auth|new\s+module|架构重构)/i.test(content);
      const claudeArgs = isSimpleTask ? ['--allowedTools', 'Bash,Edit,Read,Grep'] : undefined;
      const { doc: response, usage } = await runClaudeCode(prompt, outputFile, claudeArgs);
      const durationMs = Date.now() - startTime;
      clearInterval(progressInterval);

      // 5. Save new knowledge for next analysis
      const findings = response.acGroups
        .map(g => `- **${g.id}**: ${g.implementationNotes?.slice(0, 200) || ''}`)
        .join('\n');
      saveKnowledge(response.title || '需求分析', findings);

      // 6. Save RequirementsDoc to DB
      const doc = await prisma.requirementsDoc.create({
        data: {
          title: response.title || '需求分析',
          content: this.formatRequirementsDoc(response),
          acGroups: JSON.stringify(response.acGroups || []),
          tags: JSON.stringify(response.tags || []),
          sourceChannelId: channelId,
          projectId: null,
          status: 'draft',
        },
      });

      // 7. Post card
      const cardMsg = await channelMessageService.createCardMessage(
        channelId,
        'Analyst',
        this.formatCardContent(response),
        'requirements_doc',
        { requirementsDocId: doc.id },
        triggerMessageId,
      );

      await channelMessageService.deleteMessage(thinkingMsg.id);
      eventBus.publish('channel.requirements_ready', { channelId, requirementsDocId: doc.id });

      // Q8: 自动触发 start_execution — Analyst 完成即开始执行，无需人工点击
      this.autoStartExecution(channelId, cardMsg.id).catch((e: any) => {
        logger.warn('[AnalystTrigger] Auto-start failed (card will show start button)', { error: String(e) });
      });

      // 8. Auto-capture architectural knowledge (KnowledgeSync Cycle 1)
      try {
        const { knowledgeSync } = await import('../knowledge/knowledge-sync.service.js');
        const discoveredFiles = response.acGroups?.flatMap((g: any) => g.files || []) || [];
        const scopeName = response.title ? response.title.toLowerCase().replace(/\s+/g, '-').slice(0, 40) : 'analysis';
        if (discoveredFiles.length > 0) {
          await knowledgeSync.capture({
            scope: scopeName,
            content: [
              `## ${response.title}`,
              response.summary || '',
              '',
              '### Modules Analyzed',
              ...response.acGroups.map((g: any) => `- **${g.id}**: ${g.files?.join(', ') || 'N/A'}`),
              '',
              '### Key Patterns',
              ...(response.acGroups?.flatMap((g: any) => g.codePatterns || []).slice(0, 5) || []).map((p: string) => `- ${p}`),
              '',
              '### Gotchas',
              ...(response.acGroups?.flatMap((g: any) => g.gotchas || []).slice(0, 5) || []).map((g: string) => `- ⚠️ ${g}`),
            ].join('\n'),
            source: 'analyst',
          });
        }

        // P0.2: Write Analyst discoveries to KnowledgeBus (KK→Analyst feedback loop)
        // Subsequent Analyst runs pick these up via knowledgeBus.getRecentContext()
        try {
          const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
          const allGotchas = response.acGroups?.flatMap((g: any) => g.gotchas || []) || [];
          const allPatterns = response.acGroups?.flatMap((g: any) => g.codePatterns || []) || [];
          for (const gotcha of allGotchas.slice(0, 5)) {
            await knowledgeBus.recordPattern({
              source: 'analyst',
              type: 'pitfall',
              title: `[Analyst] ${response.title}: ${gotcha.slice(0, 80)}`,
              content: gotcha,
              severity: 'warning',
              timestamp: Date.now(),
            });
          }
          for (const pattern of allPatterns.slice(0, 5)) {
            await knowledgeBus.recordPattern({
              source: 'analyst',
              type: 'pattern',
              title: `[Analyst] ${response.title}: ${pattern.slice(0, 80)}`,
              content: pattern,
              severity: 'info',
              timestamp: Date.now(),
            });
          }
        } catch { /* KnowledgeBus write-back is best-effort, don't block pipeline */ }

        // G33: Expose discoveries to channel (non-blocking)
        if (response.discoveries?.length) {
          const { discoveryExposure } = await import('./discovery-exposure.service.js');
          discoveryExposure.expose(response.discoveries.map((d: any) => ({
            source: 'analyst' as const,
            type: d.type || 'observation',
            severity: d.severity || 'medium',
            file: d.file || '',
            title: d.title || '',
            description: d.description || '',
            effort: d.effort,
          })), channelId).catch((e: any) => logger.warn('[AnalystTrigger] Discovery exposure failed', { error: String(e) }));
        }
      } catch (e: any) {
        logger.warn('[AnalystTrigger] KnowledgeSync capture failed (non-blocking)', { error: String(e) });
      }

      // 9. Record Analyst phase metrics
      const acCount = response.acGroups?.reduce((sum, g) => sum + g.acs.length, 0) || 0;
      recordPipelineRun({
        source: 'pipeline', phase: 'analyst',
        taskName: response.title || '需求分析',
        model: usage ? 'claude' : 'claude',
        inputTokens: usage?.inputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        cacheHitTokens: usage?.cacheHitTokens || 0,
        durationMs,
        success: true,
        sessionId: doc.id,
      }).catch(() => { /* non-blocking */ });

      logger.info('[AnalystTrigger] RequirementsDoc generated', {
        channelId, docId: doc.id, acGroupCount: response.acGroups?.length || 0,
        durationMs, fileKnowledgeSize: fileKnowledge.length, dbKnowledgeSize: dbKnowledge.length,
        tokens: usage,
      });
    } catch (err) {
      clearInterval(progressInterval);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const triage = classifyError(errorMessage);
      logger.error('[AnalystTrigger] Analysis failed', { error: errorMessage, triage });

      await channelMessageService.updateMessage(thinkingMsg.id, {
        content: `❌ 分析失败\n\n${formatTriageMessage(triage)}`,
        meta: { status: 'error', error: errorMessage, triage } as any,
      });
    }
  }

  // ── Formatting ──

  private formatCardContent(doc: RequirementsDocJson): string {
    const acCount = doc.acGroups.reduce((sum, g) => sum + g.acs.length, 0);
    const tags = doc.tags?.length ? `\n🏷️ ${doc.tags.join(' · ')}` : '';
    const guideCount = doc.acGroups.filter(g => g.implementationNotes).length;
    const iv = doc.interfaceVerification;
    const unverifiedWarn = iv?.unverified?.length
      ? `\n⚠️ ${iv.unverified.length} 个接口假设未验证: ${iv.unverified.join(', ')}`
      : '';
    return [
      `## 📋 ${doc.title}`,
      '', doc.summary, '',
      `📊 ${doc.acGroups.length} 模块 · ${acCount} 验收标准 · ${guideCount} 实现指南`,
      tags,
      unverifiedWarn,
    ].join('\n');
  }

  /**
   * Q8: 自动触发 start_execution — 通过内部 HTTP 调用 actions 端点
   */
  private async autoStartExecution(channelId: string, cardMessageId: string): Promise<void> {
    const port = process.env.PORT || '3001';
    const resp = await fetch(`http://127.0.0.1:${port}/api/v1/channels/${channelId}/messages/${cardMessageId}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start_execution' }),
    });
    const result = await resp.json() as { success: boolean; error?: string };
    if (!result.success) {
      throw new Error(result.error || 'start_execution failed');
    }
  }

  private formatRequirementsDoc(doc: RequirementsDocJson): string {
    const sections = [`# ${doc.title}`, '', doc.summary, ''];
    if (doc.interfaceVerification) {
      sections.push(
        '## Schema First Verification',
        '',
        `<!-- INTERFACE_VERIFICATION ${JSON.stringify(doc.interfaceVerification)} -->`,
        '',
        ...(doc.interfaceVerification.verified.length ? ['### Verified', ...doc.interfaceVerification.verified.map(v => `- ✅ ${v}`), ''] : []),
        ...(doc.interfaceVerification.unverified.length ? ['### ⚠️ Unverified', ...doc.interfaceVerification.unverified.map(v => `- ❌ ${v}`), ''] : []),
        ...(doc.interfaceVerification.newRequired.length ? ['### 🆕 New Required', ...doc.interfaceVerification.newRequired.map(v => `- 📝 ${v}`), ''] : []),
      );
    }
    sections.push('', '## AC Groups');
    for (const g of doc.acGroups) {
      sections.push('', `### ${g.id}`);
      if (g.modelTier) {
        sections.push(`<!-- MODEL_TIER ${JSON.stringify({ tier: g.modelTier, reason: g.modelTierReason || '' })} -->`);
      }
      sections.push('', '#### 验收标准');
      for (const ac of g.acs) sections.push(`- [ ] ${ac}`);
      if (g.implementationNotes) {
        sections.push('', '#### 实现指南', g.implementationNotes);
      }
      if (g.codePatterns.length) {
        sections.push('', '#### 参考模式', ...g.codePatterns.map(p => `- ${p}`));
      }
      if (g.gotchas.length) {
        sections.push('', '#### ⚠️ 注意事项', ...g.gotchas.map(gc => `- ${gc}`));
      }
      if (g.files.length) {
        sections.push('', '#### 涉及文件', ...g.files.map(f => `- ${f}`));
      }
      if (g.dependencies.length) {
        sections.push('', `#### 依赖: ${g.dependencies.join(', ')}`);
      }
    }
    if (doc.constraints.length) {
      sections.push('', '## 约束', ...doc.constraints.map(c => `- ${c}`));
    }
    return sections.join('\n');
  }
}

export const analystTriggerService = new AnalystTriggerService();
