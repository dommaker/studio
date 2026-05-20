// CEOInput - CEO 指令输入组件（科幻极简风 + 智能补全）
// 支持：纯文本（自动创建会议）、@PMO（关联项目）、上传/粘贴/路径输入文档
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

interface CEOInputProps {
  onSubmit: (command: string, useLLM: boolean) => void;
  isLoading: boolean;
  projects?: Array<{ id: string; name: string }>;
}

interface Suggestion {
  type: 'pmo';
  id: string;
  name: string;
  icon: string;
}

interface RequirementDoc {
  name: string;
  content: string;
  source: 'upload' | 'paste';
}

export function CEOInput({ 
  onSubmit, 
  isLoading,
  projects = [],
}: CEOInputProps) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPosition, setTriggerPosition] = useState<{ start: number; type: string } | null>(null);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [filePath, setFilePath] = useState('');
  const [filePathError, setFilePathError] = useState('');
  
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 解析输入，检测触发符（只支持 @PMO）
  const parseInput = useCallback((value: string, cursorPos: number) => {
    const beforeCursor = value.substring(0, cursorPos);
    
    // 匹配 @PMO 项目编号
    const match = beforeCursor.match(/@(\w*)$/);
    if (match) {
      return {
        type: 'pmo',
        trigger: '@',
        query: match[1].toLowerCase(),
        start: cursorPos - match[0].length,
      };
    }
    
    return null;
  }, []);

  // 获取 PMO 项目建议列表
  const getSuggestions = useCallback((type: string, query: string): Suggestion[] => {
    if (type === 'pmo') {
      return projects
        .filter(p => 
          p.id.toLowerCase().includes(query) || 
          p.name.toLowerCase().includes(query)
        )
        .slice(0, 5)
        .map(p => ({
          type: 'pmo' as const,
          id: p.id,
          name: p.name,
          icon: '📋',
        }));
    }
    return [];
  }, [projects]);

  // 处理文件上传
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const content = await file.text();
      setInput(`[需求文档: ${file.name}]\n${content}`);
      setShowDocPicker(false);
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  };

  // 处理文件路径输入
  const handleFilePathSubmit = async () => {
    if (!filePath.trim()) return;
    
    setFilePathError('');
    try {
      const res = await api.post('/knowledge/read-file', { path: filePath.trim() });
      const content = res.data?.content || '';
      const fileName = filePath.split('/').pop() || filePath;
      setInput(`[需求文档: ${fileName}]\n${content}`);
      setShowDocPicker(false);
      setFilePath('');
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || '读取文件失败';
      setFilePathError(errorMsg);
    }
  };

  // 处理粘贴内容
  const handlePasteSubmit = () => {
    if (!pasteContent.trim()) return;
    setInput(`[需求文档]\n${pasteContent.trim()}`);
    setShowDocPicker(false);
    setPasteContent('');
  };

  // 处理输入变化
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setInput(value);

    const trigger = parseInput(value, cursorPos);
    
    if (trigger) {
      setTriggerPosition({ start: trigger.start, type: trigger.type });
      const newSuggestions = getSuggestions(trigger.type, trigger.query);
      setSuggestions(newSuggestions);
      setShowSuggestions(newSuggestions.length > 0);
      setSelectedIndex(0);
    } else {
      setShowSuggestions(false);
      setTriggerPosition(null);
    }
  };

  // 选择 PMO 项目建议
  const selectSuggestion = (suggestion: Suggestion) => {
    if (!triggerPosition) return;

    const before = input.substring(0, triggerPosition.start);
    const after = input.substring(input.length);
    
    const replacement = `@${suggestion.id} `;

    setInput(before + replacement + after);
    setShowSuggestions(false);
    setTriggerPosition(null);

    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // 选择需求文档（已移除，改用上传/粘贴）

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) {
      if (e.key === 'Enter') {
        handleSubmit(e);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, suggestions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Tab':
      case 'Enter':
        e.preventDefault();
        if (suggestions[selectedIndex]) {
          selectSuggestion(suggestions[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setShowSuggestions(false);
        break;
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSubmit(input.trim(), true);  // 默认使用 LLM
    }
  };

  // 点击外部关闭建议
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        !inputRef.current?.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const examples = [
    '@PM-001 继续开发',
    '实现用户登录功能',
    '上传需求文档 → 开始会议',
  ];

  return (
    <div className="relative">
      <form onSubmit={handleSubmit}>
        {/* 桌面端：输入框 + 按钮在同一行 */}
        <div className="hidden md:flex relative">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="描述需求（自动创建会议）或 @PMO 关联项目"
            disabled={isLoading}
            className="input w-full text-base pr-36"
            style={{ 
              background: 'var(--bg-tertiary)',
              borderColor: 'var(--border-default)',
            }}
            autoComplete="off"
          />
          {/* 文档上传按钮 - 输入框内 */}
          <button
            type="button"
            onClick={() => setShowDocPicker(true)}
            className="absolute right-24 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-md transition-all"
            style={{ 
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-sm)',
            }}
            title="上传/粘贴需求文档"
          >
            📄
          </button>
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5"
            style={{
              background: 'var(--accent-primary)',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '0.5rem',
              border: 'none',
              cursor: input.trim() && !isLoading ? 'pointer' : 'not-allowed',
              fontSize: '14px',
              fontWeight: 500,
              opacity: input.trim() && !isLoading ? 1 : 0.5,
              transition: 'all 0.2s',
            }}
          >
            <span style={{ color: '#ffffff' }}>▶</span>
            <span style={{ color: '#ffffff' }}>{isLoading ? '分析中' : '执行'}</span>
          </button>
        </div>

        {/* 移动端：输入框单独一行 + 按钮另起一行 */}
        <div className="md:hidden space-y-3">
          <input
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="描述需求或 @PMO 关联项目"
            disabled={isLoading}
            className="input w-full text-base"
            style={{ 
              background: 'var(--bg-tertiary)',
              borderColor: 'var(--border-default)',
            }}
            autoComplete="off"
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setShowDocPicker(true)}
              className="flex-1 py-2.5 rounded-lg transition-all"
              style={{ 
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            >
              📄 文档
            </button>
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="flex-1 flex items-center justify-center gap-1.5"
              style={{
                background: 'var(--accent-primary)',
                color: '#ffffff',
                padding: '10px 16px',
                borderRadius: '0.5rem',
                border: 'none',
                cursor: input.trim() && !isLoading ? 'pointer' : 'not-allowed',
                fontSize: '14px',
                fontWeight: 500,
                opacity: input.trim() && !isLoading ? 1 : 0.5,
                transition: 'all 0.2s',
              }}
            >
              <span style={{ color: '#ffffff' }}>▶</span>
              <span style={{ color: '#ffffff' }}>{isLoading ? '分析中' : '执行'}</span>
            </button>
          </div>
        </div>

        {/* 智能补全建议 */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute z-50 w-full mt-1 rounded-lg shadow-lg overflow-hidden animate-scaleIn"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-default)',
            }}
          >
            {suggestions.map((suggestion, index) => (
              <button
                key={`pmo-${suggestion.id}`}
                type="button"
                onClick={() => selectSuggestion(suggestion)}
                className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                  index === selectedIndex ? 'bg-opacity-10' : ''
                }`}
                style={{
                  background: index === selectedIndex ? 'var(--accent-primary)' : 'transparent',
                  color: index === selectedIndex ? '#fff' : 'var(--text-primary)',
                }}
              >
                <span className="text-lg">{suggestion.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{suggestion.id}</div>
                  <div 
                    className="text-xs truncate"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {suggestion.name}
                  </div>
                </div>
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)' }}>
                  Tab 选择
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 快捷提示 */}
        <div className="mt-4 flex items-center justify-center gap-3">
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            快捷输入：
          </span>
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-tertiary)' }}>
            @PMO
          </span>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            或点击 📄 上传文档
          </span>
        </div>

        {/* 示例提示 */}
        <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            示例：
          </span>
          {examples.map((example, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setInput(example)}
              className="btn btn-ghost"
              style={{ 
                padding: '4px 10px', 
                fontSize: '12px',
                background: 'var(--bg-tertiary)',
              }}
            >
              {example}
            </button>
          ))}
        </div>

        {/* 需求文档选择弹窗 */}
        {showDocPicker && (
          <div className="modal-overlay animate-fadeIn" onClick={() => setShowDocPicker(false)}>
            <div 
              className="modal-content animate-scaleIn"
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '500px' }}
            >
              <div className="modal-header">
                <h3 className="modal-title">📄 添加需求文档</h3>
                <button onClick={() => setShowDocPicker(false)} className="modal-close">✕</button>
              </div>
              <div className="p-4">
                {/* 上传文件 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    📤 上传文件
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.txt,.json"
                    onChange={handleFileUpload}
                    className="w-full p-3 rounded-lg"
                    style={{ 
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    支持 .md, .txt, .json 文件
                  </p>
                </div>

                {/* 粘贴内容 */}
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    📝 粘贴内容
                  </label>
                  <textarea
                    value={pasteContent}
                    onChange={e => setPasteContent(e.target.value)}
                    placeholder="直接粘贴需求文档内容..."
                    rows={4}
                    className="w-full p-3 rounded-lg resize-none"
                    style={{ 
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <button
                    onClick={handlePasteSubmit}
                    disabled={!pasteContent.trim()}
                    className="btn btn-primary w-full mt-2"
                  >
                    确认添加
                  </button>
                </div>

                {/* 文件路径 */}
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    📁 文件路径
                  </label>
                  <input
                    type="text"
                    value={filePath}
                    onChange={e => { setFilePath(e.target.value); setFilePathError(''); }}
                    placeholder="例如: ~/projects/my-app/requirements.md"
                    className="w-full p-3 rounded-lg"
                    style={{ 
                      background: 'var(--bg-tertiary)',
                      border: filePathError ? '1px solid var(--accent-danger)' : '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  {filePathError && (
                    <p className="text-xs mt-1" style={{ color: 'var(--accent-danger)' }}>
                      {filePathError}
                    </p>
                  )}
                  <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    支持绝对路径或相对路径（相对于配置的工作目录）
                  </p>
                  <button
                    onClick={handleFilePathSubmit}
                    disabled={!filePath.trim()}
                    className="btn btn-primary w-full mt-2"
                  >
                    读取文件
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}