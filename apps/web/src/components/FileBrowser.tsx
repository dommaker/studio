// FileBrowser - 文件浏览器组件
import { useState, useEffect } from 'react';
import { FilePreview } from './FilePreview';

interface FileItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
  extension?: string;
}

interface FileBrowserProps {
  projectPath: string;
  executionId?: string;
  onFileSelect?: (file: FileItem) => void;
}

export function FileBrowser({ projectPath, executionId: _executionId, onFileSelect }: FileBrowserProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [currentPath, setCurrentPath] = useState(projectPath);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载文件列表
  useEffect(() => {
    loadFiles(currentPath);
  }, [currentPath]);

  const loadFiles = async (path: string) => {
    try {
      setLoading(true);
      setError(null);
      
      // 调用 API 获取文件列表
      const res = await fetch(`/api/v1/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      setFiles(data.files || []);
    } catch (err) {
      console.error('Failed to load files:', err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadFileContent = async (file: FileItem) => {
    try {
      const res = await fetch(`/api/v1/files/content?path=${encodeURIComponent(file.path)}`);
      const data = await res.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      setFileContent(data.content || '');
      setSelectedFile(file);
      
      if (onFileSelect) {
        onFileSelect(file);
      }
    } catch (err) {
      console.error('Failed to load file content:', err);
      setError((err as Error).message);
    }
  };

  // 进入目录
  const enterDirectory = (dir: FileItem) => {
    setCurrentPath(dir.path);
    setSelectedFile(null);
  };

  // 返回上级目录
  const goUp = () => {
    const parentPath = currentPath.split('/').slice(0, -1).join('/');
    if (parentPath) {
      setCurrentPath(parentPath);
    }
  };

  // 获取文件图标
  const getFileIcon = (file: FileItem) => {
    if (file.type === 'directory') return '📁';
    
    const ext = file.extension || file.name.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
      md: '📝',
      json: '📋',
      js: '💻',
      jsx: '⚛️',
      ts: '💻',
      tsx: '⚛️',
      py: '🐍',
      css: '🎨',
      html: '🌐',
      yml: '⚙️',
      yaml: '⚙️',
      png: '🖼️',
      jpg: '🖼️',
      gif: '🖼️',
      svg: '🖼️',
      pdf: '📕',
      txt: '📄',
    };
    
    return icons[ext] || '📄';
  };

  // 格式化文件大小
  const formatSize = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // 格式化日期
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="rounded-xl p-6 text-center" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
        <div className="loading-spinner mx-auto mb-2"></div>
        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>加载文件列表...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl p-6 text-center" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
        <div className="text-2xl mb-2">❌</div>
        <div className="text-sm text-red-500">{error}</div>
        <button
          onClick={() => loadFiles(currentPath)}
          className="mt-4 px-4 py-2 rounded-lg text-sm"
          style={{ background: 'var(--accent-primary)', color: 'white' }}
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 路径导航 */}
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
        <button
          onClick={() => setCurrentPath(projectPath)}
          className="text-sm hover:underline"
          style={{ color: 'var(--accent-primary)' }}
        >
          项目根目录
        </button>
        {currentPath !== projectPath && currentPath.split('/').slice(projectPath.split('/').length).map((part, i, arr) => (
          <span key={i} className="flex items-center gap-2">
            <span style={{ color: 'var(--text-tertiary)' }}>/</span>
            <button
              onClick={() => setCurrentPath(projectPath + '/' + arr.slice(0, i + 1).join('/'))}
              className="text-sm hover:underline"
              style={{ color: 'var(--text-secondary)' }}
            >
              {part}
            </button>
          </span>
        ))}
      </div>

      {/* 文件列表 */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {/* 返回上级 */}
          {currentPath !== projectPath && (
            <button
              onClick={goUp}
              className="w-full px-4 py-3 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center gap-3"
            >
              <span className="text-lg">⬆️</span>
              <span style={{ color: 'var(--text-secondary)' }}>..</span>
            </button>
          )}
          
          {/* 文件和目录 */}
          {files.length === 0 ? (
            <div className="px-4 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
              <div className="text-3xl mb-2">📂</div>
              <div>目录为空</div>
            </div>
          ) : (
            files.map((file, index) => (
              <button
                key={index}
                onClick={() => file.type === 'directory' ? enterDirectory(file) : loadFileContent(file)}
                className="w-full px-4 py-3 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-between group"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{getFileIcon(file)}</span>
                  <div>
                    <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{file.name}</div>
                    {file.type === 'file' && file.modifiedAt && (
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {formatDate(file.modifiedAt)}
                      </div>
                    )}
                  </div>
                </div>
                
                {file.type === 'file' && file.size !== undefined && (
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {formatSize(file.size)}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* 文件预览 */}
      {selectedFile && selectedFile.type === 'file' && fileContent && (
        <FilePreview
          file={{
            filename: selectedFile.name,
            content: fileContent,
            size: selectedFile.size || 0,
          }}
          onClose={() => {
            setSelectedFile(null);
            setFileContent('');
          }}
        />
      )}
    </div>
  );
}

export default FileBrowser;
