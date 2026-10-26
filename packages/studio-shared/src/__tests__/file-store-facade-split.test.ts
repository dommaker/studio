/**
 * #681 结构测试：FileStore 组合化（继承链 → 组合）防漂移网。
 * （前身为 #670 继承链拆分的 PURE_MOVE 基线测试；#681 P1-1 改写为组合结构等价断言）
 *
 * ① 组合件类存在且为 function（FileStoreBase/CachedFileIo/WorkUnitStore/
 *    MessagesStore/EntityStore/DocsStore），两个空壳类（FileStoreMessagesBase /
 *    FileStore 空继承）已删除；
 * ② 组合结构断言：FileStore 不继承任何域类（原型直接挂 Object.prototype），
 *    公共方法全部以自有属性形式承载在 FileStore.prototype（逐方法委托）；
 * ③ FileStore 公共方法面 == 组合前公共方法面基线（继承链时代散落在各层
 *    prototype 的私有/protected 内部件不再出现在门面上——它们是内部实现，
 *    不作为公共契约；公共面逐条保留）；
 * ④ ./file-store 模块 value exports == 基线（导出面不变）。
 */
import { describe, expect, it } from 'vitest';
import * as fsModule from '../file-store';
import { FileStore } from '../file-store';
import { FileStoreBase } from '../file-store/file-store-base';
import { CachedFileIo } from '../file-store/file-store-cached';
import { WorkUnitStore } from '../file-store/file-store-workunit';
import { MessagesStore } from '../file-store/file-store-messages';
import { MessagesCoreStore } from '../file-store/file-store-messages-core';
import { MessagesQueryStore } from '../file-store/file-store-messages-query';
import { MessagesArchiveStore } from '../file-store/file-store-messages-archive';
import { EntityStore } from '../file-store/file-store-entities';
import { DocsStore } from '../file-store/file-store-docs';

/** 公共方法面基线（组合前 FileStore 实例可调用的全部公共方法，逐条保留） */
const BASELINE_PUBLIC_METHODS = [
  'allocateEvolutionSeq', 'allocateRequirementSeq', 'appendChangelog', 'appendEvent',
  'appendJsonl', 'appendMessage', 'archiveChannelMessages', 'buildIndex', 'claimWorkUnit',
  'commitRemoval', 'commitSnapshot', 'createChannel', 'createEvolutionProposal',
  'createProfile', 'createRequirement', 'createSnapshotGuarded', 'createState',
  'deleteChannel', 'deleteDoc', 'deleteProfile', 'deleteState', 'flushWorkUnitLeases', 'getChannel',
  'getChannelVersion', 'getDataDir', 'getEvolutionProposal', 'getIndex', 'getMessageById',
  'getMessagesSince', 'getProfile', 'getRequirement', 'getState', 'listChannels',
  'listDocs', 'listEvolutionProposals', 'listJsonInDir', 'listMessageChannelIds',
  'listProfiles', 'listRequirements', 'listStates',
  'queryAllMessages', 'queryMessages', 'queryMessagesPage', 'readChannelMessagesDelta',
  'readDoc', 'readDocWithMtime', 'readJson', 'readJsonUncached', 'readJsonl', 'readMessagesTail', 'readdir',
  'rebuildIndex', 'reconcileIndex', 'refreshWorkUnitLease', 'removeSnapshot',
  'softDeleteMessage', 'sweepEmptyAgentDirs', 'thawWorkUnitMessages', 'updateChannel',
  'updateEvolutionProposal', 'updateMetadata', 'updateProfile', 'updateRequirement',
  'updateState', 'upsertSnapshot', 'withLock', 'writeDoc', 'writeJson', 'writeJsonl',
];

const BASELINE_EXPORTS = [
  'FileStore', 'LockTimeoutError', 'formatEvolutionId', 'formatRequirementId',
  'parseChannels', 'parseFrontmatter', 'parseWorkUnitIndexContent',
  'serializeFrontmatter', 'stringifyChannels',
];

describe('file-store 组合化（#681 P1-1）', () => {
  it('① 组合件类存在且为 function', () => {
    for (const cls of [
      FileStoreBase, CachedFileIo, WorkUnitStore,
      MessagesStore, MessagesCoreStore, MessagesQueryStore, MessagesArchiveStore,
      EntityStore, DocsStore,
    ]) {
      expect(typeof cls).toBe('function');
    }
  });

  it('② 组合结构：FileStore 不继承任何域类（原型直挂 Object.prototype）', () => {
    expect(Object.getPrototypeOf(FileStore.prototype)).toBe(Object.prototype);
    expect(FileStore.prototype).not.toBeInstanceOf(FileStoreBase);
  });

  it('③ FileStore 公共方法面 == 组合前基线（自有属性逐方法委托）', () => {
    const names = Object.getOwnPropertyNames(FileStore.prototype)
      .filter(n => n !== 'constructor');
    expect(names.sort()).toEqual(BASELINE_PUBLIC_METHODS);
  });

  it('④ ./file-store 模块 value exports == 组合前基线', () => {
    expect(Object.keys(fsModule).sort()).toEqual(BASELINE_EXPORTS);
  });
});
