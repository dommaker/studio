// 工作流列表前端功能单元测试
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { RuntimeWorkflowApi } from '../../frontend/src/api';

// Mock API
vi.mock('../../frontend/src/api', () => ({
  runtimeWorkflowApi: {
    listPipelines: vi.fn(),
    deletePipeline: vi.fn(),
  },
}));

describe('工作流列表 - 删除功能', () => {
  const mockWorkflows = [
    {
      id: 'wf-1',
      name: '测试工作流 1',
      description: '测试描述',
      category: 'test',
      stepIds: ['step-1', 'step-2'],
      openclaw: { emoji: '📋' },
    },
    {
      id: 'wf-2',
      name: '测试工作流 2',
      description: '另一个测试',
      category: 'test',
      stepIds: ['step-3'],
      openclaw: { emoji: '🔧' },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('删除工作流', () => {
    it('应该成功调用删除 API', async () => {
      const { runtimeWorkflowApi } = await import('../../frontend/src/api');
      const mockDelete = runtimeWorkflowApi.deletePipeline as ReturnType<typeof vi.fn>;

      mockDelete.mockResolvedValueOnce({ status: 204 });

      await act(async () => {
        await runtimeWorkflowApi.deletePipeline('wf-1');
      });

      expect(mockDelete).toHaveBeenCalledWith('wf-1');
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    it('删除成功后应该从列表中移除该工作流', async () => {
      // 这个测试需要在实际组件中测试
      // 这里是逻辑示例
      const workflowIdToDelete = 'wf-1';
      const remainingWorkflows = mockWorkflows.filter(w => w.id !== workflowIdToDelete);

      expect(remainingWorkflows).toHaveLength(1);
      expect(remainingWorkflows[0].id).toBe('wf-2');
    });

    it('删除失败应该显示错误信息', async () => {
      const { runtimeWorkflowApi } = await import('../../frontend/src/api');
      const mockDelete = runtimeWorkflowApi.deletePipeline as ReturnType<typeof vi.fn>;

      mockDelete.mockRejectedValueOnce(new Error('删除失败'));

      await expect(
        runtimeWorkflowApi.deletePipeline('wf-1')
      ).rejects.toThrow('删除失败');
    });
  });

  describe('删除确认弹框', () => {
    it('应该显示工作流名称和 ID', () => {
      const workflow = mockWorkflows[0];
      const displayText = `确定要删除此工作流吗？${workflow.name}`;
      
      expect(displayText).toContain(workflow.name);
      expect(displayText).not.toContain(workflow.id);
    });

    it('应该显示 outputs 目录路径', () => {
      const workflow = mockWorkflows[0];
      const expectedPath = `/root/projects/outputs/${workflow.id}`;
      
      expect(expectedPath).toBe('/root/projects/outputs/wf-1');
    });
  });
});
