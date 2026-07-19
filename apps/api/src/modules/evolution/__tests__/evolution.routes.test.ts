/**
 * Evolution API 路由测试（E1 约束进化）。
 *
 * 挂载 createEvolutionRoutes(tmpService) 到 express app，验证：
 *   GET /proposals（status 过滤）、GET /proposals/:id（404）、
 *   POST /proposals/:id/approve（生效 + 409 重复决策）、
 *   POST /proposals/:id/reject（理由 + 409）、POST /run（手动触发扫描）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, formatEvolutionId, type EvolutionProposalData } from '@dommaker/studio-shared';
import { ChannelMessageService } from '../../channels/channel-message.service';
import { EvolutionService } from '../evolution.service';
import { createEvolutionRoutes } from '../evolution.routes';
import { resolveEvolutionPaths } from '../signals';

let tmpDir: string;
let fileStore: FileStore;
let server: Server;
let base: string;
let prevEnv: string | undefined;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function seedProposal(patch?: Partial<EvolutionProposalData>): Promise<EvolutionProposalData> {
  const seq = await fileStore.allocateEvolutionSeq();
  const p: EvolutionProposalData = {
    id: formatEvolutionId(seq),
    seq,
    targetType: 'prompt-template',
    targetId: 'knowledge.rules-section',
    action: 'amend',
    currentText: '## 系统约束\n{content}',
    proposedText: '## 系统约束（强制）\n{content}',
    rationale: '测试',
    evidence: { windowHours: 24, eventCounts: { outcomes: 8, failures: 6 } },
    status: 'pending',
    source: 'heuristic:prompt-failure',
    createdAt: new Date().toISOString(),
    ...patch,
  };
  await fileStore.createEvolutionProposal(p);
  return p;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-routes-test-'));
  fileStore = new FileStore(tmpDir);
  prevEnv = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(tmpDir, 'prompt-overrides');

  const service = new EvolutionService({
    fileStore,
    paths: resolveEvolutionPaths({
      repoRoot: tmpDir,
      eventsDir: path.join(tmpDir, 'events'),
      studioEventsFile: path.join(tmpDir, 'studio-events.jsonl'),
    }),
    messageService: new ChannelMessageService(fileStore),
    postToChannel: false,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/evolution', createEvolutionRoutes(service));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
  });

  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1/evolution`;
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevEnv;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Evolution API (E1)', () => {
  it('GET /proposals lists with status filter', async () => {
    await seedProposal();
    await seedProposal({ status: 'rejected' });

    const all = await api('GET', '/proposals');
    expect(all.status).toBe(200);
    expect(all.json.success).toBe(true);
    expect(all.json.data.length).toBe(2);

    const pending = await api('GET', '/proposals?status=pending');
    expect(pending.json.data.length).toBe(1);
    expect(pending.json.data[0].status).toBe('pending');

    const byType = await api('GET', '/proposals?targetType=role-preset');
    expect(byType.json.data.length).toBe(0);
  });

  it('GET /proposals/:id returns one, 404 for unknown', async () => {
    const p = await seedProposal();
    const found = await api('GET', `/proposals/${p.id}`);
    expect(found.status).toBe(200);
    expect(found.json.data.id).toBe(p.id);

    const missing = await api('GET', '/proposals/EP-9999');
    expect(missing.status).toBe(404);
    expect(missing.json.success).toBe(false);
  });

  it('POST /proposals/:id/approve applies (override file written) and second approve → 409', async () => {
    const p = await seedProposal();
    const approved = await api('POST', `/proposals/${p.id}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.json.data.status).toBe('applied');
    expect(approved.json.data.appliedAt).toBeTruthy();
    expect(approved.json.data.decidedBy).toContain('api:');

    // prompt-override 文件已写入
    const overrideFile = path.join(tmpDir, 'prompt-overrides', 'knowledge.rules-section.md');
    expect(fs.readFileSync(overrideFile, 'utf-8')).toBe('## 系统约束（强制）\n{content}');

    const again = await api('POST', `/proposals/${p.id}/approve`, {});
    expect(again.status).toBe(409);
    const rejected = await api('POST', `/proposals/${p.id}/reject`, {});
    expect(rejected.status).toBe(409);
  });

  it('POST /proposals/:id/reject marks rejected with reason; later approve → 409', async () => {
    const p = await seedProposal();
    const rejected = await api('POST', `/proposals/${p.id}/reject`, { reason: '不需要' });
    expect(rejected.status).toBe(200);
    expect(rejected.json.data.status).toBe('rejected');
    expect(rejected.json.data.rejectReason).toBe('不需要');

    const approve = await api('POST', `/proposals/${p.id}/approve`, {});
    expect(approve.status).toBe(409);
  });

  it('POST /proposals/:id/approve 404 for unknown id', async () => {
    const res = await api('POST', '/proposals/EP-9999/approve', {});
    expect(res.status).toBe(404);
  });

  it('POST /run triggers a scan and reports created proposals', async () => {
    // 清场：先拒掉前面用例遗留的 pending 提案（同目标会被去重 open-exists）
    const leftover = await api('GET', '/proposals?status=pending');
    for (const p of leftover.json.data) {
      await api('POST', `/proposals/${p.id}/reject`, { reason: '清场' });
    }

    // heuristic (b) fixture：6 失败（3 注入）+ 2 成功
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ success: false, consumedKnowledge: [`k${i}`] })),
      ...Array.from({ length: 3 }, () => ({ success: false, consumedKnowledge: [] })),
      ...Array.from({ length: 2 }, () => ({ success: true, consumedKnowledge: [] })),
    ].map(o => ({
      type: `knowledge:outcome:${o.success ? 'success' : 'failure'}`,
      payload: JSON.stringify(o),
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(tmpDir, 'studio-events.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const run = await api('POST', '/run');
    expect(run.status).toBe(200);
    expect(run.json.success).toBe(true);
    expect(run.json.data.created.length).toBe(1);
    expect(run.json.data.created[0].targetType).toBe('prompt-template');
    expect(run.json.data.scanned.outcomes).toBe(8);

    // 生成的提案出现在列表里
    const list = await api('GET', '/proposals?status=pending');
    expect(list.json.data.some((p: any) => p.id === run.json.data.created[0].id)).toBe(true);
  });
});
