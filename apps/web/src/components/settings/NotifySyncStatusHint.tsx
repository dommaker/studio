// 通知配置同步状态提示（从 pages/Settings.tsx 抽取，工单 35-E3）

export type NotifySyncStatus = 'checking' | 'synced' | 'needs-resave' | 'no-config';

export function NotifySyncStatusHint({ status }: { status: NotifySyncStatus }) {
  if (status === 'needs-resave') {
    return (
      <div className="p-3 rounded-lg border u-warn-dim u-warn-border">
        <div className="flex items-center gap-2">
          <span>⚠️</span>
          <span className="text-sm font-medium u-warn">通知配置需要重新保存</span>
        </div>
        <p className="text-xs mt-1 u-text-2">
          服务器配置已丢失（可能已重启），请点击"保存设置"重新同步配置。
        </p>
      </div>
    );
  }
  if (status === 'synced') {
    return (
      <div className="p-2 rounded-lg border u-ok-dim u-ok-border">
        <div className="flex items-center gap-2">
          <span>✅</span>
          <span className="text-xs u-ok">通知配置已同步到服务器</span>
        </div>
      </div>
    );
  }
  return null;
}
