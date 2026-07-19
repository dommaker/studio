/**
 * Knowledge Agent — 会话分析子模块
 *
 * 从 knowledge-agent.service.ts 拆分（提取/冷启动/分析分离，零行为变更）。
 * 本模块负责对会话/讨论文本的 LLM 分析：
 *   - extractDecision     决策记录提取（DecisionRecord → KnowledgeBus.recordDecision）
 *   - extractUserBehavior KE-003 用户行为模式提取（correction/pattern/automation →
 *                         UserBehaviorProfile 存储 + 高置信度即时消费 Skill/memory 文件）
 */

import { modelGateway, logger } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import type { DecisionRecord } from '@dommaker/harness';
import { channelMessageService } from '../channels/channel-message.service.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getOrCreateSystemChannel } from './knowledge-extraction.js';

/** Infer decision category from topic keywords */
function inferDecisionCategory(topic: string): DecisionRecord['category'] {
  const t = topic.toLowerCase();
  if (t.match(/schema|架构|api|分层|模块|service|repository/i)) return 'architecture';
  if (t.match(/tool|工具|db|database|sqlite|postgres|storage|orm/i)) return 'tooling';
  if (t.match(/流程|部署|deploy|pipeline|ci|cd|nginx|docker/i)) return 'process';
  return 'design';
}

/**
 * Extract a decision record from text content using LLM.
 *
 * Returns null if no decision found or on any error.
 */
export async function extractDecision(
  content: string,
  source: string,
): Promise<DecisionRecord | null> {
  try {
    if (!content || content.trim().length === 0) {
      return null;
    }

    const truncatedContent = content.slice(0, 50_000);

    const DECISION_SYSTEM_PROMPT = `你是一个决策分析师。从以下讨论记录中提取决策。

每个决策应包含：
- topic: 决策主题（简洁）
- context: 决策背景（当时面临什么问题，1-2 句话）
- options: 候选方案列表 [{ name, pros: [...], cons: [...] }]
- chosen: 最终选择的方案名称
- rationale: 选择理由（为什么选这个而不是其他，1-2 句话）
- tradeoffs: 已知权衡（放弃/妥协了什么）
- revisable: 是否可以推翻 (true/false)
- revisitCondition: 什么条件下应重新审视

请严格以 JSON 格式返回：
{
  "decisions": [
    {
      "topic": "...",
      "context": "...",
      "options": [{"name": "...", "pros": ["..."], "cons": ["..."]}],
      "chosen": "...",
      "rationale": "...",
      "tradeoffs": "...",
      "revisable": true,
      "revisitCondition": "..."
    }
  ]
}

提取规则：
- 只提取有实质内容的决策，忽略 trivial 选择
- 没有明确决策的讨论 → 返回空数组
- 最多提取 1 个决策`;

    let result: any;
    try {
      result = await modelGateway.promptJson(
        truncatedContent,
        DECISION_SYSTEM_PROMPT,
        { provider: 'knowledge', tier: 'standard' },
      );
    } catch (e) {
      logger.warn('[KnowledgeAgent] extractDecision failed', { source: source.slice(-40), error: String(e) });
      return null;
    }

    const decision = result.decisions?.[0];
    if (!decision) {
      return null;
    }

    // Map to DecisionRecord
    const category = inferDecisionCategory(decision.topic || '');
    const record: DecisionRecord = {
      topic: decision.topic || '',
      category,
      context: decision.context || '',
      decision: decision.chosen || '',
      alternatives: Array.isArray(decision.options) ? decision.options.map((o: any) => o.name || String(o)) : [],
      rationale: decision.rationale || '',
      consequences: decision.tradeoffs || '',
      participants: [],
      sourceType: 'llm-extraction',
      revisable: decision.revisable ?? true,
      revisitCondition: decision.revisitCondition,
    };

    // Write to KnowledgeStore via KnowledgeBus
    const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
    await knowledgeBus.recordDecision(record);

    return record;
  } catch (err) {
    logger.warn('[KnowledgeAgent] extractDecision failed', { source: source.slice(-40), error: String(err) });
    return null;
  }
}

