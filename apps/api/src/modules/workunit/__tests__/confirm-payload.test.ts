// #463：review-passed 结构化 confirm body（确认表单 → 后端序列化为 l3.summary，存储契约不变）。
// 三段覆盖：resolveReviewConfirm 纯函数（校验+序列化）/ 序列化↔解析 roundtrip（契约单一来源
// 互证）/ WorkUnitService.reviewPassed options.analysisTasks 覆写 metadata.analysisTasks。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';
import { parseSpecTasks } from '../../pmo/spec-materialization.js';
import { parseMapOpening } from '../../pmo/map-opening.js';
import { resolveReviewConfirm } from '../confirm-payload.js';

describe('#463 resolveReviewConfirm（确认表单 → l3.summary 序列化）', () => {
  it('confirm 缺省/null → 空决议（裸 summary 路径不受影响）', () => {
    expect(resolveReviewConfirm(undefined)).toEqual({});
    expect(resolveReviewConfirm(null)).toEqual({});
  });

  it('confirm 非对象 / kind 未知 → 抛错（路由转 400）', () => {
    expect(() => resolveReviewConfirm('x')).toThrow();
    expect(() => resolveReviewConfirm({ kind: 'task' })).toThrow();
  });

  it('decision：结论原文 → summary；空白结论 → 不带 summary（兼容旧一键通过）', () => {
    expect(resolveReviewConfirm({ kind: 'decision', conclusion: ' 选型用 SQLite ' }))
      .toEqual({ summary: '选型用 SQLite' });
    expect(resolveReviewConfirm({ kind: 'decision', conclusion: '  ' })).toEqual({});
    expect(resolveReviewConfirm({ kind: 'decision' })).toEqual({});
    expect(() => resolveReviewConfirm({ kind: 'decision', conclusion: 42 })).toThrow();
  });

  it('spec：tasks 序列化为 TASK 物化行（AC 多段 / BLOCKEDBY / LEG），与 parseSpecTasks roundtrip', () => {
    const r = resolveReviewConfirm({
      kind: 'spec',
      tasks: [
        { title: '实现存储层', ac: ['单测覆盖', '通过 typecheck'], blockedBy: ['wu-1', 'wu-2'] },
        { title: '接通派工', leg: 'dommaker/studio' },
      ],
    });
    expect(r.summary).toBe(
      'TASK: 实现存储层 | AC: 单测覆盖 | AC: 通过 typecheck | BLOCKEDBY: wu-1,wu-2\n'
      + 'TASK: 接通派工 | LEG: dommaker/studio',
    );
    // roundtrip：序列化产物必须被物化解析器原样吃回（契约单一来源互证）
    expect(parseSpecTasks(r.summary!)).toEqual([
      { title: '实现存储层', ac: ['单测覆盖', '通过 typecheck'], blockedBy: ['wu-1', 'wu-2'] },
      { title: '接通派工', ac: [], blockedBy: [], leg: 'dommaker/studio' },
    ]);
  });

  it('spec：空清单 / 全空标题 → 不带 summary（人审有意不物化，哨兵不落档可补确认）', () => {
    expect(resolveReviewConfirm({ kind: 'spec', tasks: [] })).toEqual({});
    expect(resolveReviewConfirm({ kind: 'spec', tasks: [{ title: '  ' }] })).toEqual({});
    expect(() => resolveReviewConfirm({ kind: 'spec', tasks: 'x' })).toThrow();
    expect(() => resolveReviewConfirm({ kind: 'spec', tasks: [{ ac: ['缺标题'] }] })).toThrow();
  });

  it('analysis：destination+fog → 目标：/待决：行（与 parseMapOpening roundtrip）；tasks → analysisTasks', () => {
    const r = resolveReviewConfirm({
      kind: 'analysis',
      destination: '三仓联动上线',
      fog: ['存储选型？', '部署形态？'],
      tasks: ['实现存储层', ' ', '接通派工'],
    });
    expect(r.summary).toBe('目标：三仓联动上线\n待决：存储选型？\n待决：部署形态？');
    expect(r.analysisTasks).toEqual(['实现存储层', '接通派工']);
    // roundtrip：开图解析器吃回序列化产物
    expect(parseMapOpening(r.summary!)).toEqual({ destination: '三仓联动上线', fog: ['存储选型？', '部署形态？'] });
  });

  it('analysis：fog 空 → 不带 summary（不开图直接派工）；tasks 缺省 → 不覆写 analysisTasks', () => {
    expect(resolveReviewConfirm({ kind: 'analysis', fog: [], tasks: ['干活'] }))
      .toEqual({ analysisTasks: ['干活'] });
    expect(resolveReviewConfirm({ kind: 'analysis' })).toEqual({});
  });
});

describe('#463 reviewPassed options.analysisTasks（人审编辑后的 TASK 清单覆写落档）', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-confirm-'));
    fileStore = new FileStore(tmpDir);
    wuService = new WorkUnitService(fileStore);
    eventBus.unsubscribeAll?.('workunit.status_changed');
  });

  afterEach(() => {
    eventBus.unsubscribeAll?.('workunit.status_changed');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analysis 确认带 analysisTasks → 覆写 metadata.analysisTasks（analysis-handoff 消费人审后清单）', async () => {
    const wu = await wuService.create({
      scope: '分析需求', type: 'analysis', status: 'active',
      metadata: { analysisTasks: ['agent 拆的 1', 'agent 拆的 2'] },
    });
    await wuService.transitionStatus(wu.id, 'in_review');
    await wuService.reviewPassed(wu.id, { by: 'human', kind: 'human-confirm', summary: '待决：问题？' }, {
      analysisTasks: ['人审改后的唯一任务'],
    });

    const meta = JSON.parse((await wuService.getById(wu.id))!.metadata!) as WorkUnitMetadata;
    expect(meta.analysisTasks).toEqual(['人审改后的唯一任务']);
    expect(meta.attestations?.l3?.summary).toBe('待决：问题？');
  });

  it('options.analysisTasks 缺省 → 不动 metadata.analysisTasks（兼容旧路径）', async () => {
    const wu = await wuService.create({
      scope: '分析需求', type: 'analysis', status: 'active',
      metadata: { analysisTasks: ['agent 拆的'] },
    });
    await wuService.transitionStatus(wu.id, 'in_review');
    await wuService.reviewPassed(wu.id, { by: 'human', kind: 'human-confirm' });

    const meta = JSON.parse((await wuService.getById(wu.id))!.metadata!) as WorkUnitMetadata;
    expect(meta.analysisTasks).toEqual(['agent 拆的']);
  });
});
