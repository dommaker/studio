// WU → PMO 项目解析共享正本（2026-08 归因统一；自 WorkUnitDetailPage.resolvePmo 提取，#630 删除确认框复用）：
// ① 创建期归因戳 metadata.pmoId（‖ deprecated legacy ownershipProjectId 同级）直查；
// ② 否则 reqId → requirement.projectId（REQ 别名视图 projectId = PMO 自身 id）。
// 全部 best-effort：解析不到 → null（调用方按「未归属」降级展示），不阻断主流程。
import { projectApi } from '../api/index';
import { requirementApi } from '../api/requirements';
import type { WorkUnit } from '../api/workunit';
import { parseWuMeta } from './wuMeta';

export interface WuPmoInfo {
  id: string;
  pmoNumber: string;
  title: string;
}

/** 单 WU 归属解析（等价 WorkUnitDetailPage 原 resolvePmo） */
export async function resolveWuPmo(wu: WorkUnit): Promise<WuPmoInfo | null> {
  const meta = parseWuMeta(wu.metadata);
  const stamp = meta.pmoId ?? meta.ownershipProjectId;
  let projectId = typeof stamp === 'string' && stamp ? stamp : null;
  if (!projectId && wu.reqId) {
    try {
      const reqRes = await requirementApi.get(wu.reqId);
      projectId = reqRes.data.data.projectId ?? null;
    } catch { return null; }
  }
  if (!projectId) return null;
  try {
    const res = await projectApi.get(projectId);
    const p = res.data as { id?: unknown; pmoNumber?: unknown; title?: unknown };
    if (typeof p.id !== 'string' || typeof p.pmoNumber !== 'string') return null;
    return { id: p.id, pmoNumber: p.pmoNumber, title: typeof p.title === 'string' ? p.title : '' };
  } catch { return null; }
}

/** 批量归属解析（#630 删除确认框在途清单）：reqId/projectId 按 promise 去重，避免逐 WU N+1 */
export async function resolveWuPmoBatch(wus: WorkUnit[]): Promise<Map<string, WuPmoInfo | null>> {
  const reqCache = new Map<string, Promise<string | null>>();
  const projCache = new Map<string, Promise<WuPmoInfo | null>>();

  const projectOf = (projectId: string): Promise<WuPmoInfo | null> => {
    let p = projCache.get(projectId);
    if (!p) {
      p = projectApi.get(projectId)
        .then((res) => {
          const d = res.data as { id?: unknown; pmoNumber?: unknown; title?: unknown };
          if (typeof d.id !== 'string' || typeof d.pmoNumber !== 'string') return null;
          return { id: d.id, pmoNumber: d.pmoNumber, title: typeof d.title === 'string' ? d.title : '' };
        })
        .catch(() => null);
      projCache.set(projectId, p);
    }
    return p;
  };

  const projectIdOfReq = (reqId: string): Promise<string | null> => {
    let p = reqCache.get(reqId);
    if (!p) {
      p = requirementApi.get(reqId)
        .then((res) => res.data.data.projectId ?? null)
        .catch(() => null);
      reqCache.set(reqId, p);
    }
    return p;
  };

  const out = new Map<string, WuPmoInfo | null>();
  await Promise.all(wus.map(async (wu) => {
    const meta = parseWuMeta(wu.metadata);
    const stamp = meta.pmoId ?? meta.ownershipProjectId;
    let projectId = typeof stamp === 'string' && stamp ? stamp : null;
    if (!projectId && wu.reqId) projectId = await projectIdOfReq(wu.reqId);
    out.set(wu.id, projectId ? await projectOf(projectId) : null);
  }));
  return out;
}
