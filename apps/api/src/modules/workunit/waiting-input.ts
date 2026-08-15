/**
 * F5 双向沟通：NEED_INPUT 挂起（waiting）WorkUnit 的恢复与超时提醒。
 *
 * - resumeWaitingWorkUnit: 人类在频道线程中回复 → 解除挂起（blocked → active），
 *   回复内容写入 metadata.pendingReplies，由 AgentLoop 下一步注入 prompt。
 *   不依赖已挂载的 AgentLoop —— 无 loop 时同样解除挂起，待 loop 轮询拾取。
 * - B3a 工程归属链（决策 D2）：metadata.waitingReason === 'ownership' 的挂起，
 *   回复先按工程名/路径解析（project-discovery 候选）——唯一命中则绑定工程
 *   （metadata.workspaceRoot）并写回 Requirement.projectId 供下次继承，随后置回
 *   unassigned（保留 assigneeId=profile id），由被指名 profile 的 loop 认领执行；
 *   多候选/无命中则继续等待并向频道列出候选。
 * - scanWaitingForInputReminders: SCHEDULE trigger（workunit-input-reminder）的 handler，
 *   对挂起超过阈值的 WorkUnit 向频道发一次提醒（每次挂起只提醒一次，恢复时重置）。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from './workunit.service.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { parseWuMetadata } from './wu-metadata.js';
import { ProjectDiscoveryService, type LocalProject } from '../projects/project-discovery.service.js';
import { RequirementService } from '../requirements/requirement.service.js';
import { projectService } from '../pmo/project.service.js';

/** 提醒阈值（毫秒）。默认 30 分钟，可用 STUDIO_INPUT_REMINDER_MINUTES 覆盖 */
export function getReminderThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.STUDIO_INPUT_REMINDER_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

/**
 * 人类回复后恢复挂起的 WorkUnit。
 * 仅当 WorkUnit 处于 blocked 且 metadata.waitingForInput 时生效（区分卡住型 blocked）。
 * 多条回复在恢复前追加拼接（pendingReplies 数组）。
 * B3a: metadata.waitingReason === 'ownership' 时走工程归属解析（见 resolveOwnershipFromReply）。
 * @returns true = 已解除挂起
 */
export async function resumeWaitingWorkUnit(
  workUnitId: string,
  replyText: string,
  fs?: FileStore,
): Promise<boolean> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const wu = await wuService.getById(workUnitId);
  if (!wu) return false;

  const metadata = parseWuMetadata(wu.metadata);

  // 已恢复但 loop 尚未消费 pendingReplies 的窗口内，后续回复直接追加拼接
  if (wu.status === 'active' && Array.isArray(metadata.pendingReplies) && metadata.pendingReplies.length > 0) {
    // #170（决策 #65-1）：锁内合并写追加——并发回复之间、回复与 recordResult 簿记之间互不冲掉
    await fileStore.updateMetadata(workUnitId, latest => ({
      ...latest,
      pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), replyText],
    }));
    return true;
  }

  if (wu.status !== 'blocked' || !metadata.waitingForInput) return false;

  // B3a 归属链：等待工程归属的挂起 — 回复先解析为工程，唯一命中才复活
  if (metadata.waitingReason === 'ownership') {
    return resolveOwnershipFromReply(wu, metadata, replyText, fileStore);
  }

  // #170（决策 #65-1）：锁内合并写——pendingReplies 基于锁内最新值追加
  await fileStore.updateMetadata(workUnitId, latest => ({
    ...latest,
    waitingForInput: false,
    waitingReminded: false, // 重置提醒标记：下次挂起重新计一次
    blockReason: undefined, // B4: 人工接管后清除 blocked 原因（JSON 序列化丢弃 undefined）
    // #94: 不再清零 sessionCount —— 复活后下一步凭 metadata.sessionId 优先续用旧会话，
    // 不靠清零预算放行（清零会让失控 WU 无限重开新会话烧 token）
    pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), replyText],
  }));
  await wuService.transitionStatus(workUnitId, 'active');

  logger.info('[WaitingInput] WorkUnit resumed by human reply', { workUnitId });
  return true;
}

/**
 * B3a 归属链：把人类回复解析为工程归属（project-discovery 候选）。
 * 唯一命中 → 绑定 metadata.workspaceRoot + 置回 unassigned（保留 assigneeId=profile id，
 * 指名 loop 认领后转 active）+ 写回 Requirement.projectId（best-effort）；
 * 多候选/无命中 → 继续等待并向频道列出候选（或提示无匹配）。
 * pendingReplies 保留归属回复原文：首次 agentStep 经 buildReplyPrompt 注入
 * （prompt 本身含 scope，注入后即清除），不会跨步骤重复注入。
 * @returns true = 已绑定并解除挂起；false = 继续等待
 */
