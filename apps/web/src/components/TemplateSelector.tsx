// 工作流模板选择器 - 按场景分类展示
import { useState, useMemo } from 'react';
import '../styles/theme.css';

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  keywords?: string[];
  usageScenario?: string;
  category: string;
  level: 'L0' | 'L1' | 'L2' | 'L3';
}

export interface TemplateCategory {
  id: string;
  name: string;
  emoji: string;
  description: string;
  workflows: WorkflowTemplate[];
}

// 模板分类定义
const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  {
    id: 'quick',
    name: '快速开始',
    emoji: '⚡',
    description: '轻量级操作，快速完成任务',
    workflows: [
      {
        id: 'wf-patch',
        name: 'Patch 补丁',
        description: 'L0 极简工作流，单文件修改',
        emoji: '🩹',
        keywords: ['配置', '文案', '修改', '单文件'],
        level: 'L0',
        category: 'quick',
        usageScenario: '适合：配置修改、文案修改、单文件调整',
      },
      {
        id: 'wf-quick',
        name: 'Quick 快速',
        description: 'L1 轻量工作流，快速原型验证',
        emoji: '🏃',
        keywords: ['原型', '验证', '快速', 'PoC'],
        level: 'L1',
        category: 'quick',
        usageScenario: '适合：快速验证想法、小型原型、紧急修复',
      },
    ],
  },
  {
    id: 'development',
    name: '开发流程',
    emoji: '🚀',
    description: '功能开发、项目构建',
    workflows: [
      {
        id: 'wf-dev',
        name: 'Dev 开发',
        description: 'L2 统一开发工作流，支持四种模式',
        emoji: '🔧',
        keywords: ['开发', '任务', '执行', '迭代', 'backlog'],
        level: 'L2',
        category: 'development',
        usageScenario: '适合：有 tasks.yml 按计划执行、从 backlog 读取任务、迭代开发',
      },
      {
        id: 'wf-full',
        name: 'Full 完整流程',
        description: 'L3 完整软件开发流程',
        emoji: '🎯',
        keywords: ['新项目', '完整', '规划', '设计', '开发', '测试', '部署'],
        level: 'L3',
        category: 'development',
        usageScenario: '适合：新项目启动、大功能开发、需要完整流程',
      },
      {
        id: 'wf-planning',
        name: 'Planning 规划',
        description: 'L2 需求规划、任务拆分',
        emoji: '📋',
        keywords: ['规划', '需求', '任务拆分', '估算'],
        level: 'L2',
        category: 'development',
        usageScenario: '适合：需求分析、任务拆分、生成 tasks.yml',
      },
    ],
  },
  {
    id: 'bugfix',
    name: 'Bug 修复',
    emoji: '🐛',
    description: '问题诊断与修复',
    workflows: [
      {
        id: 'wf-bugfix',
        name: 'Bugfix 修复',
        description: 'L1 Bug 修复流程',
        emoji: '🔧',
        keywords: ['bug', '修复', '问题', '调试'],
        level: 'L1',
        category: 'bugfix',
        usageScenario: '适合：Bug 诊断、修复、验证',
      },
    ],
  },
  {
    id: 'quality',
    name: '质量保障',
    emoji: '✅',
    description: '测试、审查、验证',
    workflows: [
      {
        id: 'wf-test',
        name: 'Test 测试',
        description: 'L2 单元测试工作流',
        emoji: '🧪',
        keywords: ['测试', '单元测试', '覆盖率'],
        level: 'L2',
        category: 'quality',
        usageScenario: '适合：运行单元测试、生成覆盖率报告',
      },
      {
        id: 'wf-e2e-test',
        name: 'E2E 测试',
        description: 'L2 E2E 端到端测试',
        emoji: '🎭',
        keywords: ['e2e', '端到端', '浏览器', '自动化'],
        level: 'L2',
        category: 'quality',
        usageScenario: '适合：浏览器自动化测试、E2E 测试',
      },
      {
        id: 'wf-validate',
        name: 'Validate 验证',
        description: 'L1 项目验证',
        emoji: '✔️',
        keywords: ['验证', '检查', '约束'],
        level: 'L1',
        category: 'quality',
        usageScenario: '适合：验证项目结构、检查约束条件',
      },
      {
        id: 'wf-constraint',
        name: 'Constraint 约束',
        description: 'L1 约束检查工作流',
        emoji: '🔒',
        keywords: ['约束', '检查', 'feature-list'],
        level: 'L1',
        category: 'quality',
        usageScenario: '适合：检查项目是否符合 Long-Running Agents 约束',
      },
    ],
  },
  {
    id: 'governance',
    name: '治理审计',
    emoji: '📋',
    description: '代码审查、系统审计',
    workflows: [
      {
        id: 'wf-review',
        name: 'Review 审核',
        description: 'L2 代码审核工作流',
        emoji: '👁️',
        keywords: ['审核', 'review', '代码审查'],
        level: 'L2',
        category: 'governance',
        usageScenario: '适合：多立场代码审核、质量把关',
      },
      {
        id: 'wf-audit',
        name: 'Audit 审计',
        description: 'L2 独立审计工作流',
        emoji: '🔍',
        keywords: ['审计', '安全', '合规'],
        level: 'L2',
        category: 'governance',
        usageScenario: '适合：独立审计、安全检查、合规审查',
      },
    ],
  },
  {
    id: 'system',
    name: '系统运维',
    emoji: '⚙️',
    description: '部署、发布、进化',
    workflows: [
      {
        id: 'wf-release',
        name: 'Release 发布',
        description: 'L2 发布流程',
        emoji: '🚢',
        keywords: ['发布', 'release', '部署'],
        level: 'L2',
        category: 'system',
        usageScenario: '适合：版本发布、部署上线',
      },
      {
        id: 'wf-continue',
        name: 'Continue 继续',
        description: 'L1 智能继续工作流',
        emoji: '▶️',
        keywords: ['继续', '恢复', '中断'],
        level: 'L1',
        category: 'system',
        usageScenario: '适合：中断后恢复、不知道做什么时自动判断',
      },
      {
        id: 'wf-evolution',
        name: 'Evolution 进化',
        description: 'L2 系统进化工作流',
        emoji: '📈',
        keywords: ['进化', '优化', '迭代'],
        level: 'L2',
        category: 'system',
        usageScenario: '适合：系统自我进化、能力差距分析',
      },
    ],
  },
];