/**
 * KE-003: Extract user behavior patterns from session transcript.
 *
 * Three signal types: correction (user corrects assistant), pattern (decision chain),
 * automation (repeated manual ops). Results stored in UserBehaviorProfile table.
 *
 * Layer 1 context injection: existing profiles + memory rules into prompt to avoid re-extraction.
 *
 * @param content - Preprocessed transcript (filtered + truncated by caller)
 * @param source - "session:<uuid>" identifier
 * @param threshold - Minimum confidence (default 0.6)
 */
export async function extractUserBehavior(
  fileStore: FileStore,
  content: string,
  source: string,
  threshold: number = 0.6,
): Promise<void> {
  try {
    if (!content || content.trim().length === 0) {
      logger.info('[KnowledgeAgent] Empty transcript, skipping behavior extraction', { source });
      return;
    }

    // Extract sessionId from source: "session:<uuid>.jsonl.bak..." → "<uuid>"
    const sessionId = source.replace('session:', '').split('.jsonl')[0];

    // Layer 1: inject existing patterns for dedup (KnowledgeStore)
    const { sharedStore: behaviorStore } = await import('../knowledge/knowledge-bus.service.js');
    const behaviorEntries = behaviorStore.list({ tags: ['behavior'] });
    const existingTitles = behaviorEntries.slice(0, 50).map((e: any) => e.title);

    // Read memory rules for dedup
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');
    let memoryRules: string[] = [];
    try {
      const { readdirSync, readFileSync } = await import('fs');
      const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
      memoryRules = files.slice(0, 30).map(f => {
        const raw = readFileSync(path.join(memoryDir, f), 'utf-8');
        const titleMatch = raw.match(/^name:\s*(.+)$/m);
        return titleMatch ? titleMatch[1] : f.replace('.md', '');
      });
    } catch { /* non-critical */ }

    const existingPatternsBlock = [
      existingTitles.length > 0 ? `已有行为模式（不要重复提取）:\n${existingTitles.map(t => `- ${t}`).join('\n')}` : '',
      memoryRules.length > 0 ? `已有 memory 规则:\n${memoryRules.map(r => `- ${r}`).join('\n')}` : '',
      '只提取以上未覆盖的新模式。',
    ].filter(Boolean).join('\n\n');

    const systemPrompt = `你是一个行为模式分析师。从以下 Claude Code 会话对话中，提取用户的行为模式。

## 提取维度

### A. 纠正信号（correction）
用户纠正助手的时刻。识别标志：
- 显式纠正："不对"/"应该是"/"你错了"/"先验证"/"不要删"
- 隐式纠正："我感觉你陷入了误区"/"你扫的是哪个工程"/"按照X来判断有点问题"
- 方案推翻：用户否定助手的方案并给出新方向
- 假设质疑：用户质疑助手的前提假设

**不是纠正的情况（负面示例）**：
- 正常指令："先看看待办"/"写个spec" — 这是任务分配，不是纠正
- 信息补充："对，而且还要..." — 这是补充，不是否定
- 确认："可以"/"没问题" — 这是同意

提取：纠正内容 + 触发场景 + 推断的规则

### B. 决策模式（pattern）
用户的决策链。识别标志：
- "先X再Y" / "先看...再做..."
- 用户引导助手的执行顺序
- 用户在多个选项中的选择逻辑
提取：触发条件 + 步骤序列 + 产出物

### C. 重复操作（automation）
用户反复手动执行的操作。识别标志：
- 多次相同请求
- 每次都要确认/查询的东西
- 可以用脚本/hook 替代的手动步骤
提取：操作内容 + 频率 + 自动化价值

## 输出格式（JSON 数组）

[
  {
    "category": "correction|pattern|automation",
    "title": "简短标题（10字以内）",
    "evidence": "原文引用",
    "pattern": "模式描述",
    "suggestedAction": "create_rule|create_skill|create_automation|skip",
    "confidence": 0.0-1.0
  }
]

## 过滤条件

- 只输出 confidence > ${threshold} 的条目
- 只输出以下未覆盖的条目
- 保持简洁，每个条目不超过 3 行

${existingPatternsBlock}`;

    let parsed: any;
    try {
      parsed = await modelGateway.promptJson(
        content.slice(0, 40_000),
        systemPrompt,
        { provider: 'knowledge', tier: 'standard' },
      );
    } catch (e) {
      logger.warn('[KnowledgeAgent] Behavior extraction failed', { source: source.slice(-40), error: String(e) });
      return;
    }

    const profiles: any[] | undefined = Array.isArray(parsed) ? parsed : parsed?.profiles || parsed?.entries;
    if (!profiles) {
      logger.warn('[KnowledgeAgent] Unexpected behavior extraction format', {
        source: source.slice(-40),
        keys: parsed ? Object.keys(parsed) : [],
      });
      return;
    }

    if (!profiles?.length) {
      logger.info('[KnowledgeAgent] No behavior patterns extracted', { source: source.slice(-40) });
      return;
    }

    // Store profiles with dedup check
    let stored = 0;
    const createdProfiles: Array<{ id: string; category: string; title: string; evidence: string; pattern: string; suggestedAction: string; confidence: number }> = [];
    for (const p of profiles) {
      if (!p.category || !p.title || !p.pattern) continue;
      if (typeof p.confidence === 'number' && p.confidence < threshold) continue;

      // Code-level dedup: title substring match against existing profiles
      const titleNorm = p.title.toLowerCase().trim();
      const alreadyCovered = existingTitles.find(
        t => t.toLowerCase().includes(titleNorm) || titleNorm.includes(t.toLowerCase()),
      );

      const behaviorId = `ubp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const status = alreadyCovered ? 'rejected' : 'pending';
      const confidence = Math.min(1, Math.max(0, p.confidence || 0.5));
      const { sharedStore: behaviorStore } = await import('../knowledge/knowledge-bus.service.js');
      behaviorStore.save({
        id: behaviorId,
        type: 'guideline' as any,
        title: p.title.slice(0, 100),
        content: JSON.stringify({ sessionId, category: p.category, evidence: (p.evidence || '').slice(0, 500), pattern: p.pattern.slice(0, 500), suggestedAction: p.suggestedAction || 'skip', confidence, alreadyCovered, status }),
        maturity: 'active' as any,
        layer: 'project' as any,
        created: new Date().toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: ['knowledge-agent'],
        projects: [],
        tags: ['behavior', status],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
        executionResults: [],
        consumptionMode: 'signal' as any,
        origin: 'agent' as any,
      } as any);
      stored++;
      if (!alreadyCovered) {
        createdProfiles.push({ id: behaviorId, ...p, confidence });
      }
    }

    // Immediate consumption: high-confidence profiles write to correct output paths
    // - create_skill/create_automation → ~/.studio/knowledge/skills/<name>.md (SkillLoader reads)
    // - create_rule → ~/.claude/projects/-root-projects/memory/feedback_<topic>.md (Claude Code reads)
    const CONSUME_THRESHOLD = 0.85;
    let consumed = 0;
    // GAP-8: 写入路径改为 ~/.studio/skills/<name>/SKILL.md
    const SKILLS_DIR = path.join(os.homedir(), '.studio', 'skills');
    const MEMORY_DIR = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');

    // GAP-8: 数据迁移 — 旧路径 ~/.studio/knowledge/skills/ → ~/.studio/skills/
    try {
      const oldSkillsDir = path.join(os.homedir(), '.studio', 'knowledge', 'skills');
      if (fs.existsSync(oldSkillsDir)) {
        const entries = fs.readdirSync(oldSkillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            const name = entry.name.replace(/\.md$/, '');
            const targetDir = path.join(SKILLS_DIR, name);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
              fs.copyFileSync(path.join(oldSkillsDir, entry.name), path.join(targetDir, 'SKILL.md'));
            }
          }
        }
      }
    } catch { /* best-effort migration */ }

    for (const cp of createdProfiles) {
      if (cp.confidence < CONSUME_THRESHOLD || cp.suggestedAction === 'skip') continue;
      try {
        if (cp.suggestedAction === 'create_skill' || cp.suggestedAction === 'create_automation') {
          const skillName = cp.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const skillDir = path.join(SKILLS_DIR, skillName);
          fs.mkdirSync(skillDir, { recursive: true });
          const skillContent = [
            '---',
            `name: ${skillName}`,
            `description: "${cp.pattern.replace(/"/g, '\\"').slice(0, 200)}"`,
            'trigger: always',
            'status: published',
            '---',
            '',
            `## ${cp.title}`,
            '',
            `来源: 用户行为分析 (${cp.category})`,
            `证据: ${cp.evidence}`,
            `置信度: ${Math.round(cp.confidence * 100)}%`,
            '',
            `### 指令`,
            '',
            cp.pattern,
            '',
          ].join('\n');
          fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
        } else if (cp.suggestedAction === 'create_rule') {
          const topic = cp.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          fs.mkdirSync(MEMORY_DIR, { recursive: true });
          const ruleContent = [
            `# ${cp.title}`,
            '',
            `来源: 用户行为分析 (${cp.category})`,
            `证据: ${cp.evidence}`,
            `置信度: ${Math.round(cp.confidence * 100)}%`,
            '',
            `## 模式`,
            '',
            cp.pattern,
            '',
          ].join('\n');
          fs.writeFileSync(path.join(MEMORY_DIR, `feedback_${topic}.md`), ruleContent, 'utf-8');
        }

        try {
          const { sharedStore: applyStore } = await import('../knowledge/knowledge-bus.service.js');
          const entry = applyStore.get(cp.id);
          if (entry) {
            applyStore.save({ ...entry, tags: [...(entry as any).tags.filter((t: string) => t !== 'pending'), 'applied'] } as any);
          }
        } catch { /* non-blocking */ }
        consumed++;
        logger.info('[KnowledgeAgent] Behavior profile consumed immediately', {
          id: cp.id.slice(0, 8),
          category: cp.category,
          action: cp.suggestedAction,
          confidence: cp.confidence,
        });
      } catch (e) {
        logger.warn('[KnowledgeAgent] Immediate consume failed', { id: cp.id.slice(0, 8), error: String(e) });
      }
    }

    logger.info('[KnowledgeAgent] Extracted behavior profiles', {
      source: source.slice(-40),
      total: profiles.length,
      stored,
      consumed,
      skipped: profiles.length - stored,
    });

    // B10-101: ChannelMessage notification for behavior extraction
    if (stored > 0) {
      try {
        const sysChannel = await getOrCreateSystemChannel(fileStore);
        if (sysChannel) {
          const profileSummary = profiles
            .filter((p: any) => p.category && p.title && p.pattern)
            .slice(0, 5)
            .map((p: any) => `- [${p.category}] ${p.title} (置信度: ${Math.round((p.confidence || 0) * 100)}%)`)
            .join('\n');
          const consumeNote = consumed > 0 ? `\n即时消费: ${consumed} 条高置信度模式已写入文件(Skill/memory)` : '';
          await channelMessageService.createAgentMessage(sysChannel.id, 'KK',
            `从会话 ${sessionId.slice(0, 8)} 提取了 ${stored} 条行为模式:\n${profileSummary}${consumeNote}`,
            { meta: { cardType: 'behavior_extracted', sessionId, stored, consumed, total: profiles.length } },
          );
        }
      } catch { /* non-blocking */ }
    }
  } catch (err) {
    logger.warn('[KnowledgeAgent] extractUserBehavior failed', { source: source.slice(-40), error: String(err) });
  }
}
