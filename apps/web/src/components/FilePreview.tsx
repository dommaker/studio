// FilePreview - 文件预览组件（增强版）
import { useState, useMemo } from 'react';

interface FilePreviewProps {
  file: {
    filename: string;
    content: string;
    size: number;
    mimeType?: string;
  };
  onClose?: () => void;
}

export function FilePreview({ file, onClose }: FilePreviewProps) {
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const [fullscreen, setFullscreen] = useState(false);

  // 判断文件类型
  const fileType = useMemo(() => {
    const ext = file.filename.split('.').pop()?.toLowerCase() || '';
    
    if (['md', 'markdown'].includes(ext)) return 'markdown';
    if (['json'].includes(ext)) return 'json';
    if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) return 'javascript';
    if (['py'].includes(ext)) return 'python';
    if (['css', 'scss', 'less'].includes(ext)) return 'css';
    if (['html', 'htm'].includes(ext)) return 'html';
    if (['yaml', 'yml'].includes(ext)) return 'yaml';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
    if (['csv'].includes(ext)) return 'csv';
    if (['pdf'].includes(ext)) return 'pdf';
    return 'text';
  }, [file.filename]);

  // 格式化 JSON
  const formattedJson = useMemo(() => {
    if (fileType === 'json') {
      try {
        return JSON.stringify(JSON.parse(file.content), null, 2);
      } catch {
        return file.content;
      }
    }
    return file.content;
  }, [file.content, fileType]);

  // 渲染 Markdown（简化版）
  const renderedMarkdown = useMemo(() => {
    if (fileType !== 'markdown') return null;
    
    let html = file.content
      // 标题
      .replace(/^### (.*)$/gm, '<h3 class="text-lg font-bold mt-4 mb-2">$1</h3>')
      .replace(/^## (.*)$/gm, '<h2 class="text-xl font-bold mt-6 mb-3">$1</h2>')
      .replace(/^# (.*)$/gm, '<h1 class="text-2xl font-bold mt-8 mb-4">$1</h1>')
      // 粗体和斜体
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // 代码块
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="u-surface p-4 rounded-lg my-4 overflow-x-auto"><code class="text-sm u-text">$2</code></pre>')
      // 行内代码
      .replace(/`([^`]+)`/g, '<code class="u-surface-2 px-1.5 py-0.5 rounded text-sm font-mono">$1</code>')
      // 列表
      .replace(/^- (.*)$/gm, '<li class="ml-4">$1</li>')
      .replace(/^(\d+)\. (.*)$/gm, '<li class="ml-4">$2</li>')
      // 链接
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="u-accent hover:underline" target="_blank">$1</a>')
      // 换行
      .replace(/\n\n/g, '</p><p class="my-3">')
      .replace(/\n/g, '<br>');
    
    return `<div class="prose max-w-none"><p class="my-3">${html}</p></div>`;
  }, [file.content, fileType]);

  // 文件图标
  const fileIcon = useMemo(() => {
    const icons: Record<string, string> = {
      markdown: '📝',
      json: '📋',
      javascript: '💻',
      python: '🐍',
      css: '🎨',
      html: '🌐',
      yaml: '⚙️',
      image: '🖼️',
      csv: '📊',
      pdf: '📕',
      text: '📄',
    };
    return icons[fileType] || '📄';
  }, [fileType]);

  // 文件大小格式化
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={`rounded-xl overflow-hidden ${fullscreen ? 'fixed inset-4 z-50' : ''}`} 
         style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
      
      {/* 头部工具栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b"
           style={{ background: 'var(--accent-dim)', borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-3">
          <span className="text-xl">{fileIcon}</span>
          <div>
            <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{file.filename}</div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {formatSize(file.size)} · {fileType.toUpperCase()}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {/* 视图切换 */}
          {fileType !== 'image' && (
            <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-subtle)' }}>
              <button
                onClick={() => setViewMode('preview')}
                className={`px-3 py-1.5 text-xs transition-colors ${viewMode === 'preview' ? 'u-accent-bg u-on-accent' : ''}`}
                style={viewMode !== 'preview' ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : {}}
              >
                预览
              </button>
              <button
                onClick={() => setViewMode('raw')}
                className={`px-3 py-1.5 text-xs transition-colors ${viewMode === 'raw' ? 'u-accent-bg u-on-accent' : ''}`}
                style={viewMode !== 'raw' ? { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' } : {}}
              >
                原始
              </button>
            </div>
          )}
          
          {/* 全屏 */}
          <button
            onClick={() => setFullscreen(!fullscreen)}
            className="px-3 py-1.5 text-xs rounded-lg transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
          
          {/* 下载 */}
          <button
            onClick={() => {
              const blob = new Blob([file.content], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = file.filename;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="px-3 py-1.5 text-xs rounded-lg transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            下载
          </button>
          
          {/* 关闭 */}
          {onClose && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg transition-colors"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              关闭
            </button>
          )}
        </div>
      </div>

      {/* 内容区域 */}
      <div className="p-4 overflow-auto" style={{ maxHeight: fullscreen ? 'calc(100vh - 120px)' : '500px' }}>
        {/* 图片预览 */}
        {fileType === 'image' && (
          <div className="flex items-center justify-center p-8" style={{ background: 'var(--bg-tertiary)' }}>
            <img
              src={file.content.startsWith('data:') ? file.content : `data:image/png;base64,${file.content}`}
              alt={file.filename}
              className="max-w-full max-h-[600px] object-contain rounded-lg shadow-lg"
            />
          </div>
        )}
        
        {/* Markdown 预览 */}
        {fileType === 'markdown' && viewMode === 'preview' && (
          <div 
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: renderedMarkdown || '' }}
            style={{ color: 'var(--text-primary)' }}
          />
        )}
        
        {/* JSON 预览 */}
        {fileType === 'json' && viewMode === 'preview' && (
          <div className="space-y-2">
            <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              结构化视图
            </div>
            <pre className="text-sm p-4 rounded-lg overflow-auto font-mono leading-relaxed" 
                 style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
              {formattedJson}
            </pre>
          </div>
        )}
        
        {/* 原始视图 */}
        {(viewMode === 'raw' || !['markdown', 'json', 'image'].includes(fileType)) && fileType !== 'image' && (
          <div>
            <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {viewMode === 'raw' ? '原始内容' : '文件内容'}
            </div>
            <pre className="text-sm p-4 rounded-lg overflow-auto font-mono whitespace-pre-wrap break-words leading-relaxed"
                 style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
              {file.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default FilePreview;
