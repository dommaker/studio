import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGoalStore } from '../stores/goalStore';

const statusLabels: Record<string, string> = {
  pending: '待执行',
  planning: '计划中',
  approved: '已审批',
  executing: '执行中',
  succeeded: '已完成',
  completed: '已完成',
  failed: '失败',
};

const statusColors: Record<string, string> = {
  pending: 'bg-gray-500/20 text-gray-300',
  planning: 'bg-blue-500/20 text-blue-300',
  approved: 'bg-yellow-500/20 text-yellow-300',
  executing: 'bg-purple-500/20 text-purple-300',
  succeeded: 'bg-green-500/20 text-green-300',
  completed: 'bg-green-500/20 text-green-300',
  failed: 'bg-red-500/20 text-red-300',
};

const priorityColors: Record<string, string> = {
  critical: 'text-red-400',
  high: 'text-orange-400',
  normal: 'text-blue-400',
  low: 'text-gray-400',
};

export function GoalListPage() {
  const { goals, goalExecutions, stats, loadGoals, loadStats, loadExecutions, cancelExecution, retryExecution } = useGoalStore();
  const [expandedGoal, setExpandedGoal] = useState<string | null>(null);

  useEffect(() => {
    loadGoals();
    loadStats();
  }, []);

  const toggleExpand = async (goalId: string) => {
    if (expandedGoal === goalId) {
      setExpandedGoal(null);
    } else {
      setExpandedGoal(goalId);
      await loadExecutions(goalId);
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">目标面板</h1>
            <p className="page-subtitle">Goal 驱动执行 — 查看目标与执行进度</p>
          </div>
          <Link to="/" className="btn btn-secondary">← 返回首页</Link>
        </div>

        {stats && (
          <div className="flex gap-6 mt-4">
            <StatBadge label="总目标" value={stats.totalGoals} color="text-blue-400" />
            <StatBadge label="执行中" value={stats.activeGoals} color="text-purple-400" />
            <StatBadge label="已完成" value={stats.completedGoals} color="text-green-400" />
            <StatBadge label="运行中 Agent" value={stats.runningGoalExecutions} color="text-yellow-400" />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-4xl">
          {goals.length === 0 ? (
            <div className="text-center py-20 text-gray-500">
              <div className="text-4xl mb-4">🎯</div>
              <p>暂无目标</p>
              <p className="text-sm mt-2">通过首页输入需求，系统会自动创建目标并调度执行</p>
            </div>
          ) : (
            <div className="space-y-3 mt-6">
              {goals.map(goal => (
                <div key={goal.id} className="rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                  <div
                    className="p-4 cursor-pointer flex items-center justify-between"
                    onClick={() => toggleExpand(goal.id)}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-white">{goal.title}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${statusColors[goal.status] || 'bg-gray-500/20 text-gray-300'}`}>
                          {statusLabels[goal.status] || goal.status}
                        </span>
                        {goal.priority && (
                          <span className={`text-xs ${priorityColors[goal.priority] || ''}`}>
                            {goal.priority === 'critical' ? '🔴' : goal.priority === 'high' ? '🟠' : goal.priority === 'low' ? '⚪' : '🔵'}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-400 mt-1 truncate">{goal.description || '无描述'}</p>
                    </div>
                    <span className="text-gray-500 text-lg">{expandedGoal === goal.id ? '▾' : '▸'}</span>
                  </div>

                  {expandedGoal === goal.id && (
                    <div className="px-4 pb-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      {(!goalExecutions[goal.id] || goalExecutions[goal.id].length === 0) ? (
                        <p className="text-gray-500 text-sm py-4">暂无执行记录</p>
                      ) : (
                        <div className="space-y-2 pt-3">
                          {goalExecutions[goal.id].map(exec => (
                            <div key={exec.id} className="flex items-center justify-between py-2 px-3 rounded" style={{ background: 'var(--bg-hover)' }}>
                              <div className="flex items-center gap-3">
                                <span className={`w-2 h-2 rounded-full ${
                                  exec.status === 'succeeded' ? 'bg-green-400' :
                                  exec.status === 'running' ? 'bg-yellow-400 animate-pulse' :
                                  exec.status === 'failed' ? 'bg-red-400' :
                                  exec.status === 'pending' ? 'bg-gray-400' : 'bg-blue-400'
                                }`} />
                                <span className="text-sm text-white">{exec.agentType || 'Agent'}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded ${statusColors[exec.status] || ''}`}>
                                  {statusLabels[exec.status] || exec.status}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                {exec.status === 'running' && (
                                  <button
                                    className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
                                    onClick={(e) => { e.stopPropagation(); cancelExecution(goal.id, exec.id); }}
                                  >
                                    取消
                                  </button>
                                )}
                                {exec.status === 'failed' && (
                                  <button
                                    className="text-xs px-2 py-1 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30"
                                    onClick={(e) => { e.stopPropagation(); retryExecution(goal.id, exec.id); }}
                                  >
                                    重试
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-sm text-gray-400">{label}</span>
    </div>
  );
}
