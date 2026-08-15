/**
 * E2E Lifecycle Test — 3.28c-6
 *
 * 验证完整 WorkUnit 生命周期：
 * Trigger → Create → Visible → Claim → Skill → Execute → Discuss → Done
 *
 * AC1: Trigger 触发后 WorkUnit 自动创建
 * AC2: Agent 读 Channel 能看到 WorkUnit
 * AC3: Agent claim WorkUnit 成功
 * AC4: claim 不再触发 skill 加载（决策 7：匹配挪到 agent-loop step 时）
 * AC5: 执行结果写入 Channel（workUnitId 关联）
 * AC6: WorkUnit 状态流转到 done
 * AC7: 讨论空间可查询（GET /workunits/:id/messages）
 * AC8: 完整流程日志可追踪
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStore } from '@dommaker/studio-shared';
import { TriggerStore } from '../../triggers/trigger-store.js';
import { executeCreateAction, setTriggerActionFileStore } from '../../triggers/trigger-action.js';
import { WorkUnitService } from '../workunit.service.js';
import { channelMessageService } from '../../channels/channel-message.service.js';
import { selectSkills } from '../../skills/skill-selector.js';
import type { TriggerConfig } from '../../triggers/trigger.types.js';
import type { SkillEntry } from '../../skills/manifest-loader.js';

// ── Mocks ──
// vi.hoisted() ensures mock refs are available inside hoisted vi.mock factories
const { mockLoadManifest, mockLoadSkill } = vi.hoisted(() => {
  return {
    mockLoadManifest: vi.fn(),
    mockLoadSkill: vi.fn().mockResolvedValue(null),
  };
});

// Mock manifest-loader: return controlled test skills
vi.mock('../../skills/manifest-loader.js', () => ({
  loadManifest: mockLoadManifest,
  getSkillFilePath: vi.fn(() => '/tmp/test/SKILL.md'),
  invalidateManifestCache: vi.fn(),
}));

// Mock skill-loader: track loadSkill calls
vi.mock('../../skills/skill-loader.js', () => ({
  skillLoaderService: {
    loadSkill: mockLoadSkill,
  },
}));

const TEST_SKILLS: SkillEntry[] = [
  { name: 'session-analyst', path: 'session-analyst/SKILL.md', description: '需求分析、产出 spec/SDD、AC 形式化' },
  { name: 'code-review', path: 'code-review/SKILL.md', description: '代码审查、多维度质量检查' },
  { name: 'tdd-red', path: 'tdd-red/SKILL.md', description: '测试契约设计、RED 阶段' },
];

describe('WorkUnit E2E Lifecycle (3.28c-6)', () => {
  let workUnitService: WorkUnitService;
  let testChannelId: string;
  let tmpDir: string;
  let triggerDir: string;
  let triggerStore: TriggerStore;
  let workUnitId: string;
  let fileStore: FileStore;
  const messageIds: string[] = [];
  const triggerId = 'e2e-lifecycle-trigger';

  beforeAll(async () => {
    // Temp FileStore — 不触碰默认 ~/.studio/data（本机可能有运行中的 server 并发写）
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lifecycle-'));
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    // trigger-action / channelMessageService 的模块级单例同样注入 tmp store
    setTriggerActionFileStore(fileStore);
    channelMessageService.setFileStore(fileStore);

    // 1. Create test Channel in FileStore (for message ops)
    const channelName = `#e2e-lifecycle-${Date.now()}`;
    testChannelId = `e2e-ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fileStore.createChannel({
      id: testChannelId,
      name: channelName,
      type: 'rnd',
      defaultWorkspaceId: null,
      defaultPath: null,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 2. Temp directory for trigger YAML
    triggerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-triggers-'));
    triggerStore = new TriggerStore(triggerDir);

    // 3. Configure mock: manifest returns test skills
    mockLoadManifest.mockReturnValue(TEST_SKILLS);
  });

  afterAll(async () => {
    // Cleanup: temp dirs (workunits/channels live under tmpDir)
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    // Cleanup: temp trigger dir
    if (triggerDir) {
      fs.rmSync(triggerDir, { recursive: true, force: true });
    }
  });

  // ── AC1: Trigger 触发后 WorkUnit 自动创建 ──
  it('AC1: Trigger 触发后 WorkUnit 自动创建', async () => {
    const triggerConfig: TriggerConfig = {
      id: triggerId,
      name: 'E2E Test Trigger',
      condition: { type: 'SCHEDULE', cron: '0 0 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'task',
          scope: '需求分析：验证 E2E 流程',
          channelId: testChannelId,
        },
      },
      enabled: true,
      scope: 'system',
    };

    // Write trigger YAML
    triggerStore.save(triggerConfig);

    // Verify saved
    const saved = triggerStore.get(triggerId);
    expect(saved).toBeDefined();
    expect(saved!.id).toBe(triggerId);

    // Execute trigger action (simulates scheduler firing)
    const result = await executeCreateAction(saved!.action, triggerId);
    workUnitId = result.id;

    expect(result.id).toBeDefined();
    expect(result.type).toBe('task');
    expect(result.scope).toBe('需求分析：验证 E2E 流程');
    // #126：task 未显式 status 默认落 pending（待确认人工门）；trigger 链路不透传 status，
    // 确认（pending → unassigned）后才进入可认领任务池，后续 AC 走认领流
    expect(result.status).toBe('pending');
    await workUnitService.transitionStatus(workUnitId, 'unassigned');
    expect(result.channelId).toBe(testChannelId);

    // Metadata has trigger traceability
    const meta = JSON.parse(result.metadata!);
    expect(meta.triggerId).toBe(triggerId);
    expect(meta.triggerSource).toBe('trigger-registry');
    expect(meta.triggeredAt).toBeDefined();
  });

  // ── AC2: Agent 读 Channel 能看到 WorkUnit ──
  it('AC2: Agent 读 Channel 能看到 WorkUnit', async () => {
    const { data, total } = await workUnitService.list({
      channelId: testChannelId,
    });

    expect(total).toBeGreaterThanOrEqual(1);
    const found = data.find(wu => wu.id === workUnitId);
    expect(found).toBeDefined();
    expect(found!.channelId).toBe(testChannelId);
    expect(found!.status).toBe('unassigned');
  });

  // ── AC3: Agent claim WorkUnit 成功 ──
  it('AC3: Agent claim WorkUnit 成功', async () => {
    const agentId = 'agent-executor-1';
    const claimed = await workUnitService.claim(workUnitId, agentId);

    expect(claimed.assigneeId).toBe(agentId);
    expect(claimed.status).toBe('active');
    expect(claimed.claimedAt).not.toBeNull();
  });

  // ── AC4 → 决策 7: claim 不再自动加载 Skill（匹配挪到 agent-loop step 时） ──
  it('AC4: claim 不触发 skill 加载，匹配器在 step 时独立可用', async () => {
    // 旧行为是 claim 后 fire-and-forget 加载 —— 留出时间窗证明其不再发生
    await new Promise(r => setTimeout(r, 200));

    // claim 路径不再调用 skillLoaderService.loadSkill
    expect(mockLoadSkill).not.toHaveBeenCalled();

    // 匹配器本身仍可用：scope "需求分析" 命中 session-analyst（step 时由 agent-loop 调用）
    const matched = selectSkills('需求分析：验证 E2E 流程', TEST_SKILLS);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched.some(s => s.name === 'session-analyst')).toBe(true);
  });

  // ── AC5: 执行结果写入 Channel（workUnitId 关联） ──
  it('AC5: 执行结果写入 Channel（workUnitId 关联）', async () => {
    const msg = await channelMessageService.createAgentMessage(
      testChannelId,
      'Executor',
      '执行完成：E2E 流程验证通过',
      { workUnitId },
    );
    messageIds.push(msg.id);

    expect(msg.workUnitId).toBe(workUnitId);
    expect(msg.channelId).toBe(testChannelId);
    expect(msg.content).toBe('执行完成：E2E 流程验证通过');
    expect(msg.authorType).toBe('agent');
    expect(msg.agentName).toBe('Executor');
  });

  // ── AC6: WorkUnit 状态流转到 done ──
  it('AC6: WorkUnit 状态流转到 done', async () => {
    // active → in_review
    const inReview = await workUnitService.transitionStatus(workUnitId, 'in_review');
    expect(inReview.status).toBe('in_review');

    // in_review → done
    const done = await workUnitService.transitionStatus(workUnitId, 'done');
    expect(done.status).toBe('done');
  });

  // ── AC7: 讨论空间可查询 ──
  it('AC7: 讨论空间可查询（listByWorkUnitId）', async () => {
    // Add a human message to the discussion space
    const humanMsg = await channelMessageService.createHumanMessage(
      testChannelId,
      '请处理这个需求',
      undefined,
      workUnitId,
    );
    messageIds.push(humanMsg.id);

    const result = await channelMessageService.listByWorkUnitId(workUnitId);

    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.data.every(m => m.workUnitId === workUnitId)).toBe(true);
    // Chronological order
    for (let i = 1; i < result.data.length; i++) {
      expect(result.data[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        result.data[i - 1].createdAt.getTime(),
      );
    }
  });

  // ── AC8: 完整流程日志可追踪 ──
  it('AC8: 完整流程日志可追踪', async () => {
    // Verify WorkUnit final state
    const wu = await workUnitService.getById(workUnitId);
    expect(wu).not.toBeNull();
    expect(wu!.id).toBe(workUnitId);
    expect(wu!.status).toBe('done');
    expect(wu!.assigneeId).toBe('agent-executor-1');
    expect(wu!.channelId).toBe(testChannelId);

    // Verify metadata has trigger traceability
    const meta = JSON.parse(wu!.metadata!);
    expect(meta.triggerId).toBe(triggerId);
    expect(meta.triggerSource).toBe('trigger-registry');
    expect(meta.triggeredAt).toBeDefined();

    // Verify messages linked to WorkUnit
    const messages = await channelMessageService.listByWorkUnitId(workUnitId);
    expect(messages.total).toBeGreaterThanOrEqual(2);

    // Verify trigger YAML exists for audit trail
    const trigger = triggerStore.get(triggerId);
    expect(trigger).toBeDefined();
    expect(trigger!.action.payload.scope).toBe(wu!.scope);
  });
});
