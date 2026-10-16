// 拆分来源：pages/KnowledgePage.tsx「+ 新建」手动条目表单整块（AS-022，纯 JSX 平移；
// 表单 state 仍由页面持有——空态 CTA 也经 setShowManualEntry 打开本表单）
import type { Dispatch, SetStateAction } from 'react';
import { Select, Button } from '../ui';

/** AS-022 手动新建条目表单值（页面 useState 形状） */
export interface ManualEntryFormState {
  type: string;
  title: string;
  content: string;
  consumptionMode: string;
  tags: string;
}

export interface ManualEntryFormProps {
  form: ManualEntryFormState;
  setForm: Dispatch<SetStateAction<ManualEntryFormState>>;
  /** 工单 38：提交中状态——Button loading 态防连点重复提交 */
  saving: boolean;
  onSubmit: () => void;
}

/** 统一视图「+ 新建」手动条目表单 */
export function ManualEntryForm({ form, setForm, saving, onSubmit }: ManualEntryFormProps) {
  return (
    <div className="card p-4 mb-4">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Select value={form.type} onChange={v => setForm({ ...form, type: v })}
          options={[
            { value: 'guideline', label: '指南' },
            { value: 'pitfall', label: '踩坑' },
            { value: 'architecture', label: '架构' },
            { value: 'process', label: '流程' },
          ]} />
        <Select value={form.consumptionMode} onChange={v => setForm({ ...form, consumptionMode: v })}
          options={[
            { value: 'reference', label: '参考 (reference)' },
            { value: 'signal', label: '信号 (signal)' },
            { value: 'rule', label: '规则 (rule)' },
            { value: 'context', label: '上下文 (context)' },
          ]} />
      </div>
      <input type="text" placeholder="标题" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
        className="input w-full mb-3" />
      <textarea placeholder="内容" value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} rows={4}
        className="input w-full mb-3" />
      <input type="text" placeholder="标签（逗号分隔）" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })}
        className="input w-full mb-3" />
      <Button onClick={onSubmit} disabled={!form.title || !form.content}
        loading={saving} loadingLabel="保存中...">
        保存
      </Button>
    </div>
  );
}
