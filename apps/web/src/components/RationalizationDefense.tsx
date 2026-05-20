/**
 * 合理化防御表组件
 * 
 * 在用户尝试跳过验证时，显示合理化防御表
 */

import React, { useState } from 'react';

export interface RationalizationExcuse {
  excuse: string;
  reality: string;
}

export interface RationalizationDefenseProps {
  excuses?: RationalizationExcuse[];
  userExcuse?: string;
  onProceed?: () => void;
  onCancel?: () => void;
  visible?: boolean;
}

// 常见借口列表
const DEFAULT_EXCUSES: RationalizationExcuse[] = [
  {
    excuse: '这只是一个小改动',
    reality: '小改动也可能引入大 bug，每次改动都值得认真验证',
  },
  {
    excuse: '我已经手动测试过了',
    reality: '手动测试不全面，自动化测试能覆盖更多边界情况',
  },
  {
    excuse: '时间紧迫，来不及写测试',
    reality: '不写测试会花更多时间调试和修复 bug',
  },
  {
    excuse: '这个功能很简单，不需要测试',
    reality: '简单的功能也可能有复杂的边界情况',
  },
  {
    excuse: '测试环境还没准备好',
    reality: '可以先用 mock 数据测试，等环境好了再集成测试',
  },
  {
    excuse: '别人也没写测试',
    reality: '别人不写测试不代表正确，应该向好的实践学习',
  },
  {
    excuse: '这个改动很紧急',
    reality: '紧急改动更需要验证，否则可能引入更严重的问题',
  },
  {
    excuse: '我没有权限写测试',
    reality: '可以申请权限或与团队讨论测试的重要性',
  },
];

export const RationalizationDefense: React.FC<RationalizationDefenseProps> = ({
  excuses = DEFAULT_EXCUSES,
  userExcuse,
  onProceed,
  onCancel,
  visible = true,
}) => {
  const [selectedExcuse, setSelectedExcuse] = useState<string | null>(null);

  if (!visible) return null;

  // 匹配用户的借口
  const matchedExcuse = userExcuse
    ? excuses.find(e =>
        userExcuse.toLowerCase().includes(e.excuse.toLowerCase().slice(0, 10))
      )
    : null;

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '40rem', maxHeight: '80vh', overflow: 'auto' }}>
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">⚠️</span>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>检测到可能的合理化借口</h3>
          </div>

          {/* Matched Excuse */}
          {matchedExcuse ? (
            <div className="mb-6 p-4 rounded-lg" style={{ background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.3)' }}>
              <div className="mb-2">
                <span className="font-semibold" style={{ color: '#b45309' }}>你的借口：</span>
                <span style={{ color: '#a16207' }}>"{matchedExcuse.excuse}"</span>
              </div>
              <div className="p-3 rounded" style={{ background: 'var(--bg-elevated)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>💡 现实：</span>
                <span style={{ color: 'var(--text-secondary)' }}>{matchedExcuse.reality}</span>
              </div>
            </div>
          ) : (
            <div className="mb-6">
              <p className="mb-3" style={{ color: 'var(--text-secondary)' }}>
                跳过验证可能会带来风险。以下是一些常见的借口及其反驳：
              </p>

              {/* Excuses Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: 'var(--bg-tertiary)' }}>
                      <th className="text-left p-2 rounded-tl" style={{ color: 'var(--text-secondary)' }}>借口</th>
                      <th className="text-left p-2 rounded-tr" style={{ color: 'var(--text-secondary)' }}>现实</th>
                    </tr>
                  </thead>
                  <tbody>
                    {excuses.map((excuse, index) => (
                      <tr
                        key={index}
                        className="cursor-pointer"
                        style={{
                          background: selectedExcuse === excuse.excuse ? 'rgba(59,130,246,0.1)' : undefined,
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                        onMouseEnter={(e) => { if (selectedExcuse !== excuse.excuse) e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
                        onMouseLeave={(e) => { if (selectedExcuse !== excuse.excuse) e.currentTarget.style.background = ''; }}
                        onClick={() => setSelectedExcuse(excuse.excuse)}
                      >
                        <td className="p-2" style={{ color: 'var(--text-primary)' }}>{excuse.excuse}</td>
                        <td className="p-2" style={{ color: 'var(--text-secondary)' }}>{excuse.reality}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Warning */}
          <div className="mb-6 p-3 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
            <p className="text-sm" style={{ color: 'var(--error)' }}>
              <span className="font-semibold">⚠️ 警告：</span>
              跳过验证可能导致未发现的问题进入生产环境。
            </p>
          </div>

          {/* Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={onCancel}
              className="btn btn-secondary"
            >
              返回验证
            </button>
            <button
              onClick={onProceed}
              className="btn btn-danger"
            >
              仍然跳过
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RationalizationDefense;
