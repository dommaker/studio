// IDE 指南弹窗（从 pages/ProjectDetailPage.tsx 抽取，工单 35-E4）：VS Code Remote SSH / Cloud IDE
// 服务器地址走项目既有 vite env 配置通道（同 api/index.ts 的 VITE_API_URL 惯例）：
// VITE_IDE_SSH_HOST / VITE_IDE_CLOUD_IDE_URL，缺省回退当前站点主机名，不再硬编码生产 IP。
import { useState, type ReactNode } from 'react';
import { IconClipboard, IconCloud, IconLightbulb } from '../ui/icons';
import { Modal } from '../ui';

const sshHost = import.meta.env.VITE_IDE_SSH_HOST || `root@${window.location.hostname}`;
const cloudIdeUrl = import.meta.env.VITE_IDE_CLOUD_IDE_URL || `http://${window.location.hostname}:8443`;

// VS Code 连接步骤
const vscodeSteps = [
  { step: 1, text: '安装 VS Code + Remote SSH 扩展' },
  { step: 2, text: '打开 VS Code，按 F1 输入 "Remote-SSH: Connect to Host"' },
  { step: 3, text: `输入服务器地址：${sshHost}` },
  { step: 4, text: '连接成功后，File → Open Folder → 粘贴项目路径' },
];

// Cloud IDE 步骤
const cloudIdeSteps = [
  { step: 1, text: `访问 Cloud IDE：${cloudIdeUrl}` },
  { step: 2, text: '登录密码：从管理员获取' },
  { step: 3, text: 'File → Open Folder → 粘贴项目路径' },
];

interface GuideStep { step: number; text: string }

interface GuideDialogProps {
  title: string;
  /** 标题前图标（批次 G-1：emoji → ui/icons SVG） */
  icon: ReactNode;
  steps: GuideStep[];
  hint: string;
  onClose: () => void;
}

function GuideDialog({ title, icon, steps, hint, onClose }: GuideDialogProps) {
  const [copiedStep, setCopiedStep] = useState<number | null>(null);

  // 复制步骤
  const copyStep = async (text: string, stepIndex: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedStep(stepIndex);
    setTimeout(() => setCopiedStep(null), 2000);
  };

  // 批次 I-2：收编 ui/Modal（§4.3 正本）。行为变化：原弹窗遮罩不可点关、无 ✕——
  // 迁移后点遮罩/Escape/✕ 均可关（§4.3 允许点遮罩关闭）
  return (
    <Modal
      onClose={onClose}
      maxWidth="448px"
      title={<span className="flex items-center gap-2">{icon}{title}</span>}
      footer={
        <button onClick={onClose} className="btn btn-secondary">关闭</button>
      }
    >
        <div className="space-y-3">
          {steps.map((step, i) => (
            <div key={i} className="flex items-center gap-2 p-2 u-surface-2 rounded">
              <span className="w-6 h-6 u-accent-bg u-on-accent rounded-full flex items-center justify-center text-sm">{step.step}</span>
              <span className="text-sm flex-1">{step.text}</span>
              <button onClick={() => copyStep(step.text, i)} className="btn btn-sm btn-secondary">
                {copiedStep === i ? '✓' : '复制'}
              </button>
            </div>
          ))}
          <div className="text-xs p-2 rounded u-accent-dim u-accent flex items-center gap-1.5">
            <IconLightbulb size={14} className="flex-shrink-0" />
            <span>{hint}</span>
          </div>
        </div>
    </Modal>
  );
}

export function VscodeGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <GuideDialog
      title="VS Code Remote SSH"
      icon={<IconClipboard />}
      steps={vscodeSteps}
      hint="提示：连接成功后 File → Open Folder → 粘贴路径"
      onClose={onClose}
    />
  );
}

export function CloudIdeGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <GuideDialog
      title="Cloud IDE (浏览器中的 VS Code)"
      icon={<IconCloud />}
      steps={cloudIdeSteps}
      hint="Cloud IDE 内置终端和浏览器预览"
      onClose={onClose}
    />
  );
}
