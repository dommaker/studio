/**
 * constraints.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * mock @dommaker/harness（getEffectiveConstraints + checkConstraints），
 * 挂载 constraintsRoutes 覆盖：GET /constraints、GET /constraints/stats、
 * GET /constraints/retired、GET /constraints/:id、POST rollback（#646 起 spawn 真实
 * harness `constraints reactivate` CLI——种子 = constraints.yml 应用层约束 + config.yml
 * retired 墓碑；applier.runCmd 包 vi.fn 以便单测注入 CLI 失败）、POST /check-constraints。
 * beforeAll chdir 到临时目录隔离 .harness/；HOME 同样指向临时目录隔离 knowledge 落盘链路。
 * 注：degrade/schedule 端点及 ConstraintRegistry mock 已随 harness 0.17.0 移除（ADR-0001 决策 8）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

const { mockCreateCardMessage, checkConstraintsCalls, mockRunCmd } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn(),
  checkConstraintsCalls: [] as Array<Record<string, unknown>>,
  mockRunCmd: vi.fn(),
}));

// propose-upgrade 端点建卡走 review-proposal 正本发卡（ADR-0033 子项 8）
vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage, createAgentMessage: vi.fn() },
}));

// #646：rollback spawn 真实 CLI；runCmd 包一层 vi.fn 供「CLI 不可用 → 500」用例注入失败
vi.mock('../../evolution/applier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../evolution/applier.js')>();
  mockRunCmd.mockImplementation(actual.runCmd);
  return { ...actual, runCmd: mockRunCmd };
});

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  const store = [
    { id: 'c-safe', kind: 'check', severity: 'error', rule: 'R1', message: 'm1', trigger: 'code_implementation', enforcement: 'test' },
    { id: 'c-quality', kind: 'check', severity: 'warning', rule: 'R2', message: 'm2', trigger: 'code_implementation', enforcement: 'custom' },
  ];
  return {
    ...actual,
    getEffectiveConstraints: () => store,
    checkConstraints: async (opts: { operation: string }) => {
      checkConstraintsCalls.push(opts as Record<string, unknown>);
      return { passed: true, operation: opts.operation, violations: [] };
    },
  };
});

let tmpHome: string;
let prevHome: string | undefined;
let prevCwd: string;
let server: Server;
let base: string;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function seedConfig(content: string): void {
  const dir = path.join(process.cwd(), '.harness');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yml'), content, 'utf-8');
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-constraints-routes-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  prevCwd = process.cwd();
  process.chdir(tmpHome);

  const { constraintsRoutes } = await import('../constraints.routes.js');
  // 子项 8：propose-upgrade 需要 constraint adapter 已注册（生产 = EvolutionService 构造注册）
  const { FileStore } = await import('@dommaker/studio-shared');
  const { registerConstraintReviewAdapter } = await import('../../evolution/constraint-adapter.js');
  const fileStore = new FileStore(tmpHome);
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-sys', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  registerConstraintReviewAdapter({ fileStore, dataDir: tmpHome });
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/harness', constraintsRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/harness`;
});

afterAll(async () => {
  const { clearReviewProposalAdapters } = await import('../../review-proposal/registry.js');
  clearReviewProposalAdapters();
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('constraints.routes', () => {
  it('GET /constraints lists effective set with kind', async () => {
    const res = await api('GET', '/constraints');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(res.json.data.map((c: any) => c.id).sort()).toEqual(['c-quality', 'c-safe']);
    expect(res.json.data[0]).toHaveProperty('kind');
  });

  it('GET /constraints/stats aggregates by kind/severity (not shadowed by /:id)', async () => {
    const res = await api('GET', '/constraints/stats');
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({
      total: 2,
      byKind: { check: 2 },
      bySeverity: { error: 1, warning: 1 },
    });
  });

  it('GET /constraints/retired returns [] without config.yml', async () => {
    const res = await api('GET', '/constraints/retired');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: [], total: 0 });
  });

  it('GET /constraints/retired lists retired metadata from config.yml', async () => {
    seedConfig([
      'constraints:',
      '  c-old:',
      '    enabled: false',
      '    retired:',
      '      at: "2026-08-01T00:00:00.000Z"',
      '      reason: "zero trigger"',
      '      stats: { total: 0, fail: 0, failRate: 0 }',
      '  c-active:',
      '    enabled: true',
      '',
    ].join('\n'));
    const res = await api('GET', '/constraints/retired');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(1);
    expect(res.json.data[0].id).toBe('c-old');
    expect(res.json.data[0].source).toBe('config');
    expect(res.json.data[0].retired.reason).toBe('zero trigger');
    fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
  });

  it('GET /constraints/:id 200 / 404', async () => {
    const ok = await api('GET', '/constraints/c-quality');
    expect(ok.status).toBe(200);
    expect(ok.json.data.id).toBe('c-quality');
    const miss = await api('GET', '/constraints/nope');
    expect(miss.status).toBe(404);
    expect(miss.json.error).toBe('Constraint not found');
  });

  it('POST /constraints/:id/rollback 404 without config.yml entry', async () => {
    const miss = await api('POST', '/constraints/nope/rollback', {});
    expect(miss.status).toBe(404);
  });

  it('POST /constraints/:id/rollback 404 on bare disable（无 retired 墓碑，#646 新口径）', async () => {
    seedConfig([
      'constraints:',
      '  c-disabled:',
      '    enabled: false',
      '',
    ].join('\n'));
    const res = await api('POST', '/constraints/c-disabled/rollback', {});
    expect(res.status).toBe(404);
    // 裸 disable 条目不被 rollback 动（写操作只走 harness CLI）
    const written = fs.readFileSync(path.join(process.cwd(), '.harness', 'config.yml'), 'utf-8');
    expect(written).toContain('c-disabled');
    fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
  });

  it('POST /constraints/:id/rollback reactivates via harness CLI（真实 spawn，#646）', async () => {
    // 种子：constraints.yml 应用层约束（discipline 通道免 checker）+ config.yml retired 墓碑
    fs.mkdirSync(path.join(process.cwd(), '.harness'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), '.harness', 'constraints.yml'), yaml.dump({
      constraints: [{ id: 'app_rb_target', rule: '回滚测试约束', severity: 'warning', channel: 'discipline' }],
    }), 'utf-8');
    seedConfig([
      'constraints:',
      '  app_rb_target:',
      '    enabled: false',
      '    retired: { at: "2026-08-01T00:00:00.000Z", reason: "r", stats: { total: 0, fail: 0, failRate: 0 } }',
      'scenes: []',
      '',
    ].join('\n'));
    const ok = await api('POST', '/constraints/app_rb_target/rollback', {});
    expect(ok.status).toBe(200);
    expect(ok.json.rolledBack).toBe(true);
    // app_rb_target 不在 mock 生效集中 → data 为 null
    expect(ok.json.data).toBeNull();
    // CLI 已删 config.yml 墓碑段；constraints.yml 应用层条目不动
    const written = fs.readFileSync(path.join(process.cwd(), '.harness', 'config.yml'), 'utf-8');
    expect(written).not.toContain('app_rb_target');
    expect(written).toContain('scenes');
    expect(fs.readFileSync(path.join(process.cwd(), '.harness', 'constraints.yml'), 'utf-8')).toContain('app_rb_target');
    fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
  });

  it('POST /constraints/:id/rollback 500 when harness CLI fails', async () => {
    fs.mkdirSync(path.join(process.cwd(), '.harness'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), '.harness', 'constraints.yml'), yaml.dump({
      constraints: [{ id: 'app_rb_fail', rule: '回滚失败测试约束', severity: 'warning', channel: 'discipline' }],
    }), 'utf-8');
    seedConfig([
      'constraints:',
      '  app_rb_fail:',
      '    enabled: false',
      '    retired: { at: "2026-08-01T00:00:00.000Z", reason: "r", stats: { total: 0, fail: 0, failRate: 0 } }',
      '',
    ].join('\n'));
    mockRunCmd.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom' });
    const res = await api('POST', '/constraints/app_rb_fail/rollback', {});
    expect(res.status).toBe(500);
    // CLI 失败不留半状态：墓碑仍在
    const written = fs.readFileSync(path.join(process.cwd(), '.harness', 'config.yml'), 'utf-8');
    expect(written).toContain('app_rb_fail');
    fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
  });

  it('POST /check-constraints 400 without operation / 200 with', async () => {
    const bad = await api('POST', '/check-constraints', {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('operation is required');

    const ok = await api('POST', '/check-constraints', { operation: 'create-requirement' });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual({ passed: true, operation: 'create-requirement', violations: [] });
  });

  it('POST /check-constraints 剥离请求体自报的 hasRequirement（#641），响应标注降级', async () => {
    const res = await api('POST', '/check-constraints', { operation: 'create-requirement', hasRequirement: true });
    expect(res.status).toBe(200);
    const received = checkConstraintsCalls.at(-1) ?? {};
    expect(received.hasRequirement).toBeUndefined();
    expect(received.operation).toBe('create-requirement');
    expect(res.json.strippedEvidenceFlags).toEqual(['hasRequirement']);
  });

  describe('POST /constraints/propose-upgrade（ADR-0033 子项 8）', () => {
    it('400：缺 constraintId / 非法字符；400：repoRoot 不存在', async () => {
      const missing = await api('POST', '/constraints/propose-upgrade', {});
      expect(missing.status).toBe(400);

      const badId = await api('POST', '/constraints/propose-upgrade', { constraintId: '../etc' });
      expect(badId.status).toBe(400);

      const badRoot = await api('POST', '/constraints/propose-upgrade', {
        constraintId: 'app_x', repoRoot: '/no/such/dir',
      });
      expect(badRoot.status).toBe(400);
      expect(badRoot.json.error).toContain('invalid repoRoot');
    });

    it('404：constraints.yml 无该条目（非应用层约束）', async () => {
      const res = await api('POST', '/constraints/propose-upgrade', { constraintId: 'app_nope' });
      expect(res.status).toBe(404);
      expect(res.json.error).toContain('not-an-app-constraint');
    });

    it('200：校验通过 → 建 constraint 卡（action=upgrade，带统计白话）并发 #系统', async () => {
      fs.mkdirSync(path.join(process.cwd(), '.harness'), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), '.harness', 'constraints.yml'), yaml.dump({
        constraints: [{
          id: 'app_no_internal_url', rule: '前端代码不得出现内网地址', checker: 'regex-scan',
          params: { pattern: 'https?://10\\.\\d+\\.' }, severity: 'warning', message: '检测到内网地址',
        }],
      }), 'utf-8');

      const res = await api('POST', '/constraints/propose-upgrade', { constraintId: 'app_no_internal_url' });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.data.proposalId).toBeTruthy();
      expect(res.json.data.posted).toBe(true);

      // 发卡：constraint_proposal 卡，cardData 带 proposalId/action
      const call = mockCreateCardMessage.mock.calls.find(
        c => (c[4] as { proposalId?: string })?.proposalId === res.json.data.proposalId,
      );
      expect(call).toBeTruthy();
      expect(call![3]).toBe('constraint_proposal');
      const cardData = call![4] as { action: string; constraintId: string };
      expect(cardData.action).toBe('upgrade');
      expect(cardData.constraintId).toBe('app_no_internal_url');
      // 卡正文：条文 + 统计白话（零记录口径）
      expect(String(call![2])).toContain('约束升级提案');
      expect(String(call![2])).toContain('没有任何触发记录');

      fs.rmSync(path.join(process.cwd(), '.harness'), { recursive: true, force: true });
    });
  });
});
