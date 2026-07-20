// IntentResult - 意图识别结果展示（深色主题）
import type { IntentAnalysis } from '../types';
import '../styles/theme.css';

interface IntentResultProps {
  analysis: IntentAnalysis;
  onConfirm: () => void;
  onModify: () => void;
  onCancel: () => void;
  isExecuting: boolean;
}

export function IntentResult({ analysis, onConfirm, onModify, onCancel, isExecuting }: IntentResultProps) {
  const { input, matchedSkill, confidence, suggestedPipelines, extractedParams } = analysis;

  // 角色图标映射
  const roleIcons: Record<string, string> = {
    'requirements': '📋',
    'rdqa': '🔄',
    'architecture': '🏗️',
    'api-contract': '📜',
    'shared-types': '📝',
    'frontend': '🎨',
    'frontend-mock': '🎭',
    'backend': '⚙️',
    'test': '🧪',
    'test-e2e': '🌐',
    'test-cycle': '🔄',
    'review': '👀',
    'deploy': '🚀',
  };

  // 角色名称映射
  const roleNames: Record<string, string> = {
    'requirements': '需求分析',
    'rdqa': 'RDQA 评审',
    'architecture': '架构设计',
    'api-contract': 'API 契约',
    'shared-types': '类型定义',
    'frontend': '前端开发',
    'frontend-mock': '前端 Mock',
    'backend': '后端开发',
    'test': '测试',
    'test-e2e': 'E2E 测试',
    'test-cycle': '测试循环',
    'review': '代码审查',
    'deploy': '部署上线',
  };

  return (
    <div style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)' }}>
      <div className="max-w-4xl mx-auto p-6">
        {/* 意图分析结果 */}
        <div className="flex items-start gap-4 mb-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
            style={{ background: 'linear-gradient(to bottom right, #10b981, #14b8a6)' }}
          >
            🎯
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>意图识别结果</h3>
              <span className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)' }}
              >
                置信度 {Math.round(confidence * 100)}%
              </span>
            </div>
            <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>「{input}」</p>
            {matchedSkill && (
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                匹配技能：<span className="font-medium" style={{ color: 'var(--accent-primary)' }}>{matchedSkill}</span>
              </p>
            )}
          </div>
        </div>

        {/* 执行流程预览 */}
        {(suggestedPipelines?.length ?? 0) > 0 && (
          <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>执行流程</div>
            <div className="flex flex-wrap items-center gap-2">
              {suggestedPipelines!.map((pipeline, index) => (
                <div key={pipeline.id} className="flex items-center">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg shadow-sm"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
                  >
                    <span className="text-lg">{roleIcons[pipeline.id] || '📦'}</span>
                    <div>
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {roleNames[pipeline.id] || pipeline.name}
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{pipeline.id}</div>
                    </div>
                  </div>
                  {index < suggestedPipelines!.length - 1 && (
                    <span className="mx-2" style={{ color: 'var(--text-muted)' }}>→</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 提取的参数 */}
        {Object.keys(extractedParams).length > 0 && (
          <div className="rounded-xl p-4 mb-4" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>提取参数</div>
            <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {Object.entries(extractedParams).map(([key, value]) => (
                <span key={key} className="inline-block mr-4">
                  <span style={{ color: 'var(--text-tertiary)' }}>{key}:</span>{' '}
                  <span className="font-medium">{String(value)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex gap-3">
          <button
            onClick={onConfirm}
            disabled={isExecuting}
            className="flex-1 py-3 u-on-bright rounded-xl font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            style={{ background: 'linear-gradient(to right, #6366f1, #8b5cf6)' }}
          >
            {isExecuting ? (
              <>
                <span className="animate-spin">⏳</span>
                执行中...
              </>
            ) : (
              <>
                <span>✅</span>
                确认执行
              </>
            )}
          </button>
          <button
            onClick={onModify}
            disabled={isExecuting}
            className="btn btn-secondary px-6 py-3"
          >
            修改流程
          </button>
          <button
            onClick={onCancel}
            disabled={isExecuting}
            className="btn btn-ghost px-6 py-3"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
