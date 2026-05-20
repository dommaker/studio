// 首页 - 公司大厅（科幻极简风）
import { api, projectApi, meetingApi } from '../api';
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
  onMeetingCreated?: (meetingId: string) => void;
}

export function Home(props: HomeProps) {
  const { isAnalyzing, onCommandSubmit, onMeetingCreated } = props;
  
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

      // create/auto: 创建 Project → Meeting → DiscussionDriver
      // 2. 创建 Project
      const { data: project } = await projectApi.create({
        companyId: defaultCompanyId,
        title: command.slice(0, 50),
        requirement: command,
      });

      // 3. 创建 Meeting
      const meetingRes = await meetingApi.create({
        title: `评审: ${project.pmoNumber}`,
        topic: command,
        companyId: defaultCompanyId,
        mode: 'sync',
        maxRounds: 3,
      });
      const meeting = meetingRes.data.data;

      // 4. 关联 Meeting 和 Project
      await projectApi.linkMeeting(meeting.id, project.id);

      // 5. 推荐角色并邀请
      const rolesRes = await api.get(`/meetings/recommend-roles`, {
        params: { topic: command, companyId: defaultCompanyId },
      });
      const recommendedRoles = rolesRes.data?.recommendedRoles || [];

      let roleIds: string[] = [];
      if (recommendedRoles.length > 0) {
        roleIds = recommendedRoles.slice(0, 5).map((r: any) => r.id);
      } else {
        const allRolesRes = await api.get(`/roles`, {
          params: { companyId: defaultCompanyId, limit: 5 },
        });
        const allRoles = allRolesRes.data?.data || [];
        roleIds = allRoles.map((r: any) => r.id);
      }

      for (const roleId of roleIds) {
        await api.post(`/meetings/${meeting.id}/participants`, { roleId });
      }

      // 6. 启动会议
      await meetingApi.start(meeting.id);

      // 7. 启动 DiscussionDriver
      await meetingApi.runDiscussion(meeting.id, {
        mode: 'auto',
        topic: command,
        maxRounds: 3,
      });

      // 8. 回调通知
      if (onMeetingCreated) {
        onMeetingCreated(meeting.id);
      }
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
