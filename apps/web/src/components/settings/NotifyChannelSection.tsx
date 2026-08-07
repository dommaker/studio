// 通知渠道 section（从 pages/Settings.tsx 抽取，工单 35-E3）：Discord/企微/Telegram 三段合并为数据驱动

export interface NotifyField {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}

interface NotifyChannelSectionProps {
  title: string;
  enabled: boolean;
  fields: NotifyField[];
}

export function NotifyChannelSection({ title, enabled, fields }: NotifyChannelSectionProps) {
  const renderField = (field: NotifyField) => (
    <div key={field.label}>
      <label className="block text-sm font-medium mb-2 u-text-2">{field.label}</label>
      <input type="text" placeholder={field.placeholder} value={field.value}
        onChange={(e) => field.onChange(e.target.value)}
        className="input w-full" />
    </div>
  );
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="mc-block-label" style={{ margin: 0 }}>{title}</h2>
        <span className={`tag ${enabled ? 'tag-success' : 'tag-warning'}`}>{enabled ? '已启用' : '未启用'}</span>
      </div>
      {fields.length > 1 ? (
        <div className="grid grid-cols-2 gap-4">
          {fields.map(renderField)}
        </div>
      ) : (
        fields.map(renderField)
      )}
    </section>
  );
}
