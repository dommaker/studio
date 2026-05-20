// ProjectChangeInput - 项目变更输入组件
// 针对当前项目的变更操作，自动绑定项目上下文
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

interface ProjectChangeInputProps {
  projectId: string;
  projectName: string;
  onSubmit: (change: string, options?: { roleId?: string; workflowId?: string }) => Promise<void>;
  isLoading?: boolean;
}

interface Suggestion {
  type: 'role' | 'workflow';
  id: string;
  name: string;
  icon: string;
  description?: string;
}

// 快捷操作配置
const QUICK_ACTIONS = [
  { id: 'wf-bugfix', name: '修复问题', emoji: '🐛', workflow: 'wf-bugfix' },
  { id: 'wf-dev', name: '新增功能', emoji: '✨', workflow: 'wf-dev' },
  { id: 'wf-perf', name: '性能优化', emoji: '⚡', workflow: 'wf-perf' },
  { id: 'wf-test', name: '运行测试', emoji: '🧪', workflow: 'wf-test' },
  { id: 'generate-docs', name: '更新文档', emoji: '📝', skill: 'generate-docs' },
];

export function ProjectChangeInput({
  projectId,
  projectName,
  onSubmit,
  isLoading = false,
}: ProjectChangeInputProps) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPosition, setTriggerPosition] = useState<{ start: number; type: string } | null>(null);
  const [roles, setRoles] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; usageScenario?: string }>>([]);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // 加载角色和工作流
  useEffect(() => {
    async function loadData() {
      try {
        // 使用统一的 API 客户端
        const [rolesRes, workflowsRes] = await Promise.all([
          api.get('/roles', { params: { limit: 20 } }).catch(() => null),
          api.get('/workflows', { params: { limit: 10 } }).catch(() => null),
        ]);

        if (rolesRes?.data) {
          setRoles(rolesRes.data.data || []);
        }

        if (workflowsRes?.data) {
          setWorkflows((workflowsRes.data.data || []).map((w: any) => ({
            id: w.id,
            name: w.name,
            usageScenario: w.usageScenario,
          })));
        }
      } catch (err) {
        console.error('Failed to load data:', err);
      }
    }

    loadData();
  }, []);

  // 获取角色图标
  const getRoleIcon = (type: string) => {
    const icons: Record<string, string> = {
      developer: '👨‍💻',
      designer: '🎨',
      product_manager: '📊',
      architect: '🏗️',
      tester: '🧪',
      strategist: '🧠',
      reviewer: '🔍',
      tech_lead: '👤',
      pm: '📋',
    };
    return icons[type] || '👤';
  };

  // 解析输入，检测触发符
  const parseInput = useCallback((value: string, cursorPos: number) => {
    const beforeCursor = value.substring(0, cursorPos);
    
    // 匹配 @角色、/工作流（不需要 #项目，因为已绑定）
    const patterns = [
      { trigger: '@', type: 'role', regex: /@(\w*)$/ },
      { trigger: '/', type: 'workflow', regex: /\/(\w*)$/ },
    ];

    for (const pattern of patterns) {
      const match = beforeCursor.match(pattern.regex);
      if (match) {
        return {
          type: pattern.type,
          trigger: pattern.trigger,
          query: match[1].toLowerCase(),
          start: cursorPos - match[0].length,
        };
      }
    }
    
    return null;
  }, []);

  // 获取建议列表
  const getSuggestions = useCallback((type: string, query: string): Suggestion[] => {
    let items: Suggestion[] = [];

    if (type === 'role') {
      items = roles
        .filter(r => r.name.toLowerCase().includes(query))
        .map(r => ({
          type: 'role' as const,
          id: r.id,
          name: r.name,
          icon: getRoleIcon(r.type),
        }));
    } else if (type === 'workflow') {
      items = workflows
        .filter(w => w.name.toLowerCase().includes(query))
        .map(w => ({
          type: 'workflow' as const,
          id: w.id,
          name: w.name,
          icon: '⚡',
          description: w.usageScenario,
        }));
    }

    return items.slice(0, 5);
  }, [roles, workflows]);

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

  // 选择建议
  const selectSuggestion = (suggestion: Suggestion) => {
    if (!triggerPosition) return;

    const before = input.substring(0, triggerPosition.start);
    const after = input.substring(input.length);
    
    let replacement = '';
    if (suggestion.type === 'role') {
      replacement = `@${suggestion.name} `;
    } else {
      replacement = `/${suggestion.name} `;
    }

    setInput(before + replacement + after);
    setShowSuggestions(false);
    setTriggerPosition(null);

    setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  };

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

  // 提交变更
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    // 解析输入中的角色和工作流
    const roleMatch = input.match(/@(\S+)/);
    const workflowMatch = input.match(/\/(\S+)/);

    await onSubmit(input.trim(), {
      roleId: roleMatch?.[1],
      workflowId: workflowMatch?.[1],
    });

    setInput('');
  };

  // 快捷操作
  const handleQuickAction = async (action: typeof QUICK_ACTIONS[0]) => {
    if (isLoading) return;

    const defaultInput = action.workflow 
      ? `/${action.name} ` 
      : `描述需要${action.name}的内容...`;

    await onSubmit(defaultInput, {
      workflowId: action.workflow,
    });
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

  return (
    <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-100 p-6">
      {/* 标题 */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-xl flex items-center justify-center text-xl">
          🔄
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-800">项目变更</h3>
          <p className="text-sm text-gray-500">描述对「{projectName}」的变更需求</p>
        </div>
      </div>

      {/* 输入框 */}
      <form onSubmit={handleSubmit} className="relative">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="描述变更内容..."
          disabled={isLoading}
          className="w-full px-4 py-3 pr-24 bg-white border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all disabled:opacity-50"
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
        >
          {isLoading ? (
            <>
              <span className="animate-spin">⏳</span>
              <span>执行中</span>
            </>
          ) : (
            <>
              <span>▶</span>
              <span>执行</span>
            </>
          )}
        </button>
      </form>

      {/* 智能补全建议 */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          ref={suggestionsRef}
          className="absolute z-50 w-full mt-1 bg-white rounded-lg shadow-lg overflow-hidden border border-gray-200"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.type}-${suggestion.id}`}
              type="button"
              onClick={() => selectSuggestion(suggestion)}
              className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                index === selectedIndex ? 'bg-indigo-50' : ''
              }`}
            >
              <span className="text-lg">{suggestion.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-800 truncate">{suggestion.name}</div>
                {suggestion.description && (
                  <div className="text-xs text-gray-500 truncate">{suggestion.description}</div>
                )}
              </div>
              <span className="text-xs text-gray-400 px-2 py-0.5 bg-gray-100 rounded">
                Tab 选择
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 快捷操作 */}
      <div className="mt-4">
        <div className="text-xs text-gray-500 mb-2">快捷操作：</div>
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => handleQuickAction(action)}
              disabled={isLoading}
              className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 hover:border-indigo-300 hover:text-indigo-600 transition-all disabled:opacity-50 flex items-center gap-1.5"
            >
              <span>{action.emoji}</span>
              <span>{action.name}</span>
            </button>
          ))}
        </div>
      </div>

      </div>
  );
}
