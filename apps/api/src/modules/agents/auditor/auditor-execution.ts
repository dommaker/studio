/**
 * Auditor Agent — 建议执行 / 升级 / 闭环
 *
 * 从 auditor.service.ts 拆分（审计规则/执行/报告分离，零行为变更）。
 * 本模块负责对审计结果的动作侧：
 *   - 低风险建议自动应用（B3-005）
 *   - 高风险建议推送确认卡片 + 铃铛通知
 *   - RKB: 新 error pattern 自动创建 pending Resolution
 *   - Triage 升级（Phase 3）
 *   - Better-Harness: 失败 → eval case 生成
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { skillStore } from '../../skills/skill-store.js';
import { classifyError } from './auditor-rules.js';
import type { Suggestion } from './auditor-rules.js';

const SYSTEM_CHANNEL_NAME = '#系统';

// ── Apply Low-Risk Suggestions (B3-005) ──

export async function applyLowRiskSuggestions(suggestions: Suggestion[]): Promise<string[]> {
  const applied: string[] = [];

  for (const s of suggestions) {
    try {
      if (s.type === 'skill_weight' && s.skillId) {
        skillStore.update(s.skillId, {
          successRate: s.data?.successRate as number,
        });
        applied.push(`Skill "${s.skillName}" successRate updated`);
        logger.info('[AuditorService] Auto-applied skill_weight', { skillId: s.skillId, skillName: s.skillName });
      } else if (s.type === 'skill_status' && s.skillId) {
        skillStore.update(s.skillId, { status: 'published' });
        applied.push(`Skill "${s.skillName}" auto-published`);
        logger.info('[AuditorService] Auto-applied skill_status', { skillId: s.skillId, skillName: s.skillName });
      } else if (s.type === 'model_weight_tune') {
        // Update user model state: mark concept trend as stable
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const stateFile = path.join(os.homedir(), '.claude', 'user-model-state.json');
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          const concept = s.data?.concept as string;
          if (state.patterns?.[concept]) {
            state.patterns[concept].trend = 'stable';
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
            applied.push(`概念 "${concept}" 趋势已固化为 stable`);
            logger.info('[AuditorService] Auto-applied model_weight_tune', { concept });
          }
        }
      } else if (s.type === 'circuit_fix' && s.risk === 'low') {
        // Low-risk circuit fix: just record that we tried
        applied.push(`电路建议已记录: ${s.detail.slice(0, 80)}`);
        logger.info('[AuditorService] Recorded circuit suggestion', { detail: s.detail });
      }
    } catch (err) {
      logger.warn('[AuditorService] Failed to apply low-risk suggestion', {
        type: s.type,
        skillId: s.skillId,
        error: String(err),
      });
    }
  }

  return applied;
}

// ── Push Confirmation Cards (B3-005) ──

export async function pushConfirmationCards(fileStore: FileStore, suggestions: Suggestion[]): Promise<void> {
  if (suggestions.length === 0) return;

  try {
    const channel = (await fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) {
      return;
    }

    const { channelMessageService } = await import('../../channels/channel-message.service.js');

    // 1. Push cards to #系统 channel
    const content = [
      '## 🔧 审计建议 — 待人工确认',
      '',
      ...suggestions.map((s, i) => {
        const icon = s.type === 'param_tuning' ? '⚙️' : s.type === 'circuit_fix' ? '🔴' : '📝';
        return `${i + 1}. ${icon} **${s.detail}**`;
      }),
      '',
      '请确认是否执行以上建议。',
    ].join('\n');

    await channelMessageService.createCardMessage(
      channel.id,
      'Auditor',
      content,
      'auditor_suggestion',
      { suggestions, status: 'ready' },
    );

    // 2. Push bell notifications to all users
    try {
      const notifService = new NotificationService(fileStore);
      // Read users from FileStore
      const usersDir = path.join(os.homedir(), '.studio', 'data', 'users');
      let userIds: string[] = [];
      try {
        const entries = await fs.promises.readdir(usersDir, { withFileTypes: true });
        const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
        userIds = files.slice(0, 10).map(f => f.name.replace(/\.json$/, ''));
      } catch { /* no users dir */ }
      for (const uid of userIds) {
        await notifService.create({
          userId: uid,
          type: 'auditor_suggestion',
          title: `审计建议 (${suggestions.length} 项)`,
          content: suggestions.map(s => s.detail).join(' | '),
          link: `/channels/${channel.id}`,
        });
      }
      logger.info('[AuditorService] Push notifications sent', { users: userIds.length, suggestions: suggestions.length });
    } catch (notifErr: any) {
      logger.warn('[AuditorService] Bell notification failed (non-blocking)', { error: String(notifErr) });
    }

    logger.info('[AuditorService] Pushed suggestion confirmation cards + notifications', { count: suggestions.length });
  } catch (err) {
    logger.warn('[AuditorService] Failed to push suggestion cards', { error: String(err) });
  }
}