// Level 颜色映射
const LEVEL_COLORS: Record<string, string> = {
  L0: '#10b981', // 绿色 - 极简
  L1: '#3b82f6', // 蓝色 - 轻量
  L2: '#f59e0b', // 黄色 - 标准
  L3: '#ef4444', // 红色 - 复杂
};

interface TemplateSelectorProps {
  onSelect: (workflowId: string) => void;
  onClose?: () => void;
}

export function TemplateSelector({ onSelect, onClose }: TemplateSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [hoveredWorkflow, setHoveredWorkflow] = useState<string | null>(null);

  // 搜索过滤
  const filteredCategories = useMemo(() => {
    if (!searchQuery) return TEMPLATE_CATEGORIES;

    const query = searchQuery.toLowerCase();
    return TEMPLATE_CATEGORIES.map(category => ({
      ...category,
      workflows: category.workflows.filter(
        workflow =>
          workflow.name.toLowerCase().includes(query) ||
          workflow.description.toLowerCase().includes(query) ||
          workflow.keywords?.some(k => k.toLowerCase().includes(query))
      ),
    })).filter(category => category.workflows.length > 0);
  }, [searchQuery]);

  // 展示的分类
  const displayCategories = selectedCategory
    ? filteredCategories.filter(c => c.id === selectedCategory)
    : filteredCategories;

  return (
    <div className="template-selector" style={{
      background: 'var(--bg-primary)',
      borderRadius: '12px',
      overflow: 'hidden',
      border: '1px solid var(--border-default)',
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '16px 20px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-default)',
      }}>
        <div>
          <h2 style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            工作流模板库
          </h2>
          <p style={{
            margin: '4px 0 0',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}>
            选择适合你场景的工作流模板
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* 搜索栏 */}
      <div style={{
        padding: '16px 20px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-default)',
      }}>
        <input
          type="text"
          placeholder="搜索工作流..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '14px',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
      </div>

      {/* 分类标签 */}
      <div style={{
        display: 'flex',
        gap: '8px',
        padding: '12px 20px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-default)',
        overflowX: 'auto',
      }}>
        <button
          onClick={() => setSelectedCategory(null)}
          style={{
            background: selectedCategory === null ? 'var(--accent-primary)' : 'transparent',
            border: selectedCategory === null ? 'none' : '1px solid var(--border-default)',
            borderRadius: '20px',
            padding: '6px 14px',
            fontSize: '13px',
            color: selectedCategory === null ? '#000' : 'var(--text-primary)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          全部
        </button>
        {TEMPLATE_CATEGORIES.map(category => (
          <button
            key={category.id}
            onClick={() => setSelectedCategory(category.id)}
            style={{
              background: selectedCategory === category.id ? 'var(--accent-primary)' : 'transparent',
              border: selectedCategory === category.id ? 'none' : '1px solid var(--border-default)',
              borderRadius: '20px',
              padding: '6px 14px',
              fontSize: '13px',
              color: selectedCategory === category.id ? '#000' : 'var(--text-primary)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {category.emoji} {category.name}
          </button>
        ))}
      </div>

      {/* 工作流列表 */}
      <div style={{
        padding: '16px 20px',
        maxHeight: '400px',
        overflowY: 'auto',
      }}>
        {displayCategories.map(category => (
          <div key={category.id} style={{ marginBottom: '24px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '12px',
            }}>
              <span style={{ fontSize: '20px' }}>{category.emoji}</span>
              <h3 style={{
                margin: 0,
                fontSize: '15px',
                fontWeight: 500,
                color: 'var(--text-primary)',
              }}>
                {category.name}
              </h3>
              <span style={{
                fontSize: '12px',
                color: 'var(--text-muted)',
              }}>
                {category.description}
              </span>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '12px',
            }}>
              {category.workflows.map(workflow => (
                <div
                  key={workflow.id}
                  onClick={() => onSelect(workflow.id)}
                  onMouseEnter={() => setHoveredWorkflow(workflow.id)}
                  onMouseLeave={() => setHoveredWorkflow(null)}
                  style={{
                    background: hoveredWorkflow === workflow.id ? 'var(--bg-hover)' : 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                    borderRadius: '8px',
                    padding: '14px',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '8px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '18px' }}>{workflow.emoji || '📄'}</span>
                      <span style={{
                        fontSize: '14px',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                      }}>
                        {workflow.name}
                      </span>
                    </div>
                    <span style={{
                      background: LEVEL_COLORS[workflow.level],
                      color: '#fff',
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 6px',
                      borderRadius: '4px',
                    }}>
                      {workflow.level}
                    </span>
                  </div>
                  <p style={{
                    margin: 0,
                    fontSize: '13px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}>
                    {workflow.description}
                  </p>
                  {hoveredWorkflow === workflow.id && workflow.usageScenario && (
                    <p style={{
                      margin: '8px 0 0',
                      fontSize: '12px',
                      color: 'var(--accent-primary)',
                      lineHeight: 1.5,
                    }}>
                      {workflow.usageScenario}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {displayCategories.length === 0 && (
          <div style={{
            textAlign: 'center',
            padding: '40px',
            color: 'var(--text-secondary)',
          }}>
            <span style={{ fontSize: '40px' }}>🔍</span>
            <p style={{ margin: '12px 0 0' }}>没有找到匹配的工作流</p>
          </div>
        )}
      </div>

      {/* 底部说明 */}
      <div style={{
        padding: '12px 20px',
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border-default)',
      }}>
        <p style={{
          margin: 0,
          fontSize: '12px',
          color: 'var(--text-muted)',
        }}>
          💡 Level 说明：L0 极简 → L1 轻量 → L2 标准 → L3 复杂
        </p>
      </div>
    </div>
  );
}

// 导出模板分类供其他组件使用
export { TEMPLATE_CATEGORIES };