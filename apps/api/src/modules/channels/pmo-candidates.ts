/**
 * #638：频道 PMO 候选补全派生（`#` 触发自动补全弹框的数据源）。
 *
 * 候选集 = [当前 PMO（含杂务回退，若有）,
 *           ...本频道挂接 REQ 所属 PMO（seq 大→小，按 projectId 去重保留首次，
 *           排除当前 PMO 自身）]，映射补全项最小形状 {id, pmoNumber, title}。
 * pmoNumber 为空的项目无法形成合法 #PMO-n token（requirements/req-binding
 * PMO_TOKEN_RE = /#(PMO?-\d+)/i），一律过滤（当前 PMO 同口径）。
 *
 * B2：current 与候选共享同一次 links 拉取（seq 最大者即 current，与
 * deriveChannelReqPmo 惰性短路同口径），单请求不再跑两遍 listChannelReqPmoProjects；
 * 无挂接时 current 走杂务回退（同 current-pmo 第二级，只查不建）。
 *
 * 各来源独立容错（与 current-pmo「派生绝不抛出」同原则）：
 * REQ 列表读取失败记日志降级——返回已得结果（仅 current 或 []），绝不抛出。
 */
import { logger } from '@dommaker/studio-shared';
// P2-c 拆环：projectService 转闭包内动态 import（channels→pmo 静态边清零）
import type { CurrentPmoDeps, CurrentPmoProject } from './current-pmo.js';
import { listChannelReqPmoProjects } from '../requirements/index.js';

/** `#` 自动补全弹框的候选项形状（前端 channelApi ChannelPmoCandidate 同构） */
export interface ChannelPmoCandidate {
  id: string;
  pmoNumber: string;
  title: string;
}

function toCandidate(project: CurrentPmoProject): ChannelPmoCandidate | null {
  const pmoNumber = project.pmoNumber ?? '';
  if (!pmoNumber) return null; // 无编号项目无法形成合法 token，不献候选
  return { id: project.id, pmoNumber, title: project.title };
}

/** 派生频道 PMO 补全候选；无任何来源返回 []（前端 fail-closed 不出弹框） */
export async function deriveChannelPmoCandidates(
  channelId: string,
  deps: CurrentPmoDeps = {},
): Promise<ChannelPmoCandidate[]> {
  let links: Awaited<ReturnType<typeof listChannelReqPmoProjects<CurrentPmoProject>>> = [];
  try {
    links = await listChannelReqPmoProjects<CurrentPmoProject>(channelId, {
      fileStore: deps.fileStore,
      getProject: deps.getProject,
    });
  } catch (err) {
    logger.warn('[PmoCandidates] REQ-PMO link query failed, degrading to current-only', {
      channelId, error: String(err),
    });
  }
  links.sort((a, b) => b.seq - a.seq);

  // current = seq 最大挂接（与 deriveChannelReqPmo 同口径，复用本次 links 不再重查）；
  // 无挂接（含读取失败降级）→ 杂务 PMO 回退（只查不建，同 current-pmo 第二级容错）
  let current: ChannelPmoCandidate | null = links.length > 0 ? toCandidate(links[0].project) : null;
  if (!current && links.length === 0) {
    const findChoreProject = deps.findChoreProject
      ?? (async (id: string) => (await import('../pmo/index.js')).projectService.findChoreProject(id));
    try {
      const chore = await findChoreProject(channelId);
      current = chore ? toCandidate(chore) : null;
    } catch (err) {
      logger.warn('[PmoCandidates] Chore PMO resolution failed', { channelId, error: String(err) });
    }
  }

  const out: ChannelPmoCandidate[] = [];
  const seen = new Set<string>();
  if (current) {
    out.push(current);
    seen.add(current.id);
  }
  for (const link of links) {
    if (seen.has(link.projectId)) continue;
    const c = toCandidate(link.project);
    if (!c) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}
