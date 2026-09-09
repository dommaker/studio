// AnalysisApproveDialog - #106 M7 analysis 通过/确认弹窗（共享件，自 WorkUnitListPage 抽出）
// 预填 agent COMPLETE 落档的待决问题清单（mapUtils.buildMapOpeningPrefill 产物，
// #401 起用中文别名「目标：/待决：」逐行 map-opening 契约格式），人审改后随 summary 回传开图；
// 清空清单直接通过 = 非探路型，不开图。非 analysis 类型一律不走本弹窗（一键通过）。
// 入口：WuGateActions（列表行/抽屉/详情页三处合一，E2-4）/ DeliveryPanel 缺口「人工确认」。
// #177（#69 决议）：带 channelId 时加可选「默认执行角色」下拉（候选=频道成员，
// 默认留空=涌现，不阻塞主交互），选中值应用于确认后全部派生 task 子 WU，不做逐条指派。
// 批次A 项7：onConfirm 返回 Promise——提交期间确认键 loading + 双键禁用 + 屏蔽遮罩关闭，
// 成功才关窗（调用方在 onConfirm resolve 后关），失败内联错误行保持打开可重试。
import { useEffect, useState } from 'react';
import { channelApi, type AgentProfile } from '../../api/channel';
import { Button, Select } from '../ui';
import { resolveChannelResponders } from './channelResponders';
import { errorMessage } from '../../utils/errorMessage';

interface AnalysisApproveDialogProps {
  /** 预填文本（buildMapOpeningPrefill 产物；空串 = 无清单，空手填或直接通过） */
  prefill: string;
  /** WU 所在频道 id（#177：给出则渲染「默认执行角色」下拉；缺省不渲染，存量形态不变） */
  channelId?: string | null;
  /** 确认通过：当前文本作为 summary 回传（可为空串，api 层 trim 后为空则不带 summary 字段）；
   *  第二参 = 默认执行角色 profile id（留空 = undefined，涌现认领）。
   *  批次A 项7：可返回 Promise——reject 时弹窗保持打开并内联错误，resolve 后由调用方关窗 */
  onConfirm: (summary: string, assigneeId?: string) => void | Promise<unknown>;
  onCancel: () => void;
}

export function AnalysisApproveDialog({ prefill, channelId, onConfirm, onCancel }: AnalysisApproveDialogProps) {
  const [text, setText] = useState(prefill);
  // #177：默认执行角色候选（频道成员）；'' = 留空涌现
  const [assigneeId, setAssigneeId] = useState('');
  const [candidates, setCandidates] = useState<AgentProfile[]>([]);
  // 批次A 项7：提交反馈（loading + 失败内联错误）
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

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

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await onConfirm(text, assigneeId || undefined);
    } catch (e) {
      setSubmitError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={submitting ? undefined : onCancel}>
      <div className="modal" style={{ maxWidth: '28rem' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">确认分析结论</h3>
          <button className="modal-close" onClick={onCancel} disabled={submitting} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="text-xs u-text-2 mb-2">
            逐行确认待决问题（每行一条、以「待决：」开头，可增删改；首行可用「目标：」写明目的地）；
            确认通过后系统据此开图并逐条建决策单。清空清单直接通过 = 非探路型，不开图。
          </p>
          <textarea
            className="input w-full font-mono"
            rows={8}
            placeholder={'目标：一句话目标（可选）\n待决：待决问题 1\n待决：待决问题 2'}
            value={text}
            onChange={e => setText(e.target.value)}
          />
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
          {/* 批次A 项7：提交失败内联错误（弹窗保持打开可重试） */}
          {submitError && <p className="text-xs u-err" style={{ marginTop: 8 }}>{submitError}</p>}
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            取消
          </button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={() => void handleConfirm()}
          >
            确认通过
          </Button>
        </div>
      </div>
    </div>
  );
}