async function resolveOwnershipFromReply(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  replyText: string,
  fileStore: FileStore,
): Promise<boolean> {
  const wuService = new WorkUnitService(fileStore);
  const query = replyText.trim();

  let candidates: LocalProject[] = [];
  try {
    candidates = await new ProjectDiscoveryService().search(query);
  } catch (err) {
    logger.warn('[WaitingInput] Project discovery search failed (treated as no match)', {
      workUnitId: wu.id,
      error: String(err),
    });
  }

  if (candidates.length === 1) {
    const hit = candidates[0];
    // #170（决策 #65-1）：锁内合并写——pendingReplies 基于锁内最新值追加
    await fileStore.updateMetadata(wu.id, latest => ({
      ...latest,
      waitingForInput: false,
      waitingReminded: false,
      workspaceRoot: hit.path,
      ownershipSource: 'human-reply',
      pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), replyText],
    }));
    // 置回 unassigned 而非 active：此 WU 创建即挂起、从未被认领，assigneeId 仍是
    // mention 路由写入的 profile id。置 active 会让它对所有人不可见——loop 续跑
    // 查询按 instance.id 过滤（myActive），认领过滤又要求 status==='unassigned'，
    // 结果永久卡死。回 unassigned 保留 mention 点名语义：该 profile 的 loop 在
    // unassigned 过滤里看到并认领（claim 会把 assigneeId 改写为 instance.id）。
    await wuService.transitionStatus(wu.id, 'unassigned');
    // 写回 Requirement.projectId（best-effort）：同需求下次派发直接继承工程
    if (wu.reqId) {
      await bindRequirementToProject(wu.reqId, hit, fileStore).catch(err =>
        logger.warn('[WaitingInput] Bind requirement project failed (non-blocking)', {
          reqId: wu.reqId,
          error: String(err),
        })
      );
    }
    logger.info('[WaitingInput] Ownership bound from human reply', { workUnitId: wu.id, workspaceRoot: hit.path });
    return true;
  }

  // 多候选 / 无命中 → 继续等待，向频道列出候选让人选
  const title = (metadata.title ?? wu.scope).slice(0, 50);
  let content: string;
  if (candidates.length > 1) {
    content = `任务「${title}」匹配到多个工程，请回复其中一个：\n${formatProjectCandidates(candidates)}`;
  } else {
    let all: LocalProject[] = [];
    try {
      all = await new ProjectDiscoveryService().search('');
    } catch { /* 列出全部失败按无可选处理 */ }
    content = all.length > 0
      ? `任务「${title}」没有找到匹配「${query.slice(0, 50)}」的工程。可选工程：\n${formatProjectCandidates(all)}`
      : `任务「${title}」没有找到匹配「${query.slice(0, 50)}」的工程，请回复工程名或绝对路径。`;
  }
  if (wu.channelId) {
    await postWuSystemMessage(wu, content, { fileStore });
  }
  logger.info('[WaitingInput] Ownership reply unresolved, still waiting', {
    workUnitId: wu.id,
    candidateCount: candidates.length,
  });
  return false;
}

/**
 * B3a 归属链：把人工选定的工程写回 Requirement.projectId 供下次继承。
 * 优先复用 gitRepo 锚定同一路径的既有 PMO 项目；没有则以发现结果新建
 * （新建项目即归属链的工程锚点）。已有 projectId 的需求不覆盖。
 * 决策 2/4：别名视图（杂务/统一编号 PMO）已自带 projectId —— 若其 PMO 缺 gitRepo，
 * 把人工答案写回 PMO.gitRepo（PMO = 归属的唯一回答点，一次绑定终身有效）。
 */
async function bindRequirementToProject(reqId: string, hit: LocalProject, fileStore: FileStore): Promise<void> {
  const reqService = new RequirementService(fileStore);
  const requirement = await reqService.get(reqId);
  if (!requirement) return;

  if (requirement.projectId) {
    // 别名/已挂接：PMO 缺 gitRepo 才补写（不覆盖既有锚点）
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
    reqId,
    projectId: project.id,
    gitRepo: hit.path,
  });
}

/** 候选工程列表文案（封顶 10 条） */
function formatProjectCandidates(projects: LocalProject[]): string {
  return projects
    .slice(0, 10)
    .map(p => `- ${p.name}（${p.path}）`)
    .join('\n');
}

/**
 * 扫描挂起超时的 WorkUnit 并向频道发提醒（每次挂起仅一条）。
 * @returns 本次发送的提醒数
 */
export async function scanWaitingForInputReminders(fs?: FileStore, now: Date = new Date()): Promise<number> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const thresholdMs = getReminderThresholdMs();

  const blocked = await wuService.list({ status: 'blocked', limit: 1000 });
  let reminded = 0;

  for (const wu of blocked.data) {
    if (!wu.channelId) continue;
    const metadata = parseWuMetadata(wu.metadata);
    if (!metadata.waitingForInput || metadata.waitingReminded) continue;

    const since = metadata.waitingSince ? new Date(metadata.waitingSince) : wu.updatedAt;
    if (now.getTime() - since.getTime() < thresholdMs) continue;

    const title = (metadata.title ?? wu.scope).slice(0, 50);
    const question = (metadata.waitingQuestion ?? '').slice(0, 100);

    // 2026-07 PMO-flow UX（§10）：挂起超时提醒按里程碑消息发送（meta 带 pmoId?/atHuman）
    await postWuSystemMessage(
      wu,
      `任务「${title}」正在等待你的回复：${question}`,
      { milestone: true, fileStore },
    );
    await wuService.update(wu.id, { metadata: { ...metadata, waitingReminded: true } });
    reminded++;
  }

  if (reminded > 0) {
    logger.info(`[WaitingInput] Posted ${reminded} waiting-for-input reminder(s)`);
  }
  return reminded;
}
