// Analyst Trigger Service — B1-001: @Analyst detection → RequirementsDoc
// Upgraded: Claude Code agent (persistent worktree) instead of one-shot API call
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import { classifyError, formatTriageMessage } from '../triage/error-class.js';
import { channelMessageService } from './channel-message.service.js';
import { daemon } from '../../daemon/studio-daemon.js';
import * as fs from 'fs';
import * as path from 'path';

const ANALYST_DIR = process.env.ANALYST_DIR || path.join(process.env.REPO_DIR || process.cwd(), '.analyst');
const KNOWLEDGE_FILE = path.join(ANALYST_DIR, 'knowledge.md');
const OUTPUT_FILE = path.join(ANALYST_DIR, 'output.json');

interface RequirementsDocJson {
  title: string;
  summary: string;
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

  return [
    '你是一个需求分析专家，在 Agent Studio 项目中工作。',
    '',
    '## 你的任务',
    '分析用户需求，深入代码库理解现有架构和模式，输出结构化的 RequirementsDoc。',
    '',
    knowledgeSection,
    '## 工作流',
    '1. 读 CLAUDE.md 了解项目架构',
    '2. 探索代码库中和需求相关的模块',
    '3. 识别需要改动的文件和可复用的代码模式',
    '4. 按架构边界拆分为 AC 组（每组可独立并行）',
    '5. 为每个 AC 组写实现指南（文件路径、函数名、代码模式、坑位）',
    '',
    '## 行为约束',
    '- 不确定的文件路径不要编造，探索后确认',
    '- 实现指南要具体到函数名和行号',
    '- 标记潜在坑位：Prisma JSON 序列化、权限中间件、类型生成、schema 迁移等',
    '- 将代码库发现写入 .analyst/knowledge.md（新 markdown section）',
    '',
    '## 输出格式',
    `将 RequirementsDoc JSON 写入 ${OUTPUT_FILE}：`,
    '```json',
    '{',
    '  "title": "需求标题",',
    '  "summary": "一句话总结",',
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

async function runClaudeCode(prompt: string): Promise<RequirementsDocJson> {
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
  try {
    const envelope = JSON.parse(raw);
    if (envelope.result) text = envelope.result;
  } catch (e) {
    logger.error('[AnalystTrigger] Failed to parse JSON envelope', { error: String(e) });
  }

  // Read the output JSON file (Claude Code writes structured output here)
  if (fs.existsSync(OUTPUT_FILE)) {
    const json = fs.readFileSync(OUTPUT_FILE, 'utf-8');
    try {
      return JSON.parse(json);
    } catch {
      const match = json.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match?.[1]) return JSON.parse(match[1].trim());
    }
  }

  // Fallback: try to parse RequirementsDoc from result text
  const jsonMatch = text.match(/\{[\s\S]*"acGroups"[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);

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
      const response = await runClaudeCode(prompt);
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

      logger.info('[AnalystTrigger] RequirementsDoc generated via Claude Code agent', {
        channelId, docId: doc.id, acGroupCount: response.acGroups?.length || 0,
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
    return [
      `## 📋 ${doc.title}`,
      '', doc.summary, '',
      `📊 ${doc.acGroups.length} 模块 · ${acCount} 验收标准 · ${guideCount} 实现指南`,
      tags,
    ].join('\n');
  }

  private formatRequirementsDoc(doc: RequirementsDocJson): string {
    const sections = [`# ${doc.title}`, '', doc.summary, '', '## AC Groups'];
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
