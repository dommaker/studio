/**
 * 推荐下一步面板
 * 
 * 功能：
 * - 根据会议决策推荐相关操作
 * - 提供快速启动工作流入口
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

interface Decision {
  content: string;
  agreed: boolean;
  roles?: string[];
}

interface RecommendNextStepsProps {
  meetingId: string;
  summary?: string;
  decisions?: Decision[];
}

// 关键词到工作流的映射
const WORKFLOW_KEYWORDS: Record<string, { workflowId: string; name: string; icon: string }> = {
  '开发': { workflowId: 'wf-dev', name: '开发工作流', icon: '🔧' },
  '实现': { workflowId: 'wf-dev', name: '开发工作流', icon: '🔧' },
  '测试': { workflowId: 'wf-test', name: '测试工作流', icon: '🧪' },
  '评审': { workflowId: 'wf-review', name: '代码评审', icon: '👀' },
  '部署': { workflowId: 'wf-deploy', name: '部署工作流', icon: '🚀' },
  '架构': { workflowId: 'wf-arch', name: '架构设计', icon: '🏗️' },
  '需求': { workflowId: 'wf-req', name: '需求分析', icon: '📝' },
  '优化': { workflowId: 'wf-perf', name: '性能优化', icon: '⚡' },
  '分析': { workflowId: 'wf-analyze', name: '代码分析', icon: '🔍' },
  '对比': { workflowId: 'wf-compare', name: '版本对比', icon: '📊' },
};

export function RecommendNextSteps({ meetingId, summary, decisions }: RecommendNextStepsProps) {
  const [recommendations, setRecommendations] = useState<Array<{
    workflowId: string;
    name: string;
    icon: string;
    reason: string;
  }>>([]);

  useEffect(() => {
    const recs: Array<{ workflowId: string; name: string; icon: string; reason: string }> = [];
    const checkedWorkflows = new Set<string>();

    // 从决策中提取关键词
    if (decisions && decisions.length > 0) {
      decisions.forEach(d => {
        if (!d.agreed) return;
        
        Object.entries(WORKFLOW_KEYWORDS).forEach(([keyword, workflow]) => {
          if (d.content.includes(keyword) && !checkedWorkflows.has(workflow.workflowId)) {
            checkedWorkflows.add(workflow.workflowId);
            recs.push({
              ...workflow,
              reason: `决策中提到"${keyword}"`,
            });
          }
        });
      });
    }

    // 从摘要中提取关键词
    if (summary && recs.length < 3) {
      Object.entries(WORKFLOW_KEYWORDS).forEach(([keyword, workflow]) => {
        if (summary.includes(keyword) && !checkedWorkflows.has(workflow.workflowId)) {
          checkedWorkflows.add(workflow.workflowId);
          recs.push({
            ...workflow,
            reason: `会议总结中提到"${keyword}"`,
          });
        }
      });
    }

    // 如果没有匹配，推荐默认工作流
    if (recs.length === 0) {
      recs.push({
        workflowId: 'wf-solo',
        name: '个人开发流程',
        icon: '👤',
        reason: '适合快速开始开发任务',
      });
    }

    setRecommendations(recs.slice(0, 3));
  }, [summary, decisions]);

  if (recommendations.length === 0) return null;

  return (
    <div 
      className="p-4 rounded-lg"
      style={{ 
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
        🎯 推荐下一步
      </h3>
      
      <div className="space-y-2">
        {recommendations.map((rec) => (
          <Link
            key={rec.workflowId}
            to={`/workflows/${rec.workflowId}/run?fromMeeting=${meetingId}`}
            className="block p-3 rounded transition-colors hover:bg-[var(--bg-hover)]"
            style={{ background: 'var(--bg-primary)' }}
          >
            <div className="flex items-center gap-3">
              <span className="text-xl">{rec.icon}</span>
              <div className="flex-1">
                <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {rec.name}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {rec.reason}
                </div>
              </div>
              <span style={{ color: 'var(--text-tertiary)' }}>→</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
