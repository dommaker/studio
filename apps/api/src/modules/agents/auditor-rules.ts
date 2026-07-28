/**
 * Auditor Agent — 审计规则（检测 → 建议）
 *
 * 从 auditor.service.ts 拆分（审计规则/执行/报告分离，零行为变更）。
 * 本模块负责纯分析检测逻辑，产出 Suggestion 列表：
 *   - 错误归类（classifyError）
 *   - 技能/agent-type 建议规则（B3-005）
 *   - 用户模型质量分析
 *   - 知识电路健康分析（I2，含 OKR 达成率与 memory 同步检查）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { skillStore } from '../skills/skill-store.js';
import { resolveStudioEventsFile, getStudioEventTime } from '../../utils/studio-events.js';

/** D18 事件入口统一：事件文件 = ~/.studio/logs/studio-events.jsonl（测试期隔离）。保留函数名兼容既有调用方/测试。 */
export function studioEventsJsonl(): string {
  return resolveStudioEventsFile();
}

export interface Suggestion {
  type: 'skill_weight' | 'skill_status' | 'param_tuning' | 'prompt_optimization'
       | 'model_weight_tune' | 'derived_rule_promote' | 'scope_stale_alert' | 'circuit_fix';
  risk: 'low' | 'high';
  skillId?: string;
  skillName?: string;
  agentType?: string;
  detail: string;
  data?: Record<string, unknown>;
}

export function classifyError(errorMsg: string): string {
  const msg = (typeof errorMsg === 'string' ? errorMsg : String(errorMsg)).toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('docker') || msg.includes('container')) return 'docker';
  if (msg.includes('git') || msg.includes('worktree')) return 'git/worktree';
  if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) return 'database';
  if (msg.includes('type') || msg.includes('tsc') || msg.includes('lint')) return 'type/lint';
  if (msg.includes('test')) return 'test_failure';
  if (msg.includes('port') || msg.includes('eaddrinuse')) return 'port_conflict';
  if (msg.includes('permission') || msg.includes('denied')) return 'permission';
  if (msg.includes('model') || msg.includes('token') || msg.includes('llm')) return 'llm/model';
  return 'other';
}

// ── User Model Quality Analysis ──

export async function analyzeUserModel(): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    // Read user model state (written by update-user-model)
    const stateFile = path.join(os.homedir(), '.claude', 'user-model-state.json');
    if (!fs.existsSync(stateFile)) return suggestions;

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    const patterns = state.patterns || {};

    // 1. Semantic cluster stability: clusters with >5 occurrences but still "new" → suggest stabilize
    for (const [concept, p] of Object.entries(patterns) as [string, any][]) {
      if (p.occurrences >= 5 && p.trend === 'rising') {
        suggestions.push({
          type: 'model_weight_tune',
          risk: 'low',
          detail: `概念 "${concept}" 出现 ${p.occurrences} 次，趋势 rising → 建议固化权重`,
          data: { concept, occurrences: p.occurrences, sessions: p.sessions?.length },
        });
      }
      // 2. Falling patterns: was stable, now declining → check if should retire
      if (p.trend === 'falling' && p.occurrences >= 3) {
        suggestions.push({
          type: 'model_weight_tune',
          risk: 'low',
          detail: `概念 "${concept}" 趋势 falling → 建议降权`,
          data: { concept, occurrences: p.occurrences, trend: 'falling' },
        });
      }
    }

    // 3. Lens weight drift: compare current weights vs baseline
    const lensWeights = state.lensWeights || {};
    for (const [lens, weight] of Object.entries(lensWeights) as [string, number][]) {
      if (weight >= 3) {
        suggestions.push({
          type: 'derived_rule_promote',
          risk: 'high',
          detail: `Lens "${lens}" 权重 ${weight} ≥ 3 → 建议升级为硬约束`,
          data: { lens, weight },
        });
      }
    }
  } catch (e: any) {
    logger.warn('[AuditorService] User model analysis failed', { error: String(e) });
  }
  return suggestions;
}

// ── Knowledge Circuit Health (I2) ──

/**
 * 分析知识电路的连通性：
 * - 读/写比例 → 检测"只写不读"的断点
 * - 跨 agent 引用率 → 检测知识孤岛
 * - 总条目数 → 检测冷电路
 */
