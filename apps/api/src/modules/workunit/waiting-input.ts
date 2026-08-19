/**
 * F5 双向沟通：blocked WorkUnit 的恢复与超时提醒。
 *
 * - resumeWaitingWorkUnit: 人类在频道线程中回复 → 复活（blocked → active），
 *   回复内容写入 metadata.pendingReplies，由 AgentLoop 下一步注入 prompt。
 *   不依赖已挂载的 AgentLoop —— 无 loop 时同样复活，待 loop 轮询拾取。
 *   #176（决策 #57 D2）：回复即复活扩到所有 blocked 类型（不再限 waitingForInput）；
 *   复活重置 consecutiveStuck/blockReason、记 resumeCount（不限次，观测钩子供 #62），
 *   timeoutReleaseCount 终身保留（不绕过 #63 的 3 次上限）；
 *   回复「关闭」为显式关闭指令（双出声：workunit:closed 事件 + 频道说明，
 *   decision/spec 裁剪状态机无 closed → 拒绝并说明）。
 *   #185（决策 #87 D2）Web 按钮通道：resumeBlockedWorkUnitFromWeb（纯授权 = 占位文案
 *   走同一复活原语 + Studio 里程碑消息补双出声）/ closeBlockedWorkUnitFromWeb（同一
 *   死信关闭路径，三态返回值供路由映射 200/409）。
 * - B3a 工程归属链（决策 D2）：metadata.waitingReason === 'ownership' 的挂起，
 *   回复先按工程名/路径解析（project-discovery 候选）——唯一命中则绑定工程
 *   （metadata.workspaceRoot）并写回 Requirement.projectId 供下次继承，随后置回
 *   unassigned（保留 assigneeId=profile id），由被指名 profile 的 loop 认领执行。
 *   #265（决策 #258）分层匹配命中即停：① name/path 精确等值（大小写不敏感）唯一
 *   → 直接解挂；② 路径尾段边界匹配唯一 → 解挂；③ 落空 → 子串候选列表。
 *   「/」开头的绝对路径回复不走 search，stat + isProject 校验合法即直连绑定。
 *   轮次终止：metadata.ownershipAttempts 记未解轮次（仿 resumeCount 先例），
 *   同一 WU 3 轮未解 → 停止追问、频道播报转人工、WU 保持 blocked（顶栏
 *   NEED_INPUT chip 入口手动绑定；之后未解回复不再发声，有效回复仍可绑定）。
 *   #267（决策 #250 D3）：多候选/无命中的追问消息携带 meta.options 结构化选项卡
 *   （label=工程名、description=path、value=path），前端点选即作为回复发送，
 *   文本列表保留为纯文本通道 fallback。
 * - #162（T8-E1）：metadata.waitingReason === 'wu-token-budget' 的挂起（WU 级 token
 *   预算到线），回复按人三选分流：追加预算（→ active）/ 现有产出收尾（→ in_review）/
 *   放弃（→ closed）；未识别回复继续等待并重述三选。
 * - scanWaitingForInputReminders: SCHEDULE trigger（workunit-input-reminder）的 handler，
 *   #176（决策 #57 D3-2）：覆盖面从 waitingForInput 扩到全部 blocked 类型，
 *   计时基准取 metadata.blockedAt（回退 waitingSince/updatedAt），复用同一 30 分钟
 *   阈值 + 一次性 waitingReminded 标记，消息带统一 CTA（blocked-cta 模板）。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from './workunit.service.js';
import { resolveValidTransitions } from './workunit.types.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { parseWuMetadata } from './wu-metadata.js';
import { withBlockedCta } from './blocked-cta.js';
import { closeWorkUnitWithNotice } from './wu-closure.js';
import { ProjectDiscoveryService, matchProjectByReply, type LocalProject } from '../projects/project-discovery.service.js';
import { RequirementService } from '../requirements/requirement.service.js';
import { projectService } from '../pmo/project.service.js';
import type { MessageMeta } from '../channels/channel-message.service.js';

/** 提醒阈值（毫秒）。默认 30 分钟，可用 STUDIO_INPUT_REMINDER_MINUTES 覆盖 */
export function getReminderThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.STUDIO_INPUT_REMINDER_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

/**
 * 人类回复后复活 blocked 的 WorkUnit（#176 决策 #57 D2：回复即复活扩全 blocked 类型）。
 * 回复「关闭」→ 显式关闭指令（见 closeOnHumanCommand）；其余回复 → 复活：
 * 重置 consecutiveStuck/blockReason、resumeCount 累加（D5 不限次观测钩子）、
 * timeoutReleaseCount 终身保留，回复原文追加进 pendingReplies 注入下一步 prompt。
 * B3a: metadata.waitingReason === 'ownership' 时走工程归属解析（见 resolveOwnershipFromReply）。
 * @returns true = 回复已消费（复活/关闭/拒绝关闭均属已消费）
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

  if (wu.status !== 'blocked') return false;

  // #176（决策 #57 D2）：「关闭」显式关闭指令（优先于归属解析——命令不是工程名）
  if (replyText.trim() === '关闭') {
    const outcome = await closeOnHumanCommand(wu, metadata, fileStore);
    // not-found-or-not-blocked = 指令未被消费（竞态下状态已变，交还后续流程）
    return outcome !== 'not-found-or-not-blocked';
  }

  // B3a 归属链：等待工程归属的挂起 — 回复先解析为工程，唯一命中才复活
  if (metadata.waitingReason === 'ownership') {
    return resolveOwnershipFromReply(wu, metadata, replyText, fileStore);
  }

  // #162（T8-E1）：WU 级 token 预算到线的挂起 — 回复按人三选分流
  // （追加预算 → 回 active / 现有产出收尾 → in_review / 放弃 → closed）
  if (metadata.waitingReason === 'wu-token-budget') {
    return resolveBudgetChoiceFromReply(wu, metadata, replyText, fileStore);
  }

  // #170（决策 #65-1）：锁内合并写——pendingReplies 基于锁内最新值追加
  await fileStore.updateMetadata(workUnitId, latest => ({
    ...latest,
    waitingForInput: false,
    waitingReminded: false, // 重置提醒标记：下次 blocked 重新计一次
    blockReason: undefined, // B4: 人工接管后清除 blocked 原因（JSON 序列化丢弃 undefined）
    consecutiveStuck: 0,    // #176（决策 #57 D2）：复活重置停滞计数（仿 B5 重置 sessionCount 先例）
    resumeCount: (typeof latest.resumeCount === 'number' ? latest.resumeCount : 0) + 1, // D5：观测钩子
    // timeoutReleaseCount 不动 —— 终身保留（#63 的 3 次上限不可被复活绕过）
    // #94: 不再清零 sessionCount —— 复活后下一步凭 metadata.sessionId 优先续用旧会话，
    // 不靠清零预算放行（清零会让失控 WU 无限重开新会话烧 token）
    pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), replyText],
  }));
  await wuService.transitionStatus(workUnitId, 'active');

  logger.info('[WaitingInput] WorkUnit resumed by human reply', { workUnitId });
  return true;
}

/**
 * #162（T8-E1，#130 决策 3）：WU 级 token 预算到线挂起的人三选分流。
 * 追加预算（「追加预算」= 已用量之上再加一份原上限；「追加预算 <数值>」或裸数值 = 改为指定值）
 *   → 清挂起回 active，loop 下轮拾取续跑；
 * 现有产出收尾（「收尾」）→ in_review 交人工审查；
 * 放弃（「放弃」）→ closed 结束任务。
 * 未识别回复 → 继续等待并重述三选（同 ownership 多候选路径的「不乱动」语义）。
 * 频道文案说人话：不出现 WU/metadata/闸/熔断等机制黑话。
 * @returns true = 已按选择解除挂起；false = 继续等待
 */
async function resolveBudgetChoiceFromReply(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  replyText: string,
  fileStore: FileStore,
): Promise<boolean> {
  const wuService = new WorkUnitService(fileStore);
  const text = replyText.trim();
  const used = metadata._cumulativeTokens ?? 0;
  const budget = typeof metadata.tokenBudget === 'number' && Number.isFinite(metadata.tokenBudget)
    ? Math.floor(metadata.tokenBudget) : 0;
  const title = (metadata.title ?? wu.scope).slice(0, 50);

  const clearedMetadata: WorkUnitMetadata = {
    ...metadata,
    waitingForInput: false,
    waitingReminded: false,
    waitingReason: undefined, // JSON 序列化丢弃 undefined → 清除
    blockReason: undefined,
  };
  const notify = async (content: string) => {
    if (wu.channelId) await postWuSystemMessage(wu, content, { fileStore });
  };
  // 状态迁移 best-effort：decision/spec 裁剪状态机无 closed 边（#57 死信豁免），
  // 迁移失败仅记日志不抛给消息路由——挂起标记已清，留人工处置
  const transit = async (status: string) => {
    await wuService.transitionStatus(wu.id, status as Parameters<WorkUnitService['transitionStatus']>[1])
      .catch(err => logger.warn('[WaitingInput] budget-choice transition failed (non-blocking)', {
        workUnitId: wu.id, status, error: String(err),
      }));
  };

  // 放弃 → closed
  if (/放弃|abandon/i.test(text)) {
    await wuService.update(wu.id, { metadata: clearedMetadata });
    await transit('closed');
    await notify(`好的，任务「${title}」已结束`);
    logger.info('[WaitingInput] Budget-tripped WorkUnit abandoned by human', { workUnitId: wu.id });
    return true;
  }

  // 现有产出收尾 → in_review（blocked→in_review 不在状态机表，经 active 中转，同 recordResult C-2 修法）
  if (/收尾|wrap/i.test(text)) {
    await wuService.update(wu.id, { metadata: clearedMetadata });
    await transit('active');
    await transit('in_review');
    await notify(`好的，任务「${title}」已用现有产出提交审查`);
    logger.info('[WaitingInput] Budget-tripped WorkUnit wrapped up by human', { workUnitId: wu.id });
    return true;
  }

  // 追加预算：裸「追加预算/继续」= 已用量 + 一份原上限；「追加预算 <数值>」或裸数值 = 指定新上限
  const budgetIntent = /追加|继续|加预算|continue/i.test(text);
  const bareNumber = text.match(/^[\d,_\s]+$/);
  if (budgetIntent || bareNumber) {
    const numeric = text.replace(/[,_\s]/g, '').match(/\d+/);
    const explicit = numeric ? Number(numeric[0]) : null;
    const newBudget = explicit ?? (used + budget);
    if (!Number.isFinite(newBudget) || newBudget <= used) {
      await notify(`任务「${title}」已消耗 ${used.toLocaleString()} token，新上限需要大于这个数才能继续。请重新回复：「追加预算 <数值>」，或「收尾」/「放弃」`);
      return false;
    }
    await wuService.update(wu.id, { metadata: { ...clearedMetadata, tokenBudget: newBudget } });
    await transit('active');
    await notify(`好的，任务「${title}」的 token 上限已调整为 ${newBudget.toLocaleString()}，继续执行`);
    logger.info('[WaitingInput] Budget-tripped WorkUnit resumed with raised budget', {
      workUnitId: wu.id, newBudget,
    });
    return true;
  }

  // 未识别 → 继续等待，重述三选
  await notify(
    `任务「${title}」已消耗 ${used.toLocaleString()} token，达到上限 ${budget.toLocaleString()}，仍在暂停中。请回复：「追加预算」在上限之上再加 ${budget.toLocaleString()} 继续执行；「追加预算 <数值>」把上限改为指定数值；「收尾」用现有产出提交审查；「放弃」结束任务`,
  );
  logger.info('[WaitingInput] Budget-choice reply unrecognized, still waiting', { workUnitId: wu.id });
  return false;
}

/**
 * #176（决策 #57 D2）：「关闭」指令 —— 显式关闭 blocked WU。
 * 双出声（决策 #62 §3）：workunit:closed 结构化事件 + 频道说明（经 wu-closure 统一出口）。
 * decision/spec 裁剪状态机无 closed（#108：可能等关键人多天）→ 拒绝并频道说明，状态不变。
 * 指令不进入 pendingReplies（不复活、无下一步可注入）。
 * #185（决策 #87 D2）：返回值细化为三态（Web 按钮通道复用同一关闭路径，需区分拒绝原因）；
 * opts.reason 覆盖关闭原因文案（Web 按钮 ≠ 频道回复）。
 */
async function closeOnHumanCommand(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  fileStore: FileStore,
  opts?: { reason?: string },
): Promise<WebCloseOutcome> {
  const title = (metadata.title ?? wu.scope).slice(0, 50);

  if (!(resolveValidTransitions(wu.type, 'blocked') ?? []).includes('closed')) {
    if (wu.channelId) {
      await postWuSystemMessage(
        wu,
        `任务「${title}」是 ${wu.type} 类型（人工验收类，无 closed 状态），不支持「关闭」指令；如需继续请直接回复指导意见。`,
        { fileStore },
      ).catch(err =>
        logger.warn('[WaitingInput] Close-reject notice failed (non-blocking)', { workUnitId: wu.id, error: String(err) })
      );
    }
    logger.info('[WaitingInput] Close command rejected (type has no closed state)', { workUnitId: wu.id, type: wu.type });
    return 'rejected-no-closed-state';
  }

  const snapshot = (await fileStore.getIndex()).find(s => s.id === wu.id);
  if (!snapshot || snapshot.status !== 'blocked') return 'not-found-or-not-blocked';
  const closed = await closeWorkUnitWithNotice(fileStore, snapshot, {
    reason: opts?.reason ?? '人类在线程内回复「关闭」指令，显式关闭',
    closedBy: 'human-command',
    message: `任务「${title}」已按你的要求关闭。如需继续请重新派发。`,
  });
  logger.info('[WaitingInput] WorkUnit closed by human command', { workUnitId: wu.id, closed });
  return 'closed';
}

/** #185（决策 #87 D2）：Web 按钮通道关闭结果三态（路由据此映射 200 / 409） */
export type WebCloseOutcome = 'closed' | 'rejected-no-closed-state' | 'not-found-or-not-blocked';

/** #185（决策 #87 D2）：Web 按钮通道「继续执行」注入 pendingReplies 的固定占位文案（纯授权，无指导内容） */
export const WEB_RESUME_PLACEHOLDER = '（人类在 Web 端授权继续执行）';

/**
 * #185（决策 #87 D1/D2）：Web 按钮通道「继续执行」—— 纯授权复活。
 * 与回复路径共享同一复活原语（占位文案即一条等价人类回复：重置 consecutiveStuck/blockReason、
 * resumeCount 累加、timeoutReleaseCount 终身保留）；复活后补发 Studio 系统消息里程碑
 * （#62 双出声：按钮动作在频道不可见，需系统消息留痕）。复活不确认（非破坏、可再拦截）。
 * 归属等待型（waitingReason='ownership'）按回复语义解析占位文案 → 无工程命中 → false（不复活）。
 */
export async function resumeBlockedWorkUnitFromWeb(
  workUnitId: string,
  fs?: FileStore,
): Promise<boolean> {
  const fileStore = fs ?? new FileStore();
  const resumed = await resumeWaitingWorkUnit(workUnitId, WEB_RESUME_PLACEHOLDER, fileStore);
  if (!resumed) return false;

  const wu = await new WorkUnitService(fileStore).getById(workUnitId);
  if (wu) {
    const metadata = parseWuMetadata(wu.metadata);
    const title = (metadata.title ?? wu.scope).slice(0, 50);
    await postWuSystemMessage(wu, `任务「${title}」已在 Web 端被授权继续执行。`, { milestone: true, fileStore })
      .catch(err =>
        logger.warn('[WaitingInput] Web-resume milestone notice failed (non-blocking)', { workUnitId, error: String(err) })
      );
  }
  logger.info('[WaitingInput] WorkUnit resumed from Web button', { workUnitId });
  return true;
}

/**
 * #185（决策 #87 D2）：Web 按钮通道「关闭任务」—— 复用 #57 D4 死信显式关闭路径
 * （closeOnHumanCommand 同一出口：显式状态迁移 + 频道通知 + 结构化事件，不靠文本魔法串）。
 * decision/spec 无 closed 状态 → rejected-no-closed-state（频道说明已在关闭路径内发出）。
 */
