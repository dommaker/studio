/** PMO 发布用例：频道消息 + plan WorkUnit + 项目激活的唯一编排入口。 */
import { PLAN_TASK_CONTRACT, type MandatePrincipal } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { getChannelMessageService, resolveOrNotice } from '../channels/index.js';
import { WorkUnitService } from '../workunit/index.js';
import { getStore } from '../../core/store.js';
import { resolveDeliveries } from './model.js';
import { projectRepository } from './project-repository.js';

export const PLAN_TOKEN_BUDGET_DEFAULT = 1_000_000;

export function resolvePlanTokenBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STUDIO_PLAN_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PLAN_TOKEN_BUDGET_DEFAULT;
}

export async function publishProject(input: { projectId: string; channelId: string; assigneeId?: string; requestedBy?: MandatePrincipal }) {
  const project = await projectRepository.get(input.projectId);
  if (!project) throw new Error('Project not found');
  if (project.status !== 'pending') throw new Error('Project must be pending to publish');

  // 新项目正文落 description；存量 requirement 有值时保持原口径。
  const requirementText = project.requirement || project.description || '';
  const content = `📋 ${project.pmoNumber}: ${project.title}\n\n${requirementText}`;
  const message = await getChannelMessageService().createHumanMessage(input.channelId, content);
  await getChannelMessageService().updateMessageMeta(message.id, { pmoId: project.id }, input.channelId);

  const workUnitService = new WorkUnitService();
  // LEG 是确认任务的唯一腿归属键；单腿也显式列出，禁止派生时回退首仓。
  const legs = resolveDeliveries(project);
  const deliveryLegSection = `\n\n## 交付腿（腿调研只读范围）\n本需求在 ${legs.length} 条交付腿交付，规划须覆盖以下全部仓库及 delivery branch；逐腿调研一律只读（不做 worktree 隔离），需要深挖时按腿派 DELEGATE research 子单（子单 scope 带腿仓库路径）：\n`
    + legs.map(leg => `- LEG: ${leg.gitRepo ?? '（未设置仓库路径）'} | DELIVERY BRANCH: ${leg.branch ?? '（未设置交付分支）'}`).join('\n');
  const planRouting = input.assigneeId
    ? null
    : await resolveOrNotice(getStore(), input.channelId, 'plan');
  const workUnit = await workUnitService.create({
    type: 'plan',
    ...(input.assigneeId
      ? { assigneeId: input.assigneeId }
      : planRouting?.resolution.profileId ? { assigneeId: planRouting.resolution.profileId } : {}),
    scope: `规划需求 ${project.pmoNumber}: ${project.title} +requirement-clarify +to-tickets

${requirementText}
${deliveryLegSection}
## 工作方式（一脉会话，对齐 requirement-clarify skill）
本单是「需求 → 任务清单」的完整规划链，在同一个会话里一脉完成，不分阶段换角色：
1. 澄清：向人追问澄清（频道 waiting-input 复活本会话，上下文不丢）；
2. fog 调研：探路型需求的待决问题逐题调研；需要仓外调研时用 DELEGATE 派 research 子单（父会话保上下文，子单只读调研返回结论）；
3. 裁决轮：不能默认的待决问题打包一轮（问题清单 + 每题建议结论 + 默认值），请人一次性裁决；
4. spec 成文：裁决后 spec 落业务仓 .studio/specs/（本阶段允许写 spec/文档，实现代码不在本单范围）；
5. 拆任务清单：输出 TASK: 拆分行，人工确认后系统按清单自动建任务并派工。

会话中断恢复：探路台账（目的地 + 待决问题 + 已裁决结论）在你的 prompt「探路地图」段，以台账为准续跑，不整单重来。

## 输出约定（规划接力）

规划完成后，除 ACTION 行外，逐行输出拆分后的实现任务（每条一行，3~8 条，每条可被独立认领）：
${PLAN_TASK_CONTRACT}
需求很小无需拆分时可不输出 TASK 行。结论由人工确认后，系统按 TASK 行自动建任务并派工。

如规划中发现必须人工拍板才能推进的待决问题（探路型需求），另逐行输出（每条一行，至多 12 条）：
FOG: <待决问题>
可选输出一行 DESTINATION: <一句话目标> 指定探路目的地（缺省用项目标题）。
人工确认时会审核这份待决问题清单（可增删改），确认通过后系统据此初始化探路台账（不再逐条建决策单——裁决在本会话内进行）；无 FOG 行 = 非探路型，只按 TASK 行派工。`,
    channelId: input.channelId,
    reqId: project.reqAlias ?? null,
    authorization: {
      requestedBy: input.requestedBy ?? { id: 'system', type: 'System' },
      source: { kind: 'channel', channelId: input.channelId, messageId: message.id },
      // plan 跨全部仓库调研，没有单一执行腿；派生实现 WU 再收紧到各自具体腿。
      repositories: legs.flatMap(leg => leg.gitRepo ? [{ repo: leg.gitRepo, leg: null }] : []),
    },
    metadata: {
      pmoId: project.id,
      pmoNumber: project.pmoNumber,
      anchorMessageId: message.id,
      tokenBudget: resolvePlanTokenBudget(),
      ...(project.gitRepo ? { workspaceRoot: project.gitRepo } : {}),
    },
  });
  // #700：原 PMO 消息是 plan 的持久线程锚点；回复它即可继承并恢复原 plan WU。
  const linkedMessage = await getChannelMessageService().linkWorkUnit(message.id, workUnit.id, input.channelId);

  if (planRouting?.notice) {
    await getChannelMessageService().createAgentMessage(
      input.channelId,
      'Studio',
      planRouting.notice,
      { workUnitId: workUnit.id },
    ).catch(err => logger.warn({ error: String(err) }, '[PMO] routing fallback notice failed (non-blocking)'));
  }

  const updatedProject = await projectRepository.updateStatus(
    input.projectId,
    'active',
    false,
    { channelId: input.channelId },
  );
  return { message: linkedMessage, workUnit, project: updatedProject };
}
