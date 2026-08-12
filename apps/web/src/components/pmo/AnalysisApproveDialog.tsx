// AnalysisApproveDialog - #106 M7 analysis 通过/确认弹窗（共享件，自 WorkUnitListPage 抽出）
// 预填 agent COMPLETE 落档的待决问题清单（mapUtils.buildMapOpeningPrefill 产物，
// DESTINATION:/FOG: 逐行 map-opening 契约格式），人审改后随 summary 回传开图；
// 清空清单直接通过 = 非探路型，不开图。非 analysis 类型一律不走本弹窗（一键通过）。
// 入口：WorkUnitListPage 行按钮 / WorkUnitDrawer 确认按钮 / DeliveryPanel 缺口「人工确认」。
import { useState } from 'react';

interface AnalysisApproveDialogProps {
  /** 预填文本（buildMapOpeningPrefill 产物；空串 = 无清单，空手填或直接通过） */
  prefill: string;
  /** 确认通过：当前文本作为 summary 回传（可为空串，api 层 trim 后为空则不带 summary 字段） */
  onConfirm: (summary: string) => void;
  onCancel: () => void;
}

export function AnalysisApproveDialog({ prefill, onConfirm, onCancel }: AnalysisApproveDialogProps) {
  const [text, setText] = useState(prefill);
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: '28rem' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">确认分析结论</h3>
          <button className="modal-close" onClick={onCancel} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">
          <p className="text-xs u-text-2 mb-2">
            审核待决问题清单（逐行 FOG: 格式，可增删改）；确认通过后系统据此开图并逐条建决策单。
            清空清单直接通过 = 非探路型，不开图。
          </p>
          <textarea
            className="input w-full font-mono"
            rows={8}
            placeholder={'DESTINATION: 一句话目标（可选）\nFOG: 待决问题 1\nFOG: 待决问题 2'}
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onConfirm(text)}
          >
            确认通过
          </button>
        </div>
      </div>
    </div>
  );
}
