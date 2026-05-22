// Analyst Trigger Service — B1-001: @Analyst detection → RequirementsDoc
// Upgraded: Claude Code agent (persistent worktree) instead of one-shot API call
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { formatConstraintsForPrompt } from '@dommaker/harness';
import { classifyError, formatTriageMessage } from '../triage/error-class.js';
import { channelMessageService } from './channel-message.service.js';
import { daemon } from '../../daemon/studio-daemon.js';
import { recordPipelineRun } from '../../daemon/metrics.js';
import * as fs from 'fs';
import * as path from 'path';

const ANALYST_DIR = process.env.ANALYST_DIR || path.join(process.env.REPO_DIR || process.cwd(), '.analyst');
const KNOWLEDGE_FILE = path.join(ANALYST_DIR, 'knowledge.md');
const OUTPUT_FILE = path.join(ANALYST_DIR, 'output.json');

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
    codePatterns: string[];
    gotchas: string[];
  }>;
  constraints: string[];
  tags: string[];
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

function buildAnalystPrompt(requirement: string, knowledge: string): string {
  const knowledgeSection = knowledge
    ? `\n## 历史分析积累\n以下是你之前分析这个代码库时积累的知识，可以直接复用：\n\n${knowledge.slice(-8000)}\n`
    : '\n这是首次分析这个代码库。请先探索项目结构（CLAUDE.md、package.json、关键模块），将发现记录到 .analyst/knowledge.md 以便后续复用。\n';

  const constraintSection = formatConstraintsForPrompt('analyst');

  return [
    '你是一个需求分析专家，在 Agent Studio 项目中工作。',
    '',
    '## 你的任务',
    '分析用户需求，深入代码库理解现有架构和模式，输出结构化的 RequirementsDoc。',
    '',
    constraintSection,
    knowledgeSection,
    '## 工作流',
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
    '5. 按架构边界拆分为 AC 组。每组 3-5 个 AC，一个 Agent 一次执行能完成。禁止一个组超过 6 个 AC',
    '6. 为每个 AC 组写实现指南（文件路径、函数名、代码模式、坑位）',
    '',
    '## 行为约束',
    '- 不确定的文件路径不要编造，探索后确认',
    '- 实现指南要具体到函数名和行号',
    '- 标记潜在坑位：Prisma JSON 序列化、权限中间件、类型生成、schema 迁移等',
    '- 将代码库发现写入 .analyst/knowledge.md（新 markdown section）',
    '- **接口假设必须验证**：实现指南中引用的每个 hook/API/MCP tool/CLI 命令，必须在代码库中确认存在',
    '',
    '## 输出格式',
    `将 RequirementsDoc JSON 写入 ${OUTPUT_FILE}：`,
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
    '    "codePatterns": ["参考实现（文件:行号）"],',
    '    "gotchas": ["⚠️ 潜在坑位"]',
    '  }],',
    '  "constraints": ["约束"],',
    '  "tags": ["标签"]',
    '}',
    '```',
    '',
    '写完 JSON 后，在 stdout 输出 "DONE"。',
    '',
    '---',
    '',
    '## 用户需求',
    requirement,
  ].join('\n');
}

async function runClaudeCode(prompt: string): Promise<{ doc: RequirementsDocJson; usage?: { inputTokens: number; outputTokens: number; cacheHitTokens: number } }> {
  ensureWorktree();

  const result = await daemon.submitJob('analyst', {
    prompt,
    outputFile: OUTPUT_FILE,
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
  if (fs.existsSync(OUTPUT_FILE)) {
    const json = fs.readFileSync(OUTPUT_FILE, 'utf-8');
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
    // 1. Dedup: prevent concurrent triggers within 5 min
    const existing = await prisma.channelMessage.findFirst({
      where: {
        channelId,
        agentName: 'Analyst',
        createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
      },
    });
    if (existing) {
      logger.info('[AnalystTrigger] Skipped — recent analyst activity', { channelId });
      return;
    }

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
        dbKnowledge = await knowledgeQuery.formatAllForPrompt('analyst');
      } catch (e) {
        logger.warn('[AnalystTrigger] Failed to load DB knowledge, continuing with file only', { error: String(e) });
      }

      const knowledge = [fileKnowledge, dbKnowledge].filter(Boolean).join('\n');
      const prompt = buildAnalystPrompt(content, knowledge);

      // 4. Run Claude Code agent (persistent worktree, tool-enabled)
      const { doc: response, usage } = await runClaudeCode(prompt);
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
          tags: JSON.stringify(response.tags || []),
          sourceChannelId: channelId,
          projectId: process.env.REPO_DIR || process.cwd(),
          status: 'draft',
        },
      });

      // 7. Post card
      await channelMessageService.createCardMessage(
        channelId,
        'Analyst',
        this.formatCardContent(response),
        'requirements_doc',
        { requirementsDocId: doc.id },
        triggerMessageId,
      );

      await channelMessageService.deleteMessage(thinkingMsg.id);
      eventBus.publish('channel.requirements_ready', { channelId, requirementsDocId: doc.id });

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
