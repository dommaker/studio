// CEOCommandInput - CEO 指令输入组件
import { useState } from 'react';

interface CEOCommandInputProps {
  onSubmit: (command: string) => void;
  isAnalyzing: boolean;
  disabled?: boolean;
}

export function CEOCommandInput({ onSubmit, isAnalyzing, disabled }: CEOCommandInputProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isAnalyzing && !disabled) {
      onSubmit(input.trim());
    }
  };

  const examples = [
    '@PM-001 继续开发',
    '实现用户登录功能',
    '优化首页加载速度',
  ];

  return (
    <div className="bg-gradient-to-r from-slate-900 to-slate-800 border-b">
      <div className="max-w-4xl mx-auto p-6">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-gradient-to-br from-amber-400 to-orange-500 rounded-xl flex items-center justify-center text-2xl">
            👔
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">CEO 指令中心</h2>
            <p className="text-sm text-slate-400">输入需求自动创建会议评审，或 @PM-xxx 直接执行</p>
          </div>
        </div>

        {/* 输入框 */}
        <form onSubmit={handleSubmit} className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="描述你的需求（自动创建会议）或 @PM-xxx 关联已有项目"
            disabled={disabled || isAnalyzing}
            className="w-full px-5 py-4 pr-32 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || isAnalyzing || disabled}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-6 py-2.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-lg font-medium hover:from-indigo-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
          >
            {isAnalyzing ? (
              <>
                <span className="animate-spin">⏳</span>
                分析中...
              </>
            ) : (
              <>
                <span>🚀</span>
                执行
              </>
            )}
          </button>
        </form>

        {/* 快捷示例 */}
        <div className="mt-3 flex flex-wrap gap-2">
          {examples.map((example, i) => (
            <button
              key={i}
              onClick={() => setInput(example)}
              disabled={disabled || isAnalyzing}
              className="text-xs px-3 py-1.5 bg-slate-700/50 text-slate-300 rounded-full hover:bg-slate-700 hover:text-white transition-all disabled:opacity-50"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