/**
 * RKB: 对未见过的错误 pattern 自动创建 pending Resolution
 *
 * 只对 L3/L4 层的运维配置类错误（permission/config/docker/git）自动创建，
 * 代码类错误（type/lint/test）留给开发者处理。
 */
export async function autoCreateResolutions(
  recentExecs: Array<{ status: string; error: string | null; agentType: string | null }>,
): Promise<void> {
  const opsErrorClasses = new Set(['permission', 'docker', 'git/worktree', 'port_conflict', 'llm/model']);
  try {
    const { resolutionService } = await import('../../knowledge/resolution.service.js');

    for (const e of recentExecs) {
      if (e.status !== 'closed' || !e.error) continue;
      const errorClass = classifyError(e.error as string);
      if (!opsErrorClasses.has(errorClass)) continue;

      // Extract key pattern from error message (first 120 chars, trim noise)
      const pattern = e.error.slice(0, 120).replace(/[\n\r]/g, ' ').trim();
      if (pattern.length < 10) continue;

      // Check if resolution already exists
      const { matched } = await resolutionService.matchResolutions({ errorMessage: pattern, errorClass });
      if (matched) continue; // Already covered

      // Create pending resolution
      await resolutionService.createResolution({
        pattern,
        errorClass,
        layer: errorClass === 'permission' || errorClass === 'port_conflict' ? 'L4_env_config' : 'L3_tool_behavior',
        title: `${errorClass}: ${pattern.slice(0, 60)}`,
        fix: '（待人工补充解法）',
        tags: [errorClass, 'auto-detected'],
      });
    }
  } catch (err) {
    logger.warn('[AuditorService] autoCreateResolutions failed', { error: String(err) });
  }
}

// ── Triage Escalation (Phase 3) ──

export async function escalateToTriage(
  agentTypeStats: Map<string, { total: number; failed: number }>,
  overallSuccessRate: number,
  total: number,
  failed: number,
): Promise<void> {
  // Check per-agent-type: >30% failure rate for any type → agent_type_failure_trend
  for (const [agentType, stats] of agentTypeStats) {
    if (stats.total >= 3) {
      const failureRate = stats.failed / stats.total;
      if (failureRate > 0.3) {
        try {
          const { triageService } = await import('../triage/triage.service.js');
          triageService.handleAlert({
            type: 'agent_type_failure_trend',
            severity: 'critical',
            message: `Agent type "${agentType}" failure rate ${(failureRate * 100).toFixed(0)}% (${stats.failed}/${stats.total})`,
            details: {
              failingAgentType: agentType,
              failureRate: Math.round(failureRate * 100),
              total: stats.total,
              failed: stats.failed,
            },
          }).catch(err => {
            logger.error('[AuditorService] Triage escalation failed (agent_type)', {
              agentType,
              error: String(err),
            });
          });
        } catch (err) {
          logger.warn('[AuditorService] Failed to import triageService for agent_type_failure_trend', { error: String(err) });
        }
      }
    }
  }

  // Overall successRate < 50% → workunit_health_degraded
  if (total >= 5 && overallSuccessRate < 50) {
    try {
      const { triageService } = await import('../triage/triage.service.js');
      triageService.handleAlert({
        type: 'workunit_health_degraded',
        severity: 'critical',
        message: `WorkUnit success rate ${overallSuccessRate}% (${failed}/${total} failed) below 50% threshold`,
        details: {
          overallSuccessRate,
          total,
          failed,
        },
      }).catch(err => {
        logger.error('[AuditorService] Triage escalation failed (workunit_health)', {
          error: String(err),
        });
      });
    } catch (err) {
      logger.warn('[AuditorService] Failed to import triageService for workunit_health_degraded', { error: String(err) });
    }
  }
}

// ── Eval Case Generation (Better-Harness hill-climbing) ──

export async function generateEvalCases(recentExecs: Array<{
  status: string;
  error: string | null;
  agentType: string | null;
  input: any;
  id?: string;
  goalId?: string;
}>): Promise<void> {
  const failures = recentExecs
    .filter(e => e.status === 'closed' && e.error)
    .map(e => ({
      workUnitId: (e as any).goalId || 'unknown',
      executionId: (e as any).id || 'unknown',
      error: e.error!,
      taskDescription: extractTaskDescription(e.input),
      changedFiles: [],
      agentType: e.agentType || undefined,
    }));

  if (failures.length === 0) return;

  try {
    const { evalCaseGenerator } = await import('../../knowledge/eval-case-generator.js');
    await evalCaseGenerator.generateFromFailures(failures);
  } catch (err) {
    logger.warn('[AuditorService] Eval case generation failed', { error: String(err) });
  }
}

function extractTaskDescription(input: any): string | undefined {
  try {
    if (!input) return undefined;
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    return (parsed as any)?.taskDescription || (parsed as any)?.prompt?.substring?.(0, 200);
  } catch {
    return undefined;
  }
}
