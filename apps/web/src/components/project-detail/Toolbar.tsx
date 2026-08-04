// 工具栏 — VS Code / Cloud IDE 指南入口 + 归档知识（human-only）+ 复制路径
// 从 ProjectDetailPage 抽出
import type { KnowledgeDoc } from '../../api/knowledge';

interface Props {
  archivableDocs: KnowledgeDoc[];
  archiveLoading: boolean;
  handleArchive: () => Promise<void>;
  copySuccess: boolean;
  handleCopyPath: () => Promise<void>;
  setShowVscodeGuide: React.Dispatch<React.SetStateAction<boolean>>;
  setShowCloudIdeGuide: React.Dispatch<React.SetStateAction<boolean>>;
}

export function Toolbar({ archivableDocs, archiveLoading, handleArchive, copySuccess, handleCopyPath, setShowVscodeGuide, setShowCloudIdeGuide }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => setShowVscodeGuide(true)}
        className="btn btn-primary"
      >
        VS Code 打开
      </button>
      <button
        onClick={() => setShowCloudIdeGuide(true)}
        className="btn btn-primary"
      >
        ☁️ Cloud IDE
      </button>
      {archivableDocs.length > 0 && (
        <button
          onClick={handleArchive}
          disabled={archiveLoading}
          className="btn u-ok-bg u-on-accent u-hover-bg"
        >
          {archiveLoading ? '归档中...' : '📦 归档知识'}
        </button>
      )}
      <button
        onClick={handleCopyPath}
        className="btn btn-secondary"
      >
        {copySuccess ? '✓ 已复制' : '📋 复制路径'}
      </button>
    </div>
  );
}