export async function analyzeCircuitHealth(fileStore: FileStore): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  try {
    const stats = knowledgeService.getStats();
    const total = stats.total || 0;

    // Circuit 1: 冷电路 — 知识总线为空
    if (total === 0) {
      suggestions.push({
        type: 'circuit_fix',
        risk: 'high',
        agentType: 'auditor',
        detail: `知识总线为空 — 管线运行多轮仍未沉淀任何知识。建议：① 确认 Auditor 日审已启用；② 检查 KnowledgeBus.recordPattern() 写入链路；③ 排查 harness trace → knowledge 同步`,
      });
      return suggestions;
    }

    // Circuit 2: 总条目低于阈值
    if (total < 10) {
      suggestions.push({
        type: 'circuit_fix',
        risk: 'high',
        agentType: 'auditor',
        detail: `知识总线仅 ${total} 条记录 — 知识积累速度过低。建议：检查 RKB seed 是否已写入、Monitor/Auditor/Triage 的知识写入回路是否正常`,
      });
    }

    // Circuit 3: 按类型分布 — 检测断点
    const byType = Object.entries(stats).filter(([k]) => k !== 'total');
    const typeSummary = byType.map(([k, v]) => `${k}:${v}`).join(', ');

    // Circuit 4: 无跨 agent 引用 — 知识孤岛
    if (byType.length <= 1 && total > 0) {
      suggestions.push({
        type: 'circuit_fix',
        risk: 'high',
        agentType: 'auditor',
        detail: `知识总线仅有 ${byType.length} 种类型 (${typeSummary}) — 所有知识来自同一个 source，存在知识孤岛风险。跨 agent 知识闭环未形成`,
      });
    }

    // Circuit 5: CONTEXT.md 覆盖率 — 关键目录缺索引则 Analysist 每次都重探索
    try {
      const fs = require('fs');
      const p = require('path');
      const modulesDir = p.join(process.env.REPO_DIR || process.cwd(), 'apps/api/src/modules');
      if (fs.existsSync(modulesDir)) {
        const dirs = fs.readdirSync(modulesDir, { withFileTypes: true })
          .filter((d: any) => d.isDirectory() && d.name !== '__tests__');
        const missing: string[] = [];
        for (const d of dirs) {
          const ctxPath = p.join(modulesDir, d.name, 'CONTEXT.md');
          if (!fs.existsSync(ctxPath)) missing.push(d.name);
        }
        if (missing.length > 0) {
          suggestions.push({
            type: 'circuit_fix',
            risk: 'low',
            agentType: 'auditor',
            detail: `${missing.length} 个模块目录缺 CONTEXT.md: ${missing.join(', ')} — Analyst 每次探索都会重读代码。用 @Analyst 初始化即可。`,
          });
        }
      }
    } catch { /* non-blocking */ }

    // Circuit 7: OKR 达成率 (B8 OKR 驱动闭环)
    try {
      const { okrService } = await import('../pmo/okr.service.js');
      // Read OKR files from ~/.studio/okr/
      const okrDir = path.join(os.homedir(), '.studio', 'okr');
      const okrKeys = await fileStore.listDocs(okrDir);
      const okrs: any[] = [];
      for (const key of okrKeys) {
        const doc = await fileStore.readDoc(okrDir, key);
        if (doc && doc.meta.status === 'active') {
          okrs.push({ id: doc.meta.id, meta: doc.meta, body: doc.body });
        }
      }
      for (const okr of okrs) {
        const krs: any[] = typeof (okr as any).meta.keyResults === 'string' ? JSON.parse((okr as any).meta.keyResults) : ((okr as any).meta.keyResults as any[]) || [];
        for (const kr of krs) {
          if (!kr.metricType || !kr.target || kr.target <= 0) continue;

          const ds = okrService ? 'ok' : 'empty'; // service exists
          if (!ds) continue;

          // Query KR history for trend from ~/.studio/okr/kr-history.jsonl
          let allHistory: any[] = [];
          try {
            const krHistoryPath = path.join(os.homedir(), '.studio', 'okr', 'kr-history.jsonl');
            allHistory = await fileStore.readJsonl<any>(krHistoryPath);
          } catch { /* no history yet */ }
          const history = allHistory
            .filter((h: any) => h.okrId === okr.id && h.krId === kr.id)
            .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, 7);

          const latest = history[0];
          if (!latest) continue;

          if (latest.status === 'no_data') {
            suggestions.push({
              type: 'circuit_fix',
              risk: 'low',
              agentType: 'auditor',
              detail: `OKR "${okr.meta.title}" KR "${kr.title}": 数据暂不可用 (metricType: ${kr.metricType})`,
            });
            continue;
          }

          if (latest.status === 'stale') {
            suggestions.push({
              type: 'circuit_fix',
              risk: 'low',
              agentType: 'auditor',
              detail: `OKR "${okr.meta.title}" KR "${kr.title}": 数据已过期`,
            });
            continue;
          }

          const ratio = latest.value / kr.target;
          const trend = history.length >= 2
            ? (latest.value - history[history.length - 1].value) / history[history.length - 1].value
            : 0;

          if (ratio < 0.6 && trend <= 0) {
            suggestions.push({
              type: 'circuit_fix',
              risk: 'high',
              agentType: 'auditor',
              detail: `OKR "${okr.meta.title}" KR "${kr.title}": 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})，趋势${trend < 0 ? '恶化中' : '未改善'}。建议触发深度根因分析`,
            });

            // 纯代码创建 okr_proposal WorkUnit（不调 LLM）
            // Agent 领取后自行诊断，有完整系统上下文
            const now = new Date().toISOString();
            const wuId = `okr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const metadata = {
              okrId: okr.id,
              krId: kr.id,
              krTitle: kr.title,
              attainment: ratio,
              trend: trend < 0 ? 'down' : 'stable',
              currentValue: latest.value,
              targetValue: kr.target,
              historyCount: history.length,
            };

            // 创建 WorkUnit（通过 fileStore.upsertSnapshot）
            try {
              const snapshot = {
                id: wuId,
                parentId: null,
                type: 'okr_proposal',
                scope: `[OKR优化] ${kr.title}: 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})`,
                assigneeId: null,
                status: 'unassigned' as const,
                failureType: null,
                retryCount: 0,
                timeoutAt: null,
                channelId: null,
                projectPath: null,
                metadata: JSON.stringify(metadata),
                createdAt: now,
                updatedAt: now,
                claimedAt: null,
                completedAt: null,
              };
              await fileStore.upsertSnapshot(snapshot);
            } catch {}
          } else if (ratio < 0.8) {
            suggestions.push({
              type: 'circuit_fix',
              risk: 'low',
              agentType: 'auditor',
              detail: `OKR "${okr.meta.title}" KR "${kr.title}": 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})，低于目标`,
            });
          }

          // 🆕 B8 Phase 1.5: 重校准 — baseline 已超 target 时建议上调
          if (ratio > 1.05) {
            const suggested = Math.ceil(latest.value * 1.02);
            suggestions.push({
              type: 'circuit_fix',
              risk: 'low',
              agentType: 'auditor',
              detail: `OKR "${okr.meta.title}" KR "${kr.title}": 当前实际 ${latest.value}${kr.unit || ''} 已超过目标 ${kr.target}${kr.unit || ''} (${Math.round(ratio * 100)}%)。建议上调 target 至 >= ${suggested}${kr.unit || ''}`,
            });
          }
        }
      }
    // Circuit 8: Memory→KnowledgeStore sync health
    try {
      const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');
      const knowledgeDir = process.env.KNOWLEDGE_BASE_DIR || path.join(os.homedir(), '.studio', 'knowledge');
      if (fs.existsSync(memoryDir) && fs.existsSync(knowledgeDir)) {
        const batchFiles = fs.readdirSync(memoryDir)
          .filter(f => f.startsWith('project_batch_progress_') && f.endsWith('.md'))
          .sort()
          .slice(-3); // last 3 batch progress files

        const knowledgeFiles = new Set(fs.readdirSync(knowledgeDir));
        const missing: string[] = [];
        for (const f of batchFiles) {
          const expected = `process-batch_progress_${f.replace('project_batch_progress_', '').replace('.md', '')}.md`;
          if (!knowledgeFiles.has(expected)) {
            missing.push(f);
          }
        }
        if (missing.length > 0) {
          suggestions.push({
            type: 'circuit_fix',
            risk: 'high',
            agentType: 'auditor',
            detail: `${missing.length} 个 batch progress 文件未同步到 KnowledgeStore: ${missing.join(', ')}。检查 memory 文件的 frontmatter 是否有 maturity 字段 (draft 会被跳过)`,
          });
        }
      }
    } catch { /* non-blocking */ }

    } catch (e) {
      logger.warn('[AuditorService] OKR circuit health check failed', { error: String(e) });
    }

    logger.info('[AuditorService] Circuit health analyzed', { total, typeCount: byType.length, types: typeSummary });
  } catch (e) {
    logger.warn('[AuditorService] Circuit health analysis failed', { error: String(e) });
  }
  return suggestions;
}

// ── Generate Suggestions (B3-005) ──

export async function generateSuggestions(
  fileStore: FileStore,
  agentTypeStats: Map<string, { total: number; failed: number }>,
  errorByAgentType: Map<string, Map<string, number>>,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  try {
    // Skip if insufficient active sessions (4-week window)
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 3600_000);
    // Read studio events from JSONL
    let activeSessionCount = 0;
    try {
      const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
      activeSessionCount = allEvents.filter(
        (e: any) => e.type === 'session:summary' && getStudioEventTime(e) >= fourWeeksAgo.getTime()
      ).length;
    } catch { activeSessionCount = 0; }

    if (activeSessionCount < 5) {
      logger.info('[AuditorService] Skipping skill audit — insufficient active sessions', { activeSessionCount });
    } else {
      // Query skills with sufficient usage for analysis
      const skills = skillStore.list({ usageCount: { gte: 3 } });

      for (const skill of skills) {
        const successPct = Math.round(skill.successRate * 100);

        // skill_underperform: successRate < 50% → suggest optimize prompt
        if (skill.successRate < 0.5 && skill.status === 'published') {
          suggestions.push({
            type: 'skill_weight',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率 ${successPct}% < 50%，建议优化 prompt`,
            data: { successRate: skill.successRate, usageCount: skill.usageCount },
          });
        }

        // skill_auto_publish: successRate >= 80% + draft → auto publish
        if (skill.successRate >= 0.8 && skill.status === 'draft') {
          suggestions.push({
            type: 'skill_status',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率达 ${successPct}%，建议发布`,
            data: { successRate: skill.successRate, currentStatus: skill.status },
          });
        }

        // skill_auto_demote: successRate < 30% + published → demote to draft
        if (skill.successRate < 0.3 && skill.status === 'published') {
          suggestions.push({
            type: 'skill_weight',
            risk: 'high',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率 ${successPct}% < 30%，自动降级为 draft`,
            data: { successRate: skill.successRate, action: 'demote' },
          });
        }

        // skill_retire: deprecated + 0 recent usage → physical delete
        if (skill.status === 'deprecated') {
          let recentUsage = 0;
          try {
            const allEvents = await fileStore.readJsonl<any>(studioEventsJsonl());
            recentUsage = allEvents.filter(
              (e: any) => e.type === 'skill:used'
                && getStudioEventTime(e) >= fourWeeksAgo.getTime()
                && String(e.payload || '').includes(skill.id)
            ).length;
          } catch { recentUsage = 0; }
          if (recentUsage === 0) {
            suggestions.push({
              type: 'skill_status',
              risk: 'high',
              skillId: skill.id,
              skillName: skill.name,
              detail: `Skill "${skill.name}" 已废弃且 4 周内无使用，建议删除`,
              data: { action: 'retire' },
            });
          }
        }
      }

      // skill_inactive: usage rate < 10% in 4-week window
      for (const skill of skills) {
        if (skill.status !== 'published') continue;
        const usageRate = skill.usageCount / activeSessionCount;
        if (usageRate < 0.1) {
          suggestions.push({
            type: 'skill_weight',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 使用率 ${(usageRate * 100).toFixed(0)}% < 10%，建议废弃`,
            data: { usageRate, usageCount: skill.usageCount, activeSessionCount },
          });
        }
      }
    }

    // Detection rule 3: param_tuning — agent-type timeout errors >= 3
    for (const [agentType, errorMap] of errorByAgentType) {
      const timeoutCount = errorMap.get('timeout') || 0;
      const totalErrors = [...errorMap.values()].reduce((a, b) => a + b, 0);
      const stats = agentTypeStats.get(agentType);
      const execTotal = stats?.total || 0;

      if (timeoutCount >= 3 && totalErrors >= 5) {
        suggestions.push({
          type: 'param_tuning',
          risk: 'high',
          agentType,
          detail: `${agentType} 超时错误 ${timeoutCount}/${totalErrors}，建议调整 sessionTimeoutMinutes`,
          data: { agentType, timeoutCount, totalErrors, execTotal },
        });
      }

      // Detection rule 4: prompt_optimization — agent-type failureRate > 0.3 + llm/model dominant
      if (stats && stats.total >= 5) {
        const failureRate = stats.failed / stats.total;
        const llmErrors = errorMap.get('llm/model') || 0;
        if (failureRate > 0.3 && llmErrors >= totalErrors * 0.4) {
          suggestions.push({
            type: 'prompt_optimization',
            risk: 'high',
            agentType,
            detail: `${agentType} 失败率 ${(failureRate * 100).toFixed(0)}%，LLM/模型错误占主导 (${llmErrors}/${totalErrors})，建议优化 prompt`,
            data: { agentType, failureRate: Math.round(failureRate * 100), llmErrors, totalErrors },
          });
        }
      }
    }
  } catch (err) {
    logger.warn('[AuditorService] Failed to generate suggestions', { error: String(err) });
  }

  return suggestions;
}
