// AnalysisApproveDialog — #463 起重写为结构化评审表单（原 #106 M7 魔法行 textarea 退役）。
// 数据源 = agent COMPLETE 落档的结构化 metadata（buildAnalysisConfirmPrefill 产物）：
//   左栏 FOG 待决清单（增删改；清空 = 非探路型不开图）+ 目标行；
//   右栏 TASK 拆分预览（metadata.analysisTasks，行内编辑 + 勾选剔除——原盲盒开盒）。
// 三按钮（resolution 评论契约）：确认开图（fog 随 confirm 回传开图）/
// 不开图直接派工（fog 不带，只派工）/ 打回补充（reviewRejected 预设理由）。
// 确认回传 confirm={kind:confirmKind('analysis'|'plan'), destination, fog, tasks:勾选集}——后端序列化进
// l3.summary 并覆写 metadata.analysisTasks（存储契约不变），人永远不接触魔法行。
// #471：plan（一脉会话规划单）复用本弹窗（confirmKind='plan'）；台账化后「确认开图」
// 只初始化探路台账，不再逐条建决策单（#471 map-opening 降级）。
// #177 保留：带 channelId 时可选「默认执行角色」下拉（候选=频道成员，留空=涌现）。
// 批次A 项7 保留：onConfirm/onReject 可返回 Promise——提交期间禁用 + 失败内联保持打开。
// 入口：WuGateActions（列表行/抽屉/详情页三处合一，E2-4）/ DeliveryPanel 缺口「人工确认」。
// 公共骨架（submitting/取消键/关窗屏蔽/错误行）走 ui/ApproveDialogShell（Step 3 收敛）。
import { useEffect, useState } from 'react';
import { channelApi, type AgentProfile } from '../../api/channel';
import { ApproveDialogShell, Button, Select } from '../ui';
import { resolveChannelResponders } from './channelResponders';
import type { ReviewConfirmPayload } from '../../api/workunit';
import type { AnalysisConfirmPrefill } from './mapUtils';

interface AnalysisApproveDialogProps {
  /** 结构化预填（buildAnalysisConfirmPrefill 产物；全空 = agent 无产出，空手评或直接通过） */
  prefill: AnalysisConfirmPrefill;
  /** WU 所在频道 id（#177：给出则渲染「默认执行角色」下拉；缺省不渲染，存量形态不变） */
  channelId?: string | null;
  /** #471：confirm 载荷 kind（plan = 一脉会话规划单，与 analysis 同形契约）；缺省 'analysis' */
  confirmKind?: 'analysis' | 'plan';
  /** 确认（开图/直接派工）：表单数据随 confirm 回传；第二参 = 默认执行角色 profile id
   *  （留空 = undefined，涌现认领）。reject 时弹窗保持打开并内联错误 */
  onConfirm: (confirm: ReviewConfirmPayload & { kind: 'analysis' | 'plan' }, assigneeId?: string) => void | Promise<unknown>;
  /** 打回补充：reviewRejected 预设理由（reject 时弹窗保持打开并内联错误） */
  onReject: (reason: string) => void | Promise<unknown>;
  onCancel: () => void;
}

/** 打回补充预设理由（结论/拆分需修订，agent 据此返工） */
export const ANALYSIS_REJECT_REASON = '打回补充：分析结论或任务拆分需修订，请补充后重新提交确认';

interface TaskRow {
  text: string;
  included: boolean;
}

