/**
 * #638：频道 PMO 候选补全派生（`#` 触发自动补全弹框的数据源）。
 *
 * 候选集 = [当前 PMO（deriveChannelCurrentPmo，含杂务回退，若有）,
 *           ...本频道挂接 REQ 所属 PMO（seq 大→小，按 projectId 去重保留首次，
 *           排除当前 PMO 自身）]，映射补全项最小形状 {id, pmoNumber, title}。
 * pmoNumber 为空的项目无法形成合法 #PMO-n token（requirements/req-binding
 * PMO_TOKEN_RE = /#(PMO?-\d+)/i），一律过滤（当前 PMO 同口径）。
 *
 * 各来源独立容错（与 current-pmo「派生绝不抛出」同原则）：
 * REQ 列表读取失败记日志降级——返回已得结果（仅 current 或 []），绝不抛出。
 */
import { logger } from '@dommaker/studio-shared';
import { deriveChannelCurrentPmo, type CurrentPmoDeps, type CurrentPmoProject } from './current-pmo.js';
import { listChannelReqPmoProjects } from '../requirements/channel-req-pmo.js';

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
  const current = await deriveChannelCurrentPmo(channelId, deps);

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

  const out: ChannelPmoCandidate[] = [];
  const seen = new Set<string>();
  if (current) {
    const c = toCandidate({ id: current.id, pmoNumber: current.pmoNumber, title: current.title });
    if (c) {
      out.push(c);
      seen.add(c.id);
    }
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
