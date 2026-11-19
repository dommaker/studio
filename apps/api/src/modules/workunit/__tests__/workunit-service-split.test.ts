/** ARCH-05：组合不继承，facade 不公开 owner 或内部写口，依赖接口只含实际用例。 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as serviceModule from '../workunit-review.js';
import { WorkUnitService } from '../workunit-review.js';
import { WorkUnitCrudService } from '../workunit-crud.js';
import { WorkUnitQueryService } from '../workunit-query.js';
import { WorkUnitLifecycleService } from '../workunit-lifecycle.js';
import { WorkUnitReviewService } from '../workunit-review.js';

const PUBLIC_METHODS = [
  'aggregateParentStatus', 'authorizeMandate', 'blockForAllUnfit', 'blockForManualRelease', 'blockForMergeFailure', 'claim', 'close',
  'create', 'createFromMessage', 'createGuarded', 'delete', 'getById', 'lastDoneByAssignee',
  'list', 'rebindSourceChannel', 'recordL1Verification', 'recordMergeProgress',
  'reviewPassed', 'reviewRejected', 'revokeMandate', 'settleMerge', 'transitionStatus', 'unclaim', 'update', 'updateMetadata', 'verifyManually',
];

const ownMethods = (cls: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(cls.prototype).filter(n => n !== 'constructor').sort();
const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('WorkUnitService 用例组合（ARCH-05）', () => {
  it('四个用例 owner 之间没有继承关系', () => {
    expect(WorkUnitService.prototype).not.toBeInstanceOf(WorkUnitReviewService);
    expect(WorkUnitReviewService.prototype).not.toBeInstanceOf(WorkUnitLifecycleService);
    expect(WorkUnitLifecycleService.prototype).not.toBeInstanceOf(WorkUnitQueryService);
    expect(WorkUnitQueryService.prototype).not.toBeInstanceOf(WorkUnitCrudService);
  });

  it('facade 保留原公共方法，组合 owner 与内部写口均为私有窄接口', () => {
    expect(ownMethods(WorkUnitService)).toEqual(PUBLIC_METHODS);
    const facade = source('workunit-review.ts');
    expect(facade).toContain('private readonly repository: WorkUnitRepository & WorkUnitLifecycleRepository');
    expect(facade).toContain('private readonly query: WorkUnitQuery');
    expect(facade).toContain('private readonly lifecycle: WorkUnitLifecycle & WorkUnitLifecyclePersistence');
    expect(facade).toContain('private readonly review: WorkUnitReview');
  });

  it('Lifecycle 依赖接口独立且只含实际调用，不继承完整用例面', () => {
    const repository = source('workunit-crud.ts');
    const lifecycle = source('workunit-lifecycle.ts');
    expect(repository).toMatch(/export interface WorkUnitLifecycleRepository\s*\{/);
    expect(repository).not.toMatch(/export interface WorkUnitLifecycleRepository\s+extends\s+WorkUnitRepository/);
    expect(lifecycle).toMatch(/export interface WorkUnitLifecyclePersistence\s*\{/);
    expect(lifecycle).not.toMatch(/export interface WorkUnitLifecyclePersistence\s+extends\s+WorkUnitLifecycle/);
  });

  it('职责落位：查询、状态机与评审各有自己的实现', () => {
    expect(ownMethods(WorkUnitQueryService)).toEqual([
      'getById', 'lastDoneByAssignee', 'list',
    ]);
    expect(ownMethods(WorkUnitLifecycleService)).toEqual([
      'close', 'persistSnapshot', 'rebindSourceChannel', 'transitionStatus', 'writeWorkUnitClosedEvent',
    ]);
    expect(ownMethods(WorkUnitReviewService)).toEqual([
      'blockForAllUnfit', 'blockForManualRelease', 'blockForMergeFailure', 'buildAttestationEntry',
      'recordL1Verification', 'recordMergeProgress', 'reviewPassed', 'reviewRejected', 'settleMerge', 'verifyManually',
      'writeAgentReviewAttestation', 'writeHumanConfirmation',
    ]);
    expect(Object.keys(serviceModule).sort()).toEqual([
      'WorkUnitReviewService', 'WorkUnitService', 'waitForReviewPassSettled',
    ]);
  });
});
