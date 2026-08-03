/**
 * Iron Law 警告横幅
 * 
 * AS-018: 在开发过程中显示 Iron Law 提醒
 * 显示在任务完成区域，提醒用户遵守铁律
 */

import React, { useState, useEffect } from 'react';
import { superpowersApi } from '../api';

export interface IronLawWarningBannerProps {
  // 显示场景：task_complete（任务完成）| test_skip（跳过测试）| implementation（实现阶段）
  scenario: 'task_complete' | 'test_skip' | 'implementation';
  // 任务信息（可选）
  taskName?: string;
  // 是否有测试证据
  hasTestEvidence?: boolean;
  // 是否已验证
  hasVerification?: boolean;
  // 是否已对比需求
  hasRequirementReview?: boolean;
  // 是否可关闭
  dismissible?: boolean;
  // 回调
  onRunTests?: () => void;
  onReviewRequirements?: () => void;
}

interface IronLaw {
  id: string;
  rule: string;
  message: string;
  description?: string;
}

export const IronLawWarningBanner: React.FC<IronLawWarningBannerProps> = ({
  scenario,
  taskName,
  hasTestEvidence = false,
  hasVerification = false,
  hasRequirementReview = false,
  dismissible = true,
  onRunTests,
  onReviewRequirements,
}) => {
  const [dismissed, setDismissed] = useState(false);
  const [ironLaws, setIronLaws] = useState<IronLaw[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadIronLaws();
  }, []);

  const loadIronLaws = async () => {
    try {
      const response = await superpowersApi.listIronLaws();
      setIronLaws(response.data || []);
    } catch (error) {
      console.error('Failed to load iron laws:', error);
    } finally {
      setLoading(false);
    }
  };

  // 根据场景确定要显示的警告
  const getWarnings = (): { law: IronLaw; reason: string }[] => {
    const warnings: { law: IronLaw; reason: string }[] = [];

    if (scenario === 'task_complete') {
      // Iron Law #2: 没有测试证据
      if (!hasTestEvidence) {
        const law = ironLaws.find(l => l.id === 'no_self_approval');
        if (law) {
          warnings.push({
            law,
            reason: '任务完成需要测试证据（测试报告、覆盖率数据或 CI 通过记录）',
          });
        }
      }

      // Iron Law #3: 没有运行验证
      if (!hasVerification) {
        const law = ironLaws.find(l => l.id === 'no_completion_without_verification');
        if (law) {
          warnings.push({
            law,
            reason: '请先运行验证命令（npm test / npm run build）',
          });
        }
      }

      // Iron Law #7: 没有对比需求
      if (!hasRequirementReview) {
        const law = ironLaws.find(l => l.id === 'no_implementation_without_requirement_review');
        if (law) {
          warnings.push({
            law,
            reason: '请检查实现是否满足验收标准（AC）',
          });
        }
      }
    }

    if (scenario === 'test_skip') {
      // Iron Law #4: 跳过测试
      const law = ironLaws.find(l => l.id === 'no_test_simplification');
      if (law) {
        warnings.push({
          law,
          reason: '测试困难应该解决，而不是跳过',
        });
      }
    }

    return warnings;
  };

  if (loading || dismissed) return null;

  const warnings = getWarnings();

  if (warnings.length === 0) return null;

  return (
    <div
      className="rounded-lg border-l-4 p-4 mb-4"
      style={{
        background: 'var(--error-dim)',
        borderColor: 'var(--error)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🚨</span>
          <span className="font-medium u-err">
            Iron Law 提醒
          </span>
        </div>
        {dismissible && (
          <button
            onClick={() => setDismissed(true)}
            className="u-text-3 u-hover-text text-sm"
          >
            ✕
          </button>
        )}
      </div>

      {/* Warnings */}
      <div className="space-y-2">
        {warnings.map(({ law, reason }, index) => (
          <div key={law.id} className="text-sm">
            <div className="font-mono text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
              {law.rule}
            </div>
            <div style={{ color: 'var(--text-primary)' }}>
              {reason}
            </div>
            {law.description && (
              <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                {law.description.split('\n')[0]}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Actions */}
      {scenario === 'task_complete' && (
        <div className="mt-3 flex gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            onClick={() => onRunTests?.()}
          >
            运行测试
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
            onClick={() => onReviewRequirements?.()}
          >
            检查需求
          </button>
        </div>
      )}
    </div>
  );
};

export default IronLawWarningBanner;
