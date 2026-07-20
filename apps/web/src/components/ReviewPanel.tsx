// ReviewPanel - 审核确认面板（深色主题优化版）
import { useState } from 'react';
import type { IntentAnalysis } from '../types';

interface ReviewPanelProps {
  analysis: IntentAnalysis & { usageScenario?: string };
  onConfirm: () => void;
  onModify: () => void;
  onCancel: () => void;
}

export function ReviewPanel({ analysis, onConfirm, onModify, onCancel }: ReviewPanelProps) {
  const [showDetails, setShowDetails] = useState(false);

  // 步骤图标
  const stepIcons: Record<string, string> = {
    requirements: '📋',
    rdqa: '🔄',
    architecture: '🏗️',
    'api-contract': '📜',
    'shared-types': '📝',
    frontend: '🎨',
    'frontend-mock': '🎭',
    backend: '⚙️',
    test: '🧪',
    'test-e2e': '🌐',
    'test-cycle': '🔄',
    review: '👀',
    deploy: '🚀',
  };

  // 步骤名称映射
  const stepNames: Record<string, string> = {
    requirements: '需求分析',
    rdqa: 'RDQA 评审',
    architecture: '架构设计',
    'api-contract': 'API 契约',
    'shared-types': '类型定义',
    frontend: '前端开发',
    'frontend-mock': '前端 Mock',
    backend: '后端开发',
    test: '测试验证',
    'test-e2e': 'E2E 测试',
    'test-cycle': '测试循环',
    review: '代码审查',
    deploy: '部署上线',
  };

  // 预计时间
  const getEstimatedTime = () => {
    const stepCount = analysis.steps?.length || 0;
    const minutes = stepCount * 5;
    if (minutes < 60) return `约 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `约 ${hours} 小时 ${mins} 分钟`;
  };

  // 置信度颜色
  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'var(--success)';
    if (confidence >= 0.6) return 'var(--accent-primary)';
    return 'var(--warning)';
  };

  return (
    <div 
      className="rounded-xl overflow-hidden animate-fade-in"
      style={{ 
        background: 'var(--bg-elevated)', 
        border: '1px solid var(--border-default)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)'
      }}
    >
      {/* 头部 */}
      <div 
        className="px-6 py-4"
        style={{ 
          background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(139, 92, 246, 0.15))',
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div 
              className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
              style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
            >
              🎯
            </div>
            <div>
              <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                意图识别结果
              </h3>
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                AI 已理解你的需求，请确认执行计划
              </p>
            </div>
          </div>
          {analysis.usedLLM && (
            <div 
              className="text-xs px-2 py-1 rounded-full"
              style={{ background: 'rgba(16, 185, 129, 0.15)', color: 'var(--success)' }}
            >
              🧠 LLM 增强
            </div>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="p-6 space-y-4">
        {/* 需求 */}
        <div>
          <label className="text-xs font-medium block mb-2" style={{ color: 'var(--text-tertiary)' }}>
            你的需求
          </label>
          <div 
            className="text-base px-4 py-3 rounded-lg"
            style={{ 
              background: 'var(--bg-tertiary)', 
              color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)'
            }}
          >
            {analysis.input}
          </div>
        </div>

        {/* 匹配信息 */}
        <div className="grid grid-cols-2 gap-4">
          <div 
            className="p-3 rounded-lg"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-tertiary)' }}>
              匹配工作流
            </label>
            <div className="flex items-center gap-2">
              <span className="font-semibold" style={{ color: 'var(--accent-primary)' }}>
                {analysis.skill}
              </span>
              <span 
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ 
                  background: `rgba(${analysis.confidence >= 0.8 ? '16, 185, 129' : analysis.confidence >= 0.6 ? '0, 212, 255' : '251, 191, 36'}, 0.15)`,
                  color: getConfidenceColor(analysis.confidence)
                }}
              >
                {Math.round(analysis.confidence * 100)}%
              </span>
            </div>
          </div>
          <div 
            className="p-3 rounded-lg"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-tertiary)' }}>
              预计时间
            </label>
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              {getEstimatedTime()}
            </span>
          </div>
        </div>

        {/* 提取的参数 */}
        {analysis.extractedParams && Object.keys(analysis.extractedParams).length > 0 && (
          <div>
            <label className="text-xs font-medium block mb-2" style={{ color: 'var(--text-tertiary)' }}>
              提取的参数
            </label>
            <div 
              className="flex flex-wrap gap-2 p-3 rounded-lg"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {Object.entries(analysis.extractedParams).map(([key, value]) => (
                <div 
                  key={key}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                  <span style={{ color: 'var(--text-tertiary)' }}>{key}:</span>
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {String(value).slice(0, 30)}{String(value).length > 30 ? '...' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 执行流程 */}
        {analysis.steps && analysis.steps.length > 0 && (
          <div>
            <div 
              className="flex items-center justify-between mb-2 cursor-pointer"
              onClick={() => setShowDetails(!showDetails)}
            >
              <label className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>
                执行流程 ({analysis.steps.length} 步)
              </label>
              <span className="text-xs" style={{ color: 'var(--accent-primary)' }}>
                {showDetails ? '收起' : '展开'}
              </span>
            </div>
            
            <div 
              className="flex flex-wrap gap-2 p-3 rounded-lg overflow-x-auto"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              {analysis.steps.map((step, index) => (
                <div key={`${step.id}-${index}`} className="flex items-center">
                  <div 
                    className="flex items-center gap-2 px-3 py-2 rounded-lg"
                    style={{ 
                      background: 'var(--bg-secondary)', 
                      border: '1px solid var(--border-subtle)' 
                    }}
                  >
                    <span className="text-lg">{stepIcons[step.id] || '📦'}</span>
                    <div>
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {stepNames[step.id] || step.name || step.id}
                      </div>
                      {showDetails && (
                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          ~5min
                        </div>
                      )}
                    </div>
                  </div>
                  {index < analysis.steps.length - 1 && (
                    <span className="mx-1" style={{ color: 'var(--text-muted)' }}>→</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI 推理过程 */}
        {analysis.reasoning && (
          <details className="group">
            <summary 
              className="cursor-pointer text-xs font-medium flex items-center gap-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <span className="group-open:rotate-90 transition-transform">▶</span>
              AI 推理过程
            </summary>
            <div 
              className="mt-2 p-3 rounded-lg text-sm"
              style={{ 
                background: 'var(--bg-tertiary)', 
                color: 'var(--text-secondary)',
                border: '1px dashed var(--border-subtle)'
              }}
            >
              {analysis.reasoning}
            </div>
          </details>
        )}

        {/* 使用场景说明 */}
        {analysis.usageScenario && (
          <div 
            className="p-3 rounded-lg text-sm"
            style={{ 
              background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.1))',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(99, 102, 241, 0.2)'
            }}
          >
            <span className="font-medium" style={{ color: 'var(--accent-primary)' }}>🎯 适用场景：</span>
            <span className="ml-2">{analysis.usageScenario}</span>
          </div>
        )}

        {/* 操作按钮 */}
        <div 
          className="flex items-center justify-end gap-3 pt-4"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg transition-colors"
            style={{ 
              color: 'var(--text-tertiary)',
              background: 'var(--bg-tertiary)'
            }}
          >
            取消
          </button>
          <button
            onClick={onModify}
            className="px-4 py-2 text-sm rounded-lg transition-colors"
            style={{ 
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-subtle)'
            }}
          >
            修改计划
          </button>
          <button
            onClick={onConfirm}
            className="px-5 py-2 text-sm rounded-lg font-medium u-on-bright transition-colors"
            style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
          >
            ✅ 开始执行
          </button>
        </div>
      </div>
    </div>
  );
}
