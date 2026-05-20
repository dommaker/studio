// 首页 - 公司大厅（科幻极简风）
import { projectApi } from '../api';
import type { ExecutionState, IntentAnalysis, ThinkingMessage, Execution } from '../types';
import { CompanyHall } from '../components/CompanyHall';
import { HomeSkeleton } from '../components/HomeSkeleton';
import { useDashboardData } from '../hooks/useDashboardData';
import '../styles/theme.css';

interface HomeProps {
  executions: ExecutionState[];
  runtimeExecutions: Execution[];
  isAnalyzing: boolean;
  intentAnalysis: IntentAnalysis | null;
  _thinkingMessages: ThinkingMessage[];
  _isThinking: boolean;
  wsStatus: 'connected' | 'disconnected';
  MAX_THINKING_MESSAGES: number;
  defaultCompanyId?: string;
  onCommandSubmit: (command: string, useLLM: boolean) => Promise<void>;
  onConfirmExecution?: () => Promise<void>;
  onModifyFlow?: () => void;
  onCancelIntent?: () => void;
  onCancelTask?: (id: string) => Promise<void>;
  onRetryTask?: (id: string) => Promise<void>;
  onViewDetails: (execution: ExecutionState) => void;
  onDeleteTask?: (id: string) => Promise<void>;
}

export function Home(props: HomeProps) {
  const { isAnalyzing, onCommandSubmit } = props;
  
  // 🆕 使用聚合 hook（优化首屏加载）
  const { data, loading } = useDashboardData({ refreshInterval: 30000 });
  const defaultCompanyId = data.defaultCompanyId;

  // 🆕 FL-001: CEO 指令串联处理
  const handleCommandSubmit = async (command: string, useLLM: boolean) => {
    if (!defaultCompanyId) {
      // 无 companyId，降级到原有逻辑
      return onCommandSubmit(command, useLLM);
    }

    try {
      // 1. 解析 PMO 号
      const { data: parseResult } = await projectApi.parseCommand(command);

      if (parseResult.type === 'link') {
        // @PM-xxx: 关联已有项目，直接执行 workflow（原有逻辑）
        return onCommandSubmit(command, useLLM);
      }

      // 创建项目后降级到原有逻辑
      const { data: project } = await projectApi.create({
        companyId: defaultCompanyId,
        title: command.slice(0, 50),
        requirement: command,
      });

      return onCommandSubmit(command, useLLM);
    } catch (error) {
      console.error('FL-001 CEO 指令串联失败:', error);
      return onCommandSubmit(command, useLLM);
    }
  };

  // 显示骨架屏
  if (loading) {
    return <HomeSkeleton />;
  }

  return (
    <CompanyHall
      onCommandSubmit={handleCommandSubmit}
      isAnalyzing={isAnalyzing}
      roles={data.roles}
      projects={data.projects}
      workflows={data.workflows}
      stats={data.stats}
    />
  );
}

export default Home;
