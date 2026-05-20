// OutputDocuments - 产出文档展示组件
import { useState, useEffect } from 'react';
import { toast } from '../utils/toast';

interface OutputFile {
  filename: string;
  stepId?: string;
  size: number;
  createdAt: string;
}

interface OutputDocumentsProps {
  executionId: string;
  onClose?: () => void;
}

export function OutputDocuments({ executionId }: OutputDocumentsProps) {
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // 加载产出文档列表
  useEffect(() => {
    fetch(`/api/v1/outputs/${executionId}`)
      .then(res => res.json())
      .then(data => {
        setOutputs(data.outputs || []);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load outputs:', err);
        setLoading(false);
      });
  }, [executionId]);

  // 加载文件内容
  const loadContent = async (filename: string) => {
    setSelectedFile(filename);
    try {
      const res = await fetch(`/api/v1/outputs/${executionId}/${filename}`);
      const data = await res.json();
      setContent(data.content || '');
    } catch (err) {
      console.error('Failed to load content:', err);
      setContent('加载失败');
    }
  };

  if (loading) {
    return (
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>加载中...</div>
      </div>
    );
  }

  if (outputs.length === 0) {
    return (
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>暂无产出文档</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
      {/* 头部 */}
      <div className="px-4 py-3 border-b" style={{ background: 'rgba(16, 185, 129, 0.08)', borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <span className="text-lg">📄</span>
          <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>产出文档</span>
          <span className="text-xs ml-2" style={{ color: 'var(--text-tertiary)' }}>{outputs.length} 个文件</span>
        </div>
      </div>

      <div className="flex">
        {/* 文件列表 */}
        <div className="w-48 border-r" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
          {outputs.map(output => (
            <button
              key={output.filename}
              onClick={() => loadContent(output.filename)}
              className="w-full px-4 py-3 text-left text-sm border-b transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: selectedFile === output.filename ? 'var(--bg-elevated)' : 'transparent',
                borderLeftWidth: selectedFile === output.filename ? '2px' : '0',
                borderLeftColor: 'var(--accent-primary)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-base">
                  {output.filename.endsWith('.md') ? '📝' : 
                   output.filename.endsWith('.json') ? '📋' : 
                   output.filename.endsWith('.html') ? '🌐' : '📄'}
                </span>
                <span className="truncate flex-1" style={{ color: 'var(--text-primary)' }}>{output.filename}</span>
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {(output.size / 1024).toFixed(1)} KB
              </div>
            </button>
          ))}
        </div>

        {/* 内容展示 */}
        <div className="flex-1 min-h-[300px] max-h-[500px] overflow-auto p-4">
          {selectedFile ? (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{selectedFile}</div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(content);
                    toast.success('已复制');
                  }}
                  className="text-xs px-2 py-1 rounded transition-colors"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                >
                  复制
                </button>
              </div>
              <pre className="text-sm p-4 rounded-lg overflow-auto font-mono whitespace-pre-wrap break-words leading-relaxed" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                {content}
              </pre>
            </div>
          ) : (
            <div className="text-sm text-center py-12" style={{ color: 'var(--text-tertiary)' }}>
              选择文件查看内容
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
