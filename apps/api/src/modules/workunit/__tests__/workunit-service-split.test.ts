/**
 * #672 结构测试：workunit.service.ts 按职责拆分层（PURE_MOVE）防漂移网。
 *
 * ① 新分层类存在且为 function；② 继承链沿链成立（Service → Review → Lifecycle → Query → Crud）；
 * ③ WorkUnitService 原型链方法面 == 拆分前基线（35 个，采集于拆分前代码，含 TS private——
 *    编译期修饰，运行时仍在原型上）；④ workunit.service.js 模块 value exports == 拆分前基线；
 * ⑤ 职责落位：每层 own property 正好是本层方法（查询派生 / 状态机+统一尾部 / 评审验收）。
 */
import { describe, expect, it } from 'vitest';
import * as serviceModule from '../workunit.service.js';
import { WorkUnitService } from '../workunit.service.js';
import { WorkUnitCrudService } from '../workunit-crud.js';
import { WorkUnitQueryService } from '../workunit-query.js';
import { WorkUnitLifecycleService } from '../workunit-lifecycle.js';
import { WorkUnitReviewService } from '../workunit-review.js';

const BASELINE_METHODS = [
  'aggregateParentStatus', 'blockForAllUnfit', 'blockForManualRelease', 'buildAttestationEntry',
  'checkFileConflicts', 'claim', 'close', 'computeAggregatedStatus', 'create', 'createFromMessage',
  'createGuarded', 'delete', 'expandRoutingHead', 'getById', 'getMessageService', 'inheritParentPmoId',
  'lastDoneByAssignee', 'list', 'markMergeConflict', 'persistSnapshot', 'publishCreated',
  'publishStatusChanged', 'rebindSourceChannel', 'recordL1Verification', 'resolveEventClaimable',
  'reviewPassed', 'reviewRejected', 'transitionStatus', 'unclaim', 'update', 'updateMetadata',
  'verifyManually', 'writeAgentReviewAttestation', 'writeHumanConfirmation', 'writeWorkUnitClosedEvent',
];

const BASELINE_EXPORTS = [
  'ANALYSIS_TASKS_MAX', 'INSPECTION_OPPORTUNITIES_MAX', 'WU_LEASE_TTL_MS',
  'WorkUnitService', 'snapshotToData', 'waitForReviewPassSettled',
];

const ownMethods = (cls: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(cls.prototype).filter(n => n !== 'constructor').sort();

describe('workunit.service 职责拆分层（#672）', () => {
  it('① 新分层类存在且为 function', () => {
    for (const cls of [WorkUnitQueryService, WorkUnitLifecycleService, WorkUnitReviewService]) {
      expect(typeof cls).toBe('function');
    }
  });

  it('② 继承链 instanceof 沿链成立', () => {
    expect(WorkUnitService.prototype).toBeInstanceOf(WorkUnitReviewService);
    expect(WorkUnitReviewService.prototype).toBeInstanceOf(WorkUnitLifecycleService);
    expect(WorkUnitLifecycleService.prototype).toBeInstanceOf(WorkUnitQueryService);
    expect(WorkUnitQueryService.prototype).toBeInstanceOf(WorkUnitCrudService);
  });

  it('③ WorkUnitService 方法面 == 拆分前基线', () => {
    const names: string[] = [];
    let proto = WorkUnitService.prototype;
    while (proto && proto !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(proto)) {
        if (n !== 'constructor') names.push(n);
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect([...new Set(names)].sort()).toEqual(BASELINE_METHODS);
  });

  it('④ workunit.service.js 模块 value exports == 拆分前基线', () => {
    expect(Object.keys(serviceModule).sort()).toEqual(BASELINE_EXPORTS);
  });

  it('⑤ 职责落位：每层 own property 正好是本层方法', () => {
    expect(ownMethods(WorkUnitQueryService)).toEqual([
      'getById', 'lastDoneByAssignee', 'list',
    ]);
    expect(ownMethods(WorkUnitLifecycleService)).toEqual([
      'close', 'persistSnapshot', 'rebindSourceChannel', 'transitionStatus', 'writeWorkUnitClosedEvent',
    ]);
    expect(ownMethods(WorkUnitReviewService)).toEqual([
      'blockForAllUnfit', 'blockForManualRelease', 'buildAttestationEntry', 'markMergeConflict',
      'recordL1Verification', 'reviewPassed', 'reviewRejected', 'verifyManually',
      'writeAgentReviewAttestation', 'writeHumanConfirmation',
    ]);
  });
});