export async function closeBlockedWorkUnitFromWeb(
  workUnitId: string,
  fs?: FileStore,
): Promise<WebCloseOutcome> {
  const fileStore = fs ?? new FileStore();
  const wu = await new WorkUnitService(fileStore).getById(workUnitId);
  if (!wu || wu.status !== 'blocked') return 'not-found-or-not-blocked';
  const metadata = parseWuMetadata(wu.metadata);
  return closeOnHumanCommand(wu, metadata, fileStore, {
    reason: '人类在 Web 端点击「关闭任务」，显式关闭',
  });
}

/**
 * B3a 归属链：把人类回复解析为工程归属（project-discovery 候选）。
 * #265（决策 #258）分层匹配命中即停（matchProjectByReply 纯函数）：
 * ① name/path 精确等值唯一 → 直接解挂；② 路径尾段边界唯一 → 解挂；③ 落空 → 子串候选。
 * 「/」开头的绝对路径回复不走 search，validateProjectPath（stat + isProject）直连绑定。
 * 唯一命中 → 绑定 metadata.workspaceRoot + 置回 unassigned（保留 assigneeId=profile id，
 * 指名 loop 认领后转 active）+ 写回 Requirement.projectId（best-effort）；
 * 多候选/无命中 → 继续等待并向频道列出候选（或提示无匹配）。
 * 轮次终止：metadata.ownershipAttempts 锁内累加（仿 resumeCount 先例），3 轮未解
 * → 停止追问、里程碑播报转人工、WU 保持 blocked；之后未解回复不再发声，
 * 有效回复（精确命中/合法绝对路径）仍可绑定解挂，绑定成功清除计数。
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
  const discovery = new ProjectDiscoveryService();

  // 分层解析：绝对路径直连（绕过 search 歧义）；否则三层匹配命中即停
  let hit: LocalProject | null = null;
  let candidates: LocalProject[] = [];
  if (query.startsWith('/')) {
    hit = await discovery.validateProjectPath(query);
  } else {
    let projects: LocalProject[] = [];
    try {
      projects = await discovery.discover();
    } catch (err) {
      logger.warn('[WaitingInput] Project discovery failed (treated as no match)', {
        workUnitId: wu.id,
        error: String(err),
      });
    }
    const match = matchProjectByReply(query, projects);
    if (match.kind === 'hit') hit = match.project;
    else candidates = match.projects;
  }

  if (hit) {
    // #170（决策 #65-1）：锁内合并写——pendingReplies 基于锁内最新值追加
    await fileStore.updateMetadata(wu.id, latest => ({
      ...latest,
      waitingForInput: false,
      waitingReminded: false,
      workspaceRoot: hit.path,
      ownershipSource: 'human-reply',
      ownershipAttempts: undefined, // #265: 绑定成功清除轮次计数（JSON 序列化丢弃 undefined）
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

  // 未解 → 轮次计数锁内累加（#265 仿 resumeCount 先例）
  let attempts = 0;
  await fileStore.updateMetadata(wu.id, latest => {
    attempts = (typeof latest.ownershipAttempts === 'number' ? latest.ownershipAttempts : 0) + 1;
    return { ...latest, ownershipAttempts: attempts };
  });
  const title = (metadata.title ?? wu.scope).slice(0, 50);

  // #265（决策 #258）：3 轮未解 → 停止追问、播报转人工、WU 保持 blocked
  // （顶栏 NEED_INPUT chip 入口手动绑定）；之后未解回复不再发声，避免无限追问刷屏
  if (attempts >= MAX_OWNERSHIP_ATTEMPTS) {
    if (attempts === MAX_OWNERSHIP_ATTEMPTS && wu.channelId) {
      await postWuSystemMessage(
        wu,
        `任务「${title}」的工程归属已连续 ${MAX_OWNERSHIP_ATTEMPTS} 轮未能确定，停止追问，转人工处理：请在顶栏 NEED_INPUT 入口手动绑定工程，或直接回复合法工程绝对路径。`,
        { milestone: true, fileStore },
      );
    }
    logger.info('[WaitingInput] Ownership unresolved after max attempts, handed off to human', {
      workUnitId: wu.id,
      attempts,
    });
    return false;
  }

  // 多候选 / 无命中 → 继续等待，向频道列出候选让人选
  // #267（决策 #250 D3）：候选同时以 meta.options 结构化选项卡形态发射
  // （文本列表保留为旧前端/纯文本通道的 fallback）
  let content: string;
  let options: MessageMeta['options'];
  if (candidates.length > 1) {
    content = `任务「${title}」匹配到多个工程，请回复其中一个：\n${formatProjectCandidates(candidates)}`;
    options = projectOptions(candidates);
  } else {
    let all: LocalProject[] = [];
    try {
      all = await discovery.search('');
    } catch { /* 列出全部失败按无可选处理 */ }
    if (all.length > 0) {
      content = `任务「${title}」没有找到匹配「${query.slice(0, 50)}」的工程。可选工程：\n${formatProjectCandidates(all)}`;
      options = projectOptions(all);
    } else {
      content = `任务「${title}」没有找到匹配「${query.slice(0, 50)}」的工程，请回复工程名或绝对路径。`;
    }
  }
  if (wu.channelId) {
    await postWuSystemMessage(wu, content, { fileStore, ...(options ? { meta: { options } } : {}) });
  }
  logger.info('[WaitingInput] Ownership reply unresolved, still waiting', {
    workUnitId: wu.id,
    candidateCount: candidates.length,
    attempts,
  });
  return false;
}

