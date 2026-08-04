// 连接指南弹窗 — VS Code Remote SSH + Cloud IDE（迁移自 ProjectDetail.tsx 的合并功能）
// 从 ProjectDetailPage 抽出；vscodeSteps/cloudIdeSteps 常量随本区块搬走

// VS Code 连接步骤
const vscodeSteps = [
  { step: 1, text: '安装 VS Code + Remote SSH 扩展' },
  { step: 2, text: '打开 VS Code，按 F1 输入 "Remote-SSH: Connect to Host"' },
  { step: 3, text: '输入服务器地址：root@49.232.195.87' },
  { step: 4, text: '连接成功后，File → Open Folder → 粘贴项目路径' },
];

// Cloud IDE 步骤
const cloudIdeSteps = [
  { step: 1, text: '访问 Cloud IDE：http://49.232.195.87:8443' },
  { step: 2, text: '登录密码：从管理员获取' },
  { step: 3, text: 'File → Open Folder → 粘贴项目路径' },
];

interface Props {
  showVscodeGuide: boolean;
  showCloudIdeGuide: boolean;
  setShowVscodeGuide: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCloudIdeGuide: React.Dispatch<React.SetStateAction<boolean>>;
  copiedStep: number | null;
  copyStep: (text: string, stepIndex: number) => Promise<void>;
}

export function GuideModals({ showVscodeGuide, showCloudIdeGuide, setShowVscodeGuide, setShowCloudIdeGuide, copiedStep, copyStep }: Props) {
  return (
    <>
      {/* VS Code 弹窗 */}
      {showVscodeGuide && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 448 }}>
            <div className="modal-header">
              <h3 className="modal-title">📋 VS Code Remote SSH</h3>
            </div>
            <div className="modal-body space-y-3">
              {vscodeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
                  <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="btn btn-sm btn-secondary">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded u-accent-dim u-accent">💡 提示：连接成功后 File → Open Folder → 粘贴路径</div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowVscodeGuide(false)} className="btn btn-secondary">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* Cloud IDE 弹窗 */}
      {showCloudIdeGuide && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 448 }}>
            <div className="modal-header">
              <h3 className="modal-title">☁️ Cloud IDE (浏览器中的 VS Code)</h3>
            </div>
            <div className="modal-body space-y-3">
              {cloudIdeSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
                  <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
                  <span className="text-sm flex-1">{step.text}</span>
                  <button onClick={() => copyStep(step.text, i)} className="btn btn-sm btn-secondary">
                    {copiedStep === i ? '✓' : '复制'}
                  </button>
                </div>
              ))}
              <div className="text-xs p-2 rounded u-accent-dim u-accent">💡 Cloud IDE 内置终端和浏览器预览</div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCloudIdeGuide(false)} className="btn btn-secondary">关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
