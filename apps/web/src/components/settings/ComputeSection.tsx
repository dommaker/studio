// 算力接入 section（从 pages/Settings.tsx 抽取，工单 35-E3）：Workspace 状态 + 加入算力弹窗 + Token 管理
import { useState } from 'react';
import { WorkspaceStatusBar } from '../WorkspaceStatusBar';
import { JoinComputeDialog } from '../JoinComputeDialog';
import { TokenManager } from '../TokenManager';

export function ComputeSection() {
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  return (
    <section className="space-y-4">
      <h2 className="mc-block-label" style={{ margin: 0 }}>🖥️ 算力接入</h2>
      <p className="text-sm u-text-2">
        管理远程 Workspace 连接和 Token，让外部机器加入算力池
      </p>
      <div className="card p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium mb-2 u-text-2">已连接 Workspace</h3>
          <WorkspaceStatusBar />
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setShowJoinDialog(true)}
            className="btn btn-primary"
          >
            + 加入算力
          </button>
        </div>
        <div>
          <h3 className="text-sm font-medium mb-2 u-text-2">Token 管理</h3>
          <TokenManager />
        </div>
      </div>
      <JoinComputeDialog
        open={showJoinDialog}
        onClose={() => setShowJoinDialog(false)}
      />
    </section>
  );
}
