/** ARCH-02 WorkUnit 端口生产装配；bootstrap 与行为测试共用同一组合步骤。 */
import { recordAgentDecision } from '../modules/audit-logs/index.js';
import { ChannelMessageService, resolveOrNotice } from '../modules/channels/index.js';
import { registerWorkUnitPorts } from '../modules/workunit/index.js';
import { RequirementService, resolvePmoProjectIdForWU } from '../modules/requirements/index.js';
import {
  applyPlanDirection,
  applyPlanRuling,
  PlanDirectionError,
  PlanRulingError,
  projectService,
  selectProjectSnapshots,
  validateDirectionPick,
  validateRulingItems,
} from '../modules/pmo/index.js';
import { getReviewDispatcher } from '../modules/agent-loop/index.js';
import { aggregateTreeTokens, getSystemExecutor } from '../modules/agents/index.js';
import { dispatchMonitorAlerts } from '../modules/ops/index.js';
import { CODE_WORKTREE_TYPES, resolveVerifyCommands, runWuVerification } from '../core/wu-verification.js';
import type { FileStore } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared/node';

function channelMessages(fileStore: FileStore): ChannelMessageService {
  return new ChannelMessageService(fileStore);
}

/** 工程归属写回适配器：业务实现仍归 Requirements/PMO，WorkUnit 不见其模块图。 */
async function bindRequirementToProject(reqId: string, hit: { name: string; path: string }, fileStore: FileStore): Promise<void> {
  const reqService = new RequirementService(fileStore);
  const requirement = await reqService.get(reqId);
  if (!requirement) return;

  if (requirement.projectId) {
    const backing = await projectService.get(requirement.projectId);
    if (backing && !backing.gitRepo) {
      await projectService.update(backing.id, { gitRepo: hit.path });
      logger.info('[WaitingInput] PMO gitRepo bound from human reply', {
        reqId, projectId: backing.id, gitRepo: hit.path,
      });
    }
    return;
  }

  const existing = (await projectService.list({ limit: 1000 })).find(p => p.gitRepo === hit.path);
  const project = existing ?? (await projectService.create({ title: hit.name, gitRepo: hit.path }));
  await reqService.update(reqId, { projectId: project.id });
  logger.info('[WaitingInput] Requirement bound to PMO project', {
    reqId, projectId: project.id, gitRepo: hit.path,
  });
}

export function registerWorkUnitSinks(): void {
  registerWorkUnitPorts({
    message: {
      createAgentMessage: input => channelMessages(input.fileStore).createAgentMessage(
        input.channelId, input.agentName, input.content,
        { replyToId: input.replyToId, meta: input.meta, workUnitId: input.workUnitId },
      ),
      createHumanMessage: input => channelMessages(input.fileStore).createHumanMessage(
        input.channelId, input.content, input.replyToId, input.workUnitId,
      ),
      updateMessage: input => channelMessages(input.fileStore).updateMessage(
        input.messageId, { content: input.content, meta: input.meta }, input.channelId,
      ),
      listByWorkUnitId: input => channelMessages(input.fileStore).listByWorkUnitId(
        input.workUnitId,
        { channelId: input.channelId, before: input.before, limit: input.limit },
      ),
      linkWorkUnit: input => channelMessages(input.fileStore).linkWorkUnit(
        input.messageId, input.workUnitId, input.channelId,
      ),
      resolveRouting: input => resolveOrNotice(input.fileStore, input.channelId, input.stage, {
        notConfiguredText: input.notConfiguredText,
      }),
    },
    audit: recordAgentDecision,
    projectRead: {
      resolvePmoId: resolvePmoProjectIdForWU,
      selectProjectSnapshots: async (projectId, fileStore, snapshots) => {
        const requirements = await new RequirementService(fileStore).list();
        return selectProjectSnapshots(projectId, requirements, snapshots);
      },
      bindRequirementToProject,
    },
    verification: {
      isCodeWorktreeType: type => CODE_WORKTREE_TYPES.has(type),
      resolveCommands: resolveVerifyCommands,
      run: runWuVerification,
    },
    review: {
      dispatchReviewNow: id => getReviewDispatcher().dispatchReviewNow(id),
      validateRulingItems,
      applyPlanRuling,
      isPlanRulingError: error => error instanceof PlanRulingError,
      validateDirectionPick,
      applyPlanDirection,
      isPlanDirectionError: error => error instanceof PlanDirectionError,
    },
    execution: {
      run: (prompt, options) => getSystemExecutor().run(prompt, options),
    },
    read: { aggregateTreeTokens },
    alert: { dispatch: dispatchMonitorAlerts },
  });
}
