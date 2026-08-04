/**
 * 新用户引导组件
 * 
 * 功能：
 * - 首次访问时显示引导流程
 * - 介绍核心功能
 * - 本地存储记录已完成状态
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

const ONBOARDING_KEY = 'agent-studio-onboarding-completed';
const STEPS = [
  {
    title: '欢迎使用 Agent Studio',
    description: '一个多角色协作的智能工作流平台',
    icon: '⚡',
    content: (
      <div className="space-y-3">
        <p>在这里，你可以：</p>
        <ul className="list-disc list-inside space-y-1 text-sm">
          <li>创建<strong>会议室</strong>，让多个 AI 角色协作讨论</li>
          <li>运行<strong>工作流</strong>，自动化开发任务</li>
          <li>管理<strong>角色</strong>，配置你的 AI 团队</li>
        </ul>
      </div>
    ),
  },
  {
    title: '会议室',
    description: '多角色协作讨论的空间',
    icon: '📋',
    content: (
      <div className="space-y-3">
        <p>会议室让多个角色以不同立场参与讨论：</p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="p-2 rounded" style={{ background: 'var(--bg-primary)' }}>
            🧠 方案策划 - 推动方案
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--bg-primary)' }}>
            🔍 评审专家 - 审议挑刺
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--bg-primary)' }}>
            👨‍💻 开发工程师 - 执行实现
          </div>
          <div className="p-2 rounded" style={{ background: 'var(--bg-primary)' }}>
            🧪 测试工程师 - 质量保障
          </div>
        </div>
      </div>
    ),
  },
  {
    title: '工作流',
    description: '自动化开发任务',
    icon: '🔄',
    content: (
      <div className="space-y-3">
        <p>预置工作流帮你快速开始：</p>
        <div className="space-y-2 text-sm">
          <div className="p-2 rounded flex items-center gap-2" style={{ background: 'var(--bg-primary)' }}>
            <span>🔧</span> wf-dev - 完整开发流程
          </div>
          <div className="p-2 rounded flex items-center gap-2" style={{ background: 'var(--bg-primary)' }}>
            <span>🧪</span> wf-test - 测试工作流
          </div>
          <div className="p-2 rounded flex items-center gap-2" style={{ background: 'var(--bg-primary)' }}>
            <span>🚀</span> wf-deploy - 部署上线
          </div>
        </div>
      </div>
    ),
  },
  {
    title: '开始使用',
  },
];

interface OnboardingProps {
  onComplete?: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [show, setShow] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const completed = localStorage.getItem(ONBOARDING_KEY);
    if (!completed) {
      setShow(true);
    }
  }, []);

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
    setShow(false);
    onComplete?.();
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  if (!show) return null;

  const step = STEPS[currentStep];

  return (
    <div className="modal-overlay">
      <div 
        className="w-full max-w-lg rounded-lg overflow-hidden"
        style={{ 
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {/* 头部 */}
        <div 
          className="p-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="flex items-center gap-3">
            <span className="text-3xl">{step.icon}</span>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {step.title}
              </h2>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {step.description}
              </p>
            </div>
          </div>
          <button
            onClick={handleSkip}
            className="text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            跳过
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6" style={{ color: 'var(--text-secondary)' }}>
          {step.content}
        </div>

        {/* 底部 */}
        <div 
          className="p-4 flex items-center justify-between"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          {/* 进度点 */}
          <div className="flex gap-2">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className="w-2 h-2 rounded-full transition-colors"
                style={{
                  background: i === currentStep 
                    ? 'var(--accent-primary)' 
                    : 'var(--bg-tertiary)',
                }}
              />
            ))}
          </div>

          {/* 按钮 */}
          <div className="flex gap-2">
            {currentStep > 0 && (
              <button
                onClick={handlePrev}
                className="px-4 py-2 rounded"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
              >
                上一步
              </button>
            )}
            <button
              onClick={handleNext}
              className="px-4 py-2 rounded"
              style={{
                background: 'var(--accent-primary)',
                color: 'var(--bg-primary)',
                border: 'none',
              }}
            >
              {currentStep === STEPS.length - 1 ? '开始使用' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
