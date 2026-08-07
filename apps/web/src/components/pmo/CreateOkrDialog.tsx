// CreateOkrDialog - 创建 OKR 弹窗（支持 KR 编辑；自 PMOPage 抽出，工单 33）
import { useState } from 'react';
import { okrApi } from '../../api/pmo';
import { toast } from '../../utils/toast';
import { Select } from '../ui';
import {
  getCurrentQuarter,
  METRIC_TYPE_OPTIONS,
  METRIC_META,
  validateKRTarget,
  type KR,
} from './okrMetric';

interface CreateOkrDialogProps {
  open: boolean;
  companyId?: string;
  onClose: () => void;
  onCreated: () => void;
}

const emptyKRs = (): KR[] => [
  { id: 'kr1', objectiveId: 'o1', title: '', target: 100, current: 0, unit: '%', metricType: '' },
];

export function CreateOkrDialog({ open, companyId, onClose, onCreated }: CreateOkrDialogProps) {
  // 🆕 B8: OKR 创建弹窗 — 支持 KR 编辑
  const [newOKRTitle, setNewOKRTitle] = useState('');
  const [newOKRQuarter, setNewOKRQuarter] = useState(getCurrentQuarter());
  const [krs, setKRs] = useState<KR[]>(emptyKRs);

  const addKR = () => {
    setKRs(prev => [...prev, {
      id: `kr${Date.now()}`,
      objectiveId: 'o1',
      title: '',
      target: 100,
      current: 0,
      unit: '%',
      metricType: '',
    }]);
  };

  const removeKR = (id: string) => {
    setKRs(prev => prev.filter(kr => kr.id !== id));
  };

  const updateKR = (id: string, field: keyof KR, value: string | number) => {
    setKRs(prev => prev.map(kr => kr.id === id ? { ...kr, [field]: value } : kr));
  };

  // 🆕 B8: 创建 OKR (支持 KR + metricType)
  const handleCreateOKR = async () => {
    if (!newOKRTitle.trim()) {
      toast.warning('请输入 OKR 标题');
      return;
    }
    // 验证 KR target > 0
    const invalidKR = krs.find(kr => kr.target <= 0);
    if (invalidKR) {
      toast.warning(`KR "${invalidKR.title || '未命名'}" 的目标值必须大于 0`);
      return;
    }

    try {
      const actualCompanyId = companyId || localStorage.getItem('companyId');
      if (!actualCompanyId) {
        toast.warning('请先选择公司');
        return;
      }

      await okrApi.create({
        companyId: actualCompanyId,
        title: newOKRTitle,
        quarter: newOKRQuarter,
        objectives: [{ id: 'o1', title: newOKRTitle }],
        keyResults: krs.filter(kr => kr.title.trim() !== ''),
      });

      onClose();
      setNewOKRTitle('');
      setKRs(emptyKRs());
      onCreated();
    } catch (err) {
      console.error('Failed to create OKR:', err);
      toast.error('创建 OKR 失败');
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 672 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">创建 OKR</h2>
        </div>
        <div className="modal-body">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm u-text-2 mb-1">季度</label>
              <input
                type="text"
                value={newOKRQuarter}
                onChange={(e) => setNewOKRQuarter(e.target.value)}
                className="input w-full"
                placeholder="2026-Q3"
              />
            </div>
            <div>
              <label className="text-sm u-text-2 mb-1">标题</label>
              <input
                type="text"
                value={newOKRTitle}
                onChange={(e) => setNewOKRTitle(e.target.value)}
                className="input w-full"
                placeholder="管线效率提升 Q2"
              />
            </div>
          </div>

          {/* 🆕 KR 编辑 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm u-text-2">关键结果 (KR)</label>
              <button
                onClick={addKR}
                className="btn btn-secondary btn-sm"
              >
                + 添加 KR
              </button>
            </div>
            {krs.map((kr, idx) => (
              <div key={kr.id} className="p-3 rounded mb-2" style={{ background: 'var(--bg-secondary)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-bold u-text-3">
                    KR{idx + 1}
                  </span>
                  <input
                    type="text"
                    value={kr.title}
                    onChange={(e) => updateKR(kr.id, 'title', e.target.value)}
                    className="input flex-1"
                    placeholder="关键结果描述"
                  />
                  {krs.length > 1 && (
                    <button
                      onClick={() => removeKR(kr.id)}
                      className="text-xs u-err u-hover-text"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div>
                    <label className="text-xs u-text-3">目标值</label>
                    <input
                      type="number"
                      value={kr.target}
                      min={1}
                      onChange={(e) => updateKR(kr.id, 'target', Number(e.target.value))}
                      className="input w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs u-text-3">当前值</label>
                    <input
                      type="number"
                      value={kr.current}
                      min={0}
                      onChange={(e) => updateKR(kr.id, 'current', Number(e.target.value))}
                      className="input w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs u-text-3">单位</label>
                    <input
                      type="text"
                      value={kr.unit}
                      onChange={(e) => updateKR(kr.id, 'unit', e.target.value)}
                      className="input w-full"
                      placeholder="% / min / 次"
                    />
                  </div>
                  <div>
                    <label className="text-xs u-text-3">自动度量</label>
                    <Select
                      value={kr.metricType || ''}
                      onChange={(v) => updateKR(kr.id, 'metricType', v)}
                      options={METRIC_TYPE_OPTIONS}
                      className="w-full"
                    />
                  </div>
                </div>
                {/* B8 Phase 1.5: inline validation */}
                {kr.metricType && (() => {
                  const v = validateKRTarget(kr);
                  const meta = METRIC_META[kr.metricType];
                  if (v.status === 'pass' && !meta?.baseline) return null;
                  const colorClass = v.status === 'blocked' ? 'u-err' : v.status === 'warning' ? 'u-warn' : 'u-ok';
                  return (
                    <div className={`mt-2 text-xs ${colorClass}`}>
                      {meta?.baseline !== undefined && `基准: ${meta.baseline}${meta.unit}`}
                      {meta?.baseline !== undefined && v.status !== 'pass' && ' · '}
                      {v.status !== 'pass' ? v.reason : ''}
                      {v.status === 'pass' && meta?.baseline !== undefined && ` ✓ 目标合理`}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
        </div>
        <div className="modal-footer">
          <button
            onClick={() => {
              onClose();
              setKRs(emptyKRs());
            }}
            className="btn btn-secondary"
          >
            取消
          </button>
          <button
            onClick={handleCreateOKR}
            className="btn btn-primary"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
