/**
 * 创建 Skill 弹窗
 * 
 * AI 辅助创建 Skill 配置
 */

import React, { useState } from 'react';

interface CreateToolStdModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface GeneratedSkill {
  id: string;
  name: string;
  description: string;
  intent: {
    keywords: string[];
    description: string;
    examples?: string[];
  };
  routing: Array<{
    condition: string;
    workflow: string;
    priority?: number;
  }>;
  defaultWorkflow: string;
  context?: {
    domain?: string;
    bestPractices?: string[];
  };
  openclaw?: {
    userInvocable?: boolean;
    emoji?: string;
  };
}

export const CreateToolStdModal: React.FC<CreateToolStdModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [step, setStep] = useState<'input' | 'preview' | 'saving'>('input');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState('');
  const [generatedSkill, setGeneratedSkill] = useState<GeneratedSkill | null>(null);
  const [yamlContent, setYamlContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!description.trim()) {
      setError('请输入需求描述');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/skills/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, context }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '生成失败');
      }

      setGeneratedSkill(data.skill);
      setYamlContent(data.yaml);
      setStep('preview');
    } catch (err: any) {
      setError(err.message || '生成失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!generatedSkill) return;

    setStep('saving');
    setError(null);

    try {
      const response = await fetch('/api/v1/skills/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: generatedSkill.id, yaml: yamlContent }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || '保存失败');
      }

      onSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || '保存失败');
      setStep('preview');
    }
  };

  const handleClose = () => {
    setStep('input');
    setDescription('');
    setContext('');
    setGeneratedSkill(null);
    setYamlContent('');
    setError(null);
    onClose();
  };

  const handleRegenerate = () => {
    setStep('input');
    setGeneratedSkill(null);
    setYamlContent('');
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '48rem', maxHeight: '90vh', overflow: 'hidden' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
            {step === 'input' && '🤖 AI 创建 Skill'}
            {step === 'preview' && '👀 预览 Skill 配置'}
            {step === 'saving' && '💾 保存中...'}
          </h2>
          <button
            onClick={handleClose}
            className="transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto" style={{ maxHeight: '60vh' }}>
          {step === 'input' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  需求描述 <span style={{ color: 'var(--error)' }}>*</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="描述你想创建的 Skill，例如：&#10;- 帮我创建一个代码审查的 Skill&#10;- 我想做一个性能优化的 Skill&#10;- 创建一个 Bug 修复的 Skill"
                  className="input w-full"
                  style={{ height: '8rem' }}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                  额外上下文（可选）
                </label>
                <textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="提供更多上下文，例如：&#10;- 项目类型：前端项目&#10;- 团队规模：3 人&#10;- 技术栈：React + TypeScript"
                  className="input w-full"
                  style={{ height: '6rem' }}
                />
              </div>

              {error && (
                <div className="p-3 rounded-lg text-sm" style={{ background: 'var(--error-dim)', border: '1px solid var(--error-border)', color: 'var(--error)' }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {step === 'preview' && generatedSkill && (
            <div className="space-y-4">
              {/* 基本信息 */}
              <div className="rounded-lg p-4" style={{ background: 'var(--bg-tertiary)' }}>
                <h3 className="font-medium mb-3" style={{ color: 'var(--text-primary)' }}>基本信息</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span style={{ color: 'var(--text-tertiary)' }}>ID：</span>
                    <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{generatedSkill.id}</span>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text-tertiary)' }}>名称：</span>
                    <span style={{ color: 'var(--text-primary)' }}>{generatedSkill.name}</span>
                  </div>
                  <div className="col-span-2">
                    <span style={{ color: 'var(--text-tertiary)' }}>描述：</span>
                    <span style={{ color: 'var(--text-primary)' }}>{generatedSkill.description}</span>
                  </div>
                </div>
              </div>

              {/* 意图关键词 */}
              <div className="rounded-lg p-4" style={{ background: 'var(--bg-tertiary)' }}>
                <h3 className="font-medium mb-3" style={{ color: 'var(--text-primary)' }}>意图关键词</h3>
                <div className="flex flex-wrap gap-2">
                  {generatedSkill.intent.keywords.map((keyword, i) => (
                    <span
                      key={i}
                      className="px-2 py-1 rounded text-sm u-accent-dim"
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              </div>

              {/* 路由规则 */}
              <div className="rounded-lg p-4" style={{ background: 'var(--bg-tertiary)' }}>
                <h3 className="font-medium mb-3" style={{ color: 'var(--text-primary)' }}>路由规则</h3>
                <div className="space-y-2 text-sm">
                  {generatedSkill.routing.map((rule, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span style={{ color: 'var(--text-tertiary)' }}>条件：</span>
                      <code className="px-2 py-1 rounded text-xs" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
                        {rule.condition}
                      </code>
                      <span style={{ color: 'var(--text-tertiary)' }}>→</span>
                      <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{rule.workflow}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>默认：</span>
                    <span className="font-mono">{generatedSkill.defaultWorkflow}</span>
                  </div>
                </div>
              </div>

              {/* YAML 预览 */}
              <div className="rounded-lg p-4 u-surface-2">
                <h3 className="font-medium mb-3 u-text-2">YAML 配置</h3>
                <pre className="text-sm overflow-x-auto whitespace-pre-wrap u-ok">
                  {yamlContent}
                </pre>
              </div>

              {error && (
                <div className="p-3 rounded-lg text-sm" style={{ background: 'var(--error-dim)', border: '1px solid var(--error-border)', color: 'var(--error)' }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {step === 'saving' && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--accent-primary)' }}></div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)' }}>
          {step === 'input' && (
            <>
              <button
                onClick={handleClose}
                className="btn btn-secondary"
              >
                取消
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading || !description.trim()}
                className="btn btn-primary"
              >
                {loading ? '生成中...' : '🤖 AI 生成'}
              </button>
            </>
          )}

          {step === 'preview' && (
            <>
              <button
                onClick={handleRegenerate}
                className="btn btn-secondary"
              >
                ← 重新生成
              </button>
              <div className="flex gap-3">
                <button
                  onClick={handleClose}
                  className="btn btn-secondary"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="btn btn-primary"
                  style={{ background: 'var(--success)' }}
                >
                  ✅ 保存 Skill
                </button>
              </div>
            </>
          )}

          {step === 'saving' && (
            <div className="w-full text-center" style={{ color: 'var(--text-tertiary)' }}>
              正在保存 Skill...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CreateToolStdModal;
