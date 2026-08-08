// harnessApi — /harness/* 质量门：端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));
vi.mock('../index', () => ({ api: { post: mockPost } }));

import { harnessApi } from '../harness';

describe('harnessApi（M2 质量门）', () => {
  it('checkConstraints → POST /harness/check-constraints（RequirementsDoc 执行前确认）', () => {
    const payload = {
      operation: 'goal_creation',
      taskDescription: '需求内容截断 500 字',
      hasRequirement: true,
      hasRequirementReview: true,
      projectPath: '/root/projects/studio',
    };
    harnessApi.checkConstraints(payload);
    expect(mockPost).toHaveBeenCalledWith('/harness/check-constraints', payload);
  });
});