export function AnalysisApproveDialog({ prefill, channelId, confirmKind = 'analysis', onConfirm, onReject, onCancel }: AnalysisApproveDialogProps) {
  const [destination, setDestination] = useState(prefill.destination);
  const [fog, setFog] = useState<string[]>(prefill.fog);
  const [tasks, setTasks] = useState<TaskRow[]>(prefill.tasks.map(t => ({ text: t, included: true })));
  // #177：默认执行角色候选（频道成员）；'' = 留空涌现
  const [assigneeId, setAssigneeId] = useState('');
  const [candidates, setCandidates] = useState<AgentProfile[]>([]);

  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    Promise.all([channelApi.get(channelId), channelApi.listAllAgents()])
      .then(([chRes, agentsRes]) => {
        if (cancelled) return;
        const active = (agentsRes.data?.data || []).filter(p => p.status === 'active' && p.name !== 'studio');
        setCandidates(resolveChannelResponders(chRes.data?.data, channelId, active));
      })
      .catch(() => { if (!cancelled) setCandidates([]); });
    return () => { cancelled = true; };
  }, [channelId]);

  const cleanFog = fog.map(s => s.trim()).filter(Boolean);
  const includedTasks = tasks.filter(t => t.included && t.text.trim()).map(t => t.text.trim());

  return (
    <ApproveDialogShell
      maxWidth="44rem"
      title={confirmKind === 'plan' ? '确认规划结论' : '确认分析结论'}
      onCancel={onCancel}
      actions={({ submitting, run }) => (
        <>
          <button
            className="btn btn-danger"
            disabled={submitting}
            title="打回：结论或拆分需修订（agent 返工）"
            onClick={() => void run(() => onReject(ANALYSIS_REJECT_REASON))}
          >
            打回补充
          </button>
          <button
            className="btn btn-secondary"
            disabled={submitting}
            title="不开图：待决清单不进地图，仅按 TASK 拆分派工"
            onClick={() => void run(() => onConfirm(
              { kind: confirmKind, tasks: includedTasks },
              assigneeId || undefined,
            ))}
          >
            不开图直接派工
          </button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={() => void run(() => onConfirm(
              {
                kind: confirmKind,
                ...(destination.trim() ? { destination: destination.trim() } : {}),
                fog: cleanFog,
                tasks: includedTasks,
              },
              assigneeId || undefined,
            ))}
          >
            确认开图
          </Button>
        </>
      )}
    >
      <p className="text-xs u-text-2 mb-2">
        分析结论已拆解为待决问题（左栏，可增删改）与派工任务（右栏，可逐条修改、勾选剔除）。
        点「确认开图」后系统据此生成探路地图：待决问题在规划会话里逐条裁决，不再单独立决策单；清空待决问题 = 不需要探路，只按任务清单派工。结论有问题请点「打回补充」。
      </p>
      <div className="flex gap-4" style={{ alignItems: 'flex-start' }}>
        {/* 左栏：FOG 待决清单 */}
        <div className="flex-1 flex flex-col gap-1">
          <input
            className="input w-full"
            placeholder="目标（可选）：一句话目的地"
            value={destination}
            onChange={e => setDestination(e.target.value)}
            aria-label="目标"
          />
          {fog.map((q, i) => (
            <div key={i} className="flex gap-1 items-center">
              <input
                className="input w-full"
                placeholder="待决问题"
                value={q}
                onChange={e => setFog(prev => prev.map((x, k) => (k === i ? e.target.value : x)))}
                aria-label={`待决问题 ${i + 1}`}
              />
              <button
                className="btn btn-secondary btn-sm"
                aria-label={`删除待决问题 ${i + 1}`}
                onClick={() => setFog(prev => prev.filter((_, k) => k !== i))}
              >
                删
              </button>
            </div>
          ))}
          <button
            className="btn btn-secondary btn-sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setFog(prev => [...prev, ''])}
          >
            添加待决
          </button>
        </div>
        {/* 右栏：TASK 拆分预览（勾选剔除 + 行内编辑） */}
        <div className="flex-1 flex flex-col gap-1">
          <p className="text-xs u-text-2">派工预览（{includedTasks.length} 条将派工）</p>
          {tasks.length === 0 && (
            <p className="text-xs u-text-3">agent 未输出 TASK 拆分——确认后不自动派工，可手动转任务</p>
          )}
          {tasks.map((t, i) => (
            <div key={i} className="flex gap-1 items-center">
              <input
                type="checkbox"
                checked={t.included}
                onChange={e => setTasks(prev => prev.map((x, k) => (k === i ? { ...x, included: e.target.checked } : x)))}
                aria-label={`纳入派工 ${i + 1}`}
              />
              <input
                className="input w-full"
                value={t.text}
                onChange={e => setTasks(prev => prev.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                aria-label={`派工任务 ${i + 1}`}
              />
            </div>
          ))}
        </div>
      </div>
      {channelId && (
        <div className="mt-2">
          <p className="text-xs u-text-2 mb-1">
            默认执行角色（可选，不选则由频道成员自动认领；选中则应用于确认后拆出的全部任务）
          </p>
          <Select
            value={assigneeId}
            onChange={setAssigneeId}
            options={[
              { value: '', label: '自动认领（不指定）' },
              ...candidates.map(a => ({ value: a.id, label: a.name })),
            ]}
            placeholder="自动认领（不指定）"
            aria-label="默认执行角色"
            className="input w-full"
          />
        </div>
      )}
    </ApproveDialogShell>
  );
}
