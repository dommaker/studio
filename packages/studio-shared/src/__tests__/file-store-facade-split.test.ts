/**
 * #670 结构测试：FileStore 门面拆分（PURE_MOVE）防漂移网。
 *
 * ① 新分层类存在且为 function；② 继承链 instanceof 沿链成立；
 * ③ FileStore 原型链方法面 == 拆分前基线；④ ./file-store 模块 value exports == 基线。
 * ③④ 基线采集于拆分前代码（walk 原型链至 FileStoreBase 为止 + Object.keys 模块命名空间）。
 */
import { describe, expect, it } from 'vitest';
import * as fsModule from '../file-store';
import { FileStore } from '../file-store';
import { FileStoreBase } from '../file-store-base';
import { FileStoreWorkUnitBase } from '../file-store-workunit';
import { FileStoreMessagesCoreBase } from '../file-store-messages-core';
import { FileStoreMessagesQueryBase } from '../file-store-messages-query';
import { FileStoreMessagesArchiveBase } from '../file-store-messages-archive';
import { FileStoreMessagesBase } from '../file-store-messages';
import { FileStoreCachedBase } from '../file-store-cached';
import { FileStoreEntitiesBase } from '../file-store-entities';
import { FileStoreSeqEntriesBase } from '../file-store-seq-entries';
import { FileStoreDocsBase } from '../file-store-docs';

const BASELINE_METHODS = [
  'agentsDir', 'allocateEvolutionSeq', 'allocateRequirementSeq', 'allocateSeq',
  'appendChangelog', 'appendEvent', 'appendIndexRowsLocked', 'appendJsonl', 'appendMessage',
  'archiveAnchorMs', 'archiveChannelMessages', 'archiveChannelMessagesLocked', 'archiveDir',
  'archiveMonthPath', 'buildIndex', 'channelConfigPath', 'channelStoreConfig', 'channelsDir',
  'claimWorkUnit', 'commitRemoval', 'commitSnapshot', 'compactIndexIfNeededLocked',
  'compactMessagesIfNeededLocked', 'countColdLines', 'countFileLines', 'createChannel',
  'createDirEntity', 'createEvolutionProposal', 'createProfile', 'createRequirement',
  'createSnapshotGuarded', 'createState', 'deleteChannel', 'deleteDirEntity', 'deleteProfile',
  'deleteState', 'entryPath', 'eventsPath', 'evolutionStoreConfig', 'flushWorkUnitLeases',
  'getChannel', 'getChannelVersion', 'getDirEntity', 'getEntry', 'getEvolutionProposal',
  'getIndex', 'getMessageById', 'getMessagesSince', 'getProfile', 'getRequirement', 'getState',
  'indexPath', 'iterateColdMessages', 'listArchiveMonths', 'listChannels', 'listDirEntities',
  'listDocs', 'listEntries', 'listEvolutionProposals', 'listExistingSeqs', 'listJsonInDir',
  'listMessageChannelIds', 'listProfiles', 'listRequirements', 'listStates', 'lockDir',
  'messagesLockDir', 'messagesPath', 'migrateChannelsEncoding', 'migrateLegacyIndexLocked',
  'profilePath', 'profileStoreConfig', 'queryAllMessages', 'queryMessages', 'queryMessagesPage',
  'readChannelMessagesDelta', 'readDoc', 'readDocCached', 'readDocWithMtime', 'readIndexFile',
  'readIndexForQuery', 'readJson', 'readJsonl', 'readMessagesTail', 'readdir', 'readdirCached',
  'rebuildIndex', 'reconcileIndex', 'reduceEventsToSnapshots', 'refreshWorkUnitLease',
  'removeDirIfEmpty', 'removeSnapshot', 'removeSnapshotLocked', 'requirementStoreConfig',
  'resolveActiveMessages', 'runtimeStateStoreConfig', 'scanHotToAnchor', 'softDeleteMessage',
  'statePath', 'sweepEmptyAgentDirs', 'thawChannelWorkUnitMessages', 'thawWorkUnitMessages',
  'updateChannel', 'updateDirEntity', 'updateEntry', 'updateEvolutionProposal',
  'updateMetadata', 'updateProfile', 'updateRequirement', 'updateState', 'upsertSnapshot',
  'upsertSnapshotLocked', 'writeDoc', 'writeJson', 'writeJsonl',
];

const BASELINE_EXPORTS = [
  'FileStore', 'LockTimeoutError', 'formatEvolutionId', 'formatRequirementId',
  'parseChannels', 'parseFrontmatter', 'parseWorkUnitIndexContent',
  'serializeFrontmatter', 'stringifyChannels',
];

describe('file-store 门面拆分（#670）', () => {
  it('① 新分层类存在且为 function', () => {
    for (const cls of [
      FileStoreMessagesCoreBase, FileStoreMessagesQueryBase, FileStoreMessagesArchiveBase,
      FileStoreMessagesBase, FileStoreCachedBase, FileStoreEntitiesBase,
      FileStoreSeqEntriesBase, FileStoreDocsBase,
    ]) {
      expect(typeof cls).toBe('function');
    }
  });

  it('② 继承链 instanceof 沿链成立', () => {
    expect(FileStore.prototype).toBeInstanceOf(FileStoreDocsBase);
    expect(FileStoreDocsBase.prototype).toBeInstanceOf(FileStoreSeqEntriesBase);
    expect(FileStoreSeqEntriesBase.prototype).toBeInstanceOf(FileStoreEntitiesBase);
    expect(FileStoreEntitiesBase.prototype).toBeInstanceOf(FileStoreCachedBase);
    expect(FileStoreCachedBase.prototype).toBeInstanceOf(FileStoreMessagesBase);
    expect(FileStoreMessagesBase.prototype).toBeInstanceOf(FileStoreMessagesArchiveBase);
    expect(FileStoreMessagesArchiveBase.prototype).toBeInstanceOf(FileStoreMessagesQueryBase);
    expect(FileStoreMessagesQueryBase.prototype).toBeInstanceOf(FileStoreMessagesCoreBase);
    expect(FileStoreMessagesCoreBase.prototype).toBeInstanceOf(FileStoreWorkUnitBase);
    expect(FileStoreWorkUnitBase.prototype).toBeInstanceOf(FileStoreBase);
  });

  it('③ FileStore 方法面 == 拆分前基线', () => {
    const names: string[] = [];
    let proto = FileStore.prototype;
    while (proto && proto !== FileStoreBase.prototype && proto !== Object.prototype) {
      for (const n of Object.getOwnPropertyNames(proto)) {
        if (n !== 'constructor') names.push(n);
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect([...new Set(names)].sort()).toEqual(BASELINE_METHODS);
  });

  it('④ ./file-store 模块 value exports == 拆分前基线', () => {
    expect(Object.keys(fsModule).sort()).toEqual(BASELINE_EXPORTS);
  });
});
