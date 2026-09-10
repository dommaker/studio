// Trigger 指名执行者可运行性自检（2026-09-10，doc-semantic-review 滞留 143h 事故根治）
//
// 背景：CREATE 类 trigger 的 assigneeRole 指名语义 = 独占认领（仅该角色 loop 可见，
// agent-loop.ts Assignee-aware claiming）。若角色不存在或 loop 未在跑，建出的 WU
// 结构性死单——历史上指名 studio（署名身份，AC-1.3 旧设计不挂 loop）导致滞留 143h，
// 仅靠 Monitor pool_stagnation 小时级告警事后发现。本自检把发现时点提前到启动。
import type { FileStore } from '@dommaker/studio-shared';
import type { TriggerConfig } from './trigger.types.js';

/** loop 运行状态查询的最小切面（AgentLoopRegistry.get 兼容） */
export type LoopEntryLookup = (profileId: string) => { status: 'running' | 'failed' | 'skipped' } | undefined;

export interface TriggerAssigneeProblem {
  triggerId: string;
  assigneeRole: string;
  reason: string;
}

/**
 * 检查 CREATE 类 trigger 的 assigneeRole 是否解析到「存在且 loop running」的角色。
 * 返回问题清单（空 = 全绿）；报警通道由调用方决定（index.ts 启动时 logger.error）。
 * 非 CREATE / 未指名的 trigger 不参与（未指名走频道竞争认领，无单点依赖）。
 */
export async function checkTriggerAssignees(
  triggers: TriggerConfig[],
  deps: { fileStore: FileStore; getLoopEntry: LoopEntryLookup },
): Promise<TriggerAssigneeProblem[]> {
  const problems: TriggerAssigneeProblem[] = [];
  const named = triggers.filter(
    t => t.action.type === 'CREATE' && typeof t.action.payload.assigneeRole === 'string' && t.action.payload.assigneeRole,
  );
  if (named.length === 0) return problems;

  const profiles = await deps.fileStore.listProfiles();
  for (const t of named) {
    const roleName = (t.action as Extract<TriggerConfig['action'], { type: 'CREATE' }>).payload.assigneeRole!;
    const profile = profiles.find(p => p.name === roleName);
    if (!profile) {
      problems.push({ triggerId: t.id, assigneeRole: roleName, reason: `role "${roleName}" not found（创建时回退 unassigned，指名意图丢失）` });
      continue;
    }
    const entry = deps.getLoopEntry(profile.id);
    if (!entry) {
      problems.push({ triggerId: t.id, assigneeRole: roleName, reason: `role "${roleName}" has no mounted loop（指名 WU 仅该角色 loop 可见，无人能领）` });
      continue;
    }
    if (entry.status !== 'running') {
      problems.push({ triggerId: t.id, assigneeRole: roleName, reason: `role "${roleName}" loop status=${entry.status}（非 running，指名 WU 无人能领）` });
    }
  }
  return problems;
}
