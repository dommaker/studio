/**
 * #281（决策 #249 §1 / #257 D7）：@文件引用词表服务。
 *
 * 候选集 = 频道默认工程 ∪ 本频道 REQ 挂接 PMO 全部工程（gitRepo + deliveries[].gitRepo）
 * ∪ 杂务 PMO 工程，去重，频道内最近 WU 涉及工程优先（UX 划界，非安全边界）。
 * 词表 = 各仓 git ls-files + 内存缓存；校验 = repo 在候选集 + path 在词表。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import {
  computeCandidateRepos,
  getChannelFileVocabulary,
  validateFileRefs,
  invalidateFileRefVocabularyCache,
  listChannelReqPmoProjects,
  type FileRefVocabularyDeps,
} from '../file-ref-vocabulary.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
const channelId = `test-fileref-${Date.now()}`;

const now = () => new Date().toISOString();

async function createChannel(defaultWorkspaceId: string | null = null) {
  await fileStore.createChannel({
    id: channelId, name: '#test-fileref', type: 'rnd',
    defaultWorkspaceId, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now(), updatedAt: now(),
  });
}

async function createRequirement(id: string, projectId: string | null) {
  await fileStore.createRequirement({
    id, seq: parseInt(id.slice(4), 10), title: id, status: 'open',
    channelId, createdAt: now(), createdBy: 'mention',
    ...(projectId ? { projectId } : {}),
  } as Parameters<FileStore['createRequirement']>[0]);
}

async function createWuWithRoot(workspaceRoot: string) {
  const wuService = new WorkUnitService(fileStore);
  await wuService.create({
    scope: 't', channelId, type: 'task', metadata: { workspaceRoot },
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileref-vocab-test-'));
  fileStore = new FileStore(tmpDir);
  invalidateFileRefVocabularyCache();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeCandidateRepos（候选集计算）', () => {
  it('候选集 = 默认工程 ∪ REQ 挂接 PMO（gitRepo + deliveries 多腿，去重）∪ 杂务 PMO', async () => {
    await createChannel('ws-1');
    await createRequirement('REQ-0001', 'p1');
    await createRequirement('REQ-0002', null); // 无挂接 → 不贡献
    const deps: FileRefVocabularyDeps = {
      fileStore,
      resolveWorkspaceRoot: async id => (id === 'ws-1' ? '/repo/default' : null),
      getProject: async id =>
        id === 'p1'
          ? { gitRepo: '/repo/a', deliveries: [{ gitRepo: '/repo/a' }, { gitRepo: '/repo/b' }] }
          : null,
      findChoreProject: async () => ({ gitRepo: '/repo/chore' }),
    };

    const repos = await computeCandidateRepos(channelId, deps);
    expect(repos).toEqual(['/repo/default', '/repo/a', '/repo/b', '/repo/chore']);
  });

  it('频道内最近 WU 涉及的工程排前（按 updatedAt 新→旧），其余保持基础序', async () => {
    await createChannel('ws-1');
    await createRequirement('REQ-0001', 'p1');
    // 旧 WU 用 /repo/a，新 WU 用 /repo/chore → /repo/chore 最前
    await createWuWithRoot('/repo/a');
    await sleep(5);
    await createWuWithRoot('/repo/chore');
    const deps: FileRefVocabularyDeps = {
      fileStore,
      resolveWorkspaceRoot: async () => '/repo/default',
      getProject: async () => ({ gitRepo: '/repo/a', deliveries: [{ gitRepo: '/repo/b' }] }),
      findChoreProject: async () => ({ gitRepo: '/repo/chore' }),
    };

    const repos = await computeCandidateRepos(channelId, deps);
    expect(repos).toEqual(['/repo/chore', '/repo/a', '/repo/default', '/repo/b']);
  });

  it('尾斜杠写法差归一去重；单一来源读取失败不拖垮整体', async () => {
    await createChannel('ws-1');
    await createRequirement('REQ-0001', 'p1');
    await createRequirement('REQ-0002', 'p2');
    const deps: FileRefVocabularyDeps = {
      fileStore,
      resolveWorkspaceRoot: async () => '/repo/default/',
      getProject: async id => {
        if (id === 'p1') throw new Error('corrupt project json');
        return { gitRepo: '/repo/default' }; // 与默认工程同仓（尾斜杠差）→ 去重
      },
      findChoreProject: async () => { throw new Error('chore scan failed'); },
    };

    const repos = await computeCandidateRepos(channelId, deps);
    expect(repos).toEqual(['/repo/default']);
  });

  it('#272（决策 #251 Q2\'）：频道 defaultPath（默认工程=本地 repo）进入候选集', async () => {
    await createChannel('ws-1');
    await fileStore.updateChannel(channelId, { defaultPath: '/repo/local-default' });
    const deps: FileRefVocabularyDeps = {
      fileStore,
      resolveWorkspaceRoot: async () => '/repo/ws-root',
      getProject: async () => null,
      findChoreProject: async () => null,
    };

    const repos = await computeCandidateRepos(channelId, deps);
    // 默认工程（defaultPath）在前，执行机器根（defaultWorkspaceId）仍保留为候选
    expect(repos).toEqual(['/repo/local-default', '/repo/ws-root']);
  });

  it('#272：defaultPath 与 REQ 挂接 PMO 同仓时归一去重；空串 defaultPath 忽略', async () => {
    await createChannel();
    await fileStore.updateChannel(channelId, { defaultPath: '/repo/a/' });
    await createRequirement('REQ-0001', 'p1');
    const deps: FileRefVocabularyDeps = {
      fileStore,
      getProject: async () => ({ gitRepo: '/repo/a' }),
      findChoreProject: async () => null,
    };

    const repos = await computeCandidateRepos(channelId, deps);
    expect(repos).toEqual(['/repo/a']);
  });
});

describe('getChannelFileVocabulary（git ls-files 词表 + 内存缓存）', () => {
  it('返回各候选仓词表；TTL 内二次调用走缓存（listFiles 仅一次）', async () => {
    await createChannel('ws-1');
    let calls = 0;
    const deps: FileRefVocabularyDeps = {
      fileStore,
      resolveWorkspaceRoot: async () => '/repo/default',
      getProject: async () => null,
      findChoreProject: async () => null,
      listFiles: async () => { calls += 1; return ['src/a.ts', 'src/b.ts']; },
    };

    const first = await getChannelFileVocabulary(channelId, deps);
    expect(first.repos).toEqual([{ repo: '/repo/default', files: ['src/a.ts', 'src/b.ts'] }]);
    const second = await getChannelFileVocabulary(channelId, deps);
    expect(second.repos[0].files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(calls).toBe(1);

    invalidateFileRefVocabularyCache();
    await getChannelFileVocabulary(channelId, deps);
    expect(calls).toBe(2);
  });

  it('单仓 ls-files 失败 → 该仓词表为空，不影响其他仓', async () => {
    await createChannel('ws-1');
    await createRequirement('REQ-0001', 'p1');
    const deps: FileRefVocabularyDeps = {
      fileStore,
      resolveWorkspaceRoot: async () => '/repo/bad',
      getProject: async () => ({ gitRepo: '/repo/good' }),
      findChoreProject: async () => null,
      listFiles: async repo => {
        if (repo === '/repo/bad') throw new Error('not a git repo');
        return ['x.ts'];
      },
    };

    const vocab = await getChannelFileVocabulary(channelId, deps);
    expect(vocab.repos).toEqual([
      { repo: '/repo/bad', files: [] },
      { repo: '/repo/good', files: ['x.ts'] },
    ]);
  });
});

describe('listChannelReqPmoProjects（频道 REQ 挂接 PMO 工程共用查询）', () => {
  it('返回挂接工程的 reqId/seq/projectId/project；无 projectId 的 REQ 跳过', async () => {
    await createRequirement('REQ-0001', 'p1');
    await createRequirement('REQ-0002', null);
    await createRequirement('REQ-0003', 'p3');
    const links = await listChannelReqPmoProjects(channelId, {
      fileStore,
      getProject: async id => ({ gitRepo: `/repo/${id}` }),
    });
    expect(links).toEqual([
      { reqId: 'REQ-0001', seq: 1, projectId: 'p1', project: { gitRepo: '/repo/p1' } },
      { reqId: 'REQ-0003', seq: 3, projectId: 'p3', project: { gitRepo: '/repo/p3' } },
    ]);
  });

  it('单条解析抛错/项目不存在 → 记日志跳过，不影响其他条目', async () => {
    await createRequirement('REQ-0001', 'p1');
    await createRequirement('REQ-0002', 'p2');
    await createRequirement('REQ-0003', 'p3');
    const links = await listChannelReqPmoProjects(channelId, {
      fileStore,
      getProject: async id => {
        if (id === 'p1') throw new Error('corrupt project json');
        if (id === 'p2') return null; // 项目被删 → 跳过
        return { gitRepo: '/repo/p3' };
      },
    });
    expect(links.map(l => l.projectId)).toEqual(['p3']);
  });

  it('REQ 列表读取失败 → 抛出（调用方各自决定降级路径）', async () => {
    const broken = {
      listRequirements: async () => { throw new Error('disk gone'); },
    } as unknown as FileStore;
    await expect(listChannelReqPmoProjects(channelId, { fileStore: broken }))
      .rejects.toThrow('disk gone');
  });
});

describe('validateFileRefs（存在性校验）', () => {
  async function setupDeps(): Promise<FileRefVocabularyDeps> {
    await createChannel('ws-1');
    return {
      fileStore,
      resolveWorkspaceRoot: async () => '/repo/default',
      getProject: async () => null,
      findChoreProject: async () => null,
      listFiles: async () => ['src/a.ts', 'README.md'],
    };
  }

  it('候选集内且词表命中 → kept；词表未命中 → dropped(reason=not-found)', async () => {
    const deps = await setupDeps();
    const result = await validateFileRefs(channelId, [
      { repo: '/repo/default', path: 'src/a.ts' },
      { repo: '/repo/default', path: 'src/gone.ts' },
    ], deps);
    expect(result.kept).toEqual([{ repo: '/repo/default', path: 'src/a.ts' }]);
    expect(result.dropped).toEqual([{ repo: '/repo/default', path: 'src/gone.ts', reason: 'not-found' }]);
  });

  it('repo 不在候选集 → dropped(reason=not-in-candidate-set)；repo 尾斜杠归一后命中', async () => {
    const deps = await setupDeps();
    const result = await validateFileRefs(channelId, [
      { repo: '/repo/default/', path: 'README.md' },
      { repo: '/repo/other', path: 'src/a.ts' },
    ], deps);
    expect(result.kept).toEqual([{ repo: '/repo/default', path: 'README.md' }]);
    expect(result.dropped).toEqual([{ repo: '/repo/other', path: 'src/a.ts', reason: 'not-in-candidate-set' }]);
  });
});