/** #265（决策 #258）：归属问答最大追问轮次，到线停止追问转人工（WU 保持 blocked） */
const MAX_OWNERSHIP_ATTEMPTS = 3;

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
 * #267（决策 #250 D3）：候选工程 → 结构化选项卡 options（封顶 10 条，同 formatProjectCandidates 口径）。
 * label=工程名、description=path 副标题消歧；value=path —— 前端点选即把 value 作为回复发送，
 * 走「/」开头绝对路径直连通道绕过歧义（同名候选 label 无法区分，path 唯一精确命中）。
 */
function projectOptions(projects: LocalProject[]): NonNullable<MessageMeta['options']> {
  return projects.slice(0, 10).map(p => ({ label: p.name, description: p.path, value: p.path }));
}

/**
 * 扫描 blocked 超时的 WorkUnit 并向频道发提醒（每次 blocked 仅一条，waitingReminded 一次性标记）。
 * #176（决策 #57 D3-2）：覆盖面从 waitingForInput 扩到全部 blocked 类型；
 * 计时基准取 metadata.blockedAt（回退 waitingSince/updatedAt）——刚 blocked 的老 WU 不被秒提醒；
 * 消息携带统一 CTA（blocked-cta 模板，含失败原因摘要与 24h 死信预告）。
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
    if (metadata.waitingReminded) continue;

    const sinceRaw = metadata.blockedAt ?? metadata.waitingSince ?? wu.updatedAt;
    const since = new Date(sinceRaw);
    if (!Number.isFinite(since.getTime()) || now.getTime() - since.getTime() < thresholdMs) continue;

    const title = (metadata.title ?? wu.scope).slice(0, 50);
    const headline = metadata.waitingForInput
      ? `任务「${title}」正在等待你的回复：${(metadata.waitingQuestion ?? '').slice(0, 100)}`
      : `任务「${title}」已 blocked 超过 ${Math.round(thresholdMs / 60_000)} 分钟，等待人工介入`;

    // 2026-07 PMO-flow UX（§10）：超时提醒按里程碑消息发送（meta 带 pmoId?/atHuman）
    // #176（决策 #57 D3-1）：同口径重发统一 CTA + blockReason 失败原因摘要
    await postWuSystemMessage(
      wu,
      withBlockedCta(headline, metadata.blockReason),
      { milestone: true, fileStore },
    );
    await wuService.update(wu.id, { metadata: { ...metadata, waitingReminded: true } });
    reminded++;
  }

  if (reminded > 0) {
    logger.info(`[WaitingInput] Posted ${reminded} blocked reminder(s)`);
  }
  return reminded;
}
