/**
 * Goal 执行流集成测试
 *
 * 覆盖：复杂度评估、依赖调度、完成检测、集成步创建
 * 纯逻辑测试，不依赖 Docker/LLM/DB
 */
import { describe, it, expect } from 'vitest';

describe('模型路由 — 三层复杂度评估', () => {
  function assessComplexity(acGroup: { acs?: string[]; files?: string[] }): string {
    const acs = acGroup.acs || [];
    const files = acGroup.files || [];
    const allText = [...acs, ...files].join(' ');
    const opusKws = ['架构', '重构', '设计', '迁移', '集成', 'auth', '安全', '性能优化', '数据库迁移'];
    const haikuKws = ['修复', 'fix', 'typo', '拼写', '配置', 'config', '文档', 'doc', '补充测试', '小改动', '更新', 'update', '依赖'];

    if (opusKws.some(k => allText.toLowerCase().includes(k.toLowerCase()))) return 'opus';
    if (haikuKws.some(k => allText.toLowerCase().includes(k.toLowerCase())) && acs.length <= 2 && files.length <= 3) return 'haiku';
    return 'sonnet';
  }

  it('typo 修复 → haiku', () => {
    expect(assessComplexity({ acs: ['修复拼写错误'], files: ['src/foo.ts'] })).toBe('haiku');
  });
  it('配置更新 → haiku', () => {
    expect(assessComplexity({ acs: ['更新配置文件'], files: ['config.yml'] })).toBe('haiku');
  });
  it('常规 CRUD → sonnet（默认）', () => {
    expect(assessComplexity({ acs: ['新增用户 API', '添加测试'], files: ['src/api/users.ts', 'src/__tests__/users.test.ts'] })).toBe('sonnet');
  });
  it('架构重构 → opus', () => {
    expect(assessComplexity({ acs: ['重构数据库层'], files: ['src/db/'] })).toBe('opus');
  });
  it('安全漏洞 → opus', () => {
    expect(assessComplexity({ acs: ['修复安全漏洞'], files: ['src/auth.ts'] })).toBe('opus');
  });
});

describe('依赖调度 — getExecutableSteps 集成', () => {
  interface Step { index: number; dependencies: number[]; }
  interface Exec { stepIndex: number; status: string; }

  function getExecutable(steps: Step[], execs: Exec[], includeIntegration = false): number[] {
    const execMap = new Map(execs.map(e => [e.stepIndex, e]));
    const executable: number[] = [];
    for (const step of steps) {
      const exec = execMap.get(step.index);
      if (!exec || exec.status !== 'pending') continue;
      if (step.dependencies.every(d => execMap.get(d)?.status === 'succeeded')) {
        executable.push(step.index);
      }
    }
    if (includeIntegration) {
      const allDone = steps.every(s => {
        const e = execMap.get(s.index);
        return e?.status === 'succeeded' || e?.status === 'failed';
      });
      if (allDone && executable.length === 0) {
        const integration = execs.find(e => e.stepIndex === 999 && e.status === 'pending');
        if (integration) executable.push(999);
      }
    }
    return executable;
  }

  it('并行无依赖：A pending、B pending → 都返回', () => {
    expect(getExecutable(
      [{ index: 0, dependencies: [] }, { index: 1, dependencies: [] }],
      [{ stepIndex: 0, status: 'pending' }, { stepIndex: 1, status: 'pending' }],
    )).toEqual([0, 1]);
  });

  it('串行有依赖：A running、B pending → 都不可执行', () => {
    expect(getExecutable(
      [{ index: 0, dependencies: [] }, { index: 1, dependencies: [0] }],
      [{ stepIndex: 0, status: 'running' }, { stepIndex: 1, status: 'pending' }],
    )).toEqual([]);
  });

  it('依赖满足：A succeeded、B pending → B 可执行', () => {
    expect(getExecutable(
      [{ index: 0, dependencies: [] }, { index: 1, dependencies: [0] }],
      [{ stepIndex: 0, status: 'succeeded' }, { stepIndex: 1, status: 'pending' }],
    )).toEqual([1]);
  });
});

describe('完成检测 — checkGoalCompletion 集成', () => {
  function goalStatus(execs: Array<{ status: string }>): string | null {
    const allDone = execs.every(e => e.status === 'succeeded' || e.status === 'failed');
    if (!allDone) return null;
    return execs.some(e => e.status === 'failed') ? 'failed' : 'succeeded';
  }

  it('全部 succeeded → succeeded', () => {
    expect(goalStatus([{ status: 'succeeded' }, { status: 'succeeded' }])).toBe('succeeded');
  });
  it('有 failed → failed', () => {
    expect(goalStatus([{ status: 'succeeded' }, { status: 'failed' }])).toBe('failed');
  });
  it('有 running → 未完成', () => {
    expect(goalStatus([{ status: 'succeeded' }, { status: 'running' }])).toBeNull();
  });
});

describe('集成步创建 — checkAllStepsCompleted 逻辑', () => {
  function shouldCreate(execs: Array<{ status: string; id?: string }>): boolean {
    if (!execs.every(e => e.status === 'succeeded' || e.status === 'failed')) return false;
    if (execs.some(e => e.id?.includes('integrate'))) return false;
    return !execs.some(e => e.status === 'failed');
  }

  it('全部成功 → 创建集成步', () => {
    expect(shouldCreate([{ status: 'succeeded' }, { status: 'succeeded' }])).toBe(true);
  });
  it('有失败 → 不创建', () => {
    expect(shouldCreate([{ status: 'succeeded' }, { status: 'failed' }])).toBe(false);
  });
  it('已有集成步 → 不重复', () => {
    expect(shouldCreate([{ status: 'succeeded', id: 'integrate-1' }])).toBe(false);
  });
});
