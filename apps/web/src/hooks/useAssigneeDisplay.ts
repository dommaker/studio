// 负责人展示解析（#290 清单 #24）——WU 详情页 / WU 抽屉 / REQ 链路节点三处同一口径。
// assigneeId 存的是 RuntimeInstance id，解析顺序：
//   ① 当前运行实例摘要（/monitoring/agents）按 instance id 匹配 → {name, roleId}
//   ② 离线实例：实例档案（/agent-instances/:id）拿 roleId → profile 列表拿名字
//   ③ 都查不到 → null（调用方回退渲染短 UUID）
// 纯展示层解析，不改 assigneeId 存储与 API 形态。
import { useEffect, useState } from 'react';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { channelApi, type AgentProfile } from '../api/channel';

export interface AssigneeDisplay {
  name: string;
  roleId: string;
}

// 在途请求共享：REQ 链路一屏多个负责人节点同时挂载时共用同一次请求，
// 请求落地即清（不缓存结果）——下次挂载拿新数据，避免长期缓存过期
let summaryInflight: Promise<AgentInfo[]> | null = null;
let profilesInflight: Promise<AgentProfile[]> | null = null;

function fetchSummaryAgents(): Promise<AgentInfo[]> {
  if (!summaryInflight) {
    summaryInflight = monitoringApi.getAgentSummary()
      .then(r => r.data.agents, () => [] as AgentInfo[])
      .finally(() => { summaryInflight = null; });
  }
  return summaryInflight;
}

function fetchProfiles(): Promise<AgentProfile[]> {
  if (!profilesInflight) {
    profilesInflight = channelApi.listAllAgents()
      .then(r => r.data?.data ?? [], () => [] as AgentProfile[])
      .finally(() => { profilesInflight = null; });
  }
  return profilesInflight;
}

/** 解析 assigneeId → {name, roleId}；查不到返回 null（导出供单测直接驱动分支） */
export async function resolveAssignee(assigneeId: string): Promise<AssigneeDisplay | null> {
  // ① 运行实例摘要
  const running = (await fetchSummaryAgents()).find(a => a.id === assigneeId);
  if (running) return { name: running.name, roleId: running.roleId };
  // ② 离线实例：档案 roleId → profile 名
  try {
    const inst = await monitoringApi.getAgentInstance(assigneeId);
    const roleId = inst.data?.roleId;
    if (roleId) {
      const profile = (await fetchProfiles()).find(p => p.id === roleId);
      if (profile) return { name: profile.name, roleId };
    }
  } catch { /* 实例不存在/接口失败 → 回退 null */ }
  return null;
}

export function useAssigneeDisplay(assigneeId: string | null | undefined): AssigneeDisplay | null {
  const [display, setDisplay] = useState<AssigneeDisplay | null>(null);
  // 渲染期重置：assigneeId 切换立即清旧值（站内通行的渲染期调整模式）
  const [prevId, setPrevId] = useState(assigneeId);
  if (prevId !== assigneeId) {
    setPrevId(assigneeId);
    setDisplay(null);
  }
  useEffect(() => {
    if (!assigneeId) return;
    let alive = true;
    resolveAssignee(assigneeId).then(d => { if (alive) setDisplay(d); });
    return () => { alive = false; };
  }, [assigneeId]);
  return display;
}
