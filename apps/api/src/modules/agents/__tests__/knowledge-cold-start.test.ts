/**
 * knowledge-cold-start — 冷启动子模块单元测试
 *
 * 自足测试（不依赖真实 harness 导入 / 真实 HOME / Discord）：
 * - ColdStartImporter mock：捕获构造配置，控制 importAll 结果
 * - os.homedir mock → tmpHome；REPO_DIR → tmpProject（放置 CLAUDE.md）
 * - discord-notifier mock：验证通知而不产生网络调用
 *
 * 覆盖：
 *  - 四源导入配置（sources/docPaths/manualEntries/skipExisting）与结果日志、Discord 通知
 *  - memory 目录不存在时 docPaths 仅含存在的文档
 *  - importAll 失败 → logger.error 静默不抛
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  tmpHome, tmpProject, mockLogger, mockImportAll, importerConfigs, mockDiscordSendText, mockHomedir,
} = vi.hoisted(() => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-home-'));
  return {
    tmpHome,
    tmpProject: fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-proj-')),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockImportAll: vi.fn(),
    importerConfigs: [] as any[],
    mockDiscordSendText: vi.fn().mockResolvedValue(undefined),
    mockHomedir: vi.fn(() => tmpHome),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: mockHomedir };
});

vi.mock('@dommaker/studio-shared', () => ({ logger: mockLogger }));

vi.mock('@dommaker/harness', () => ({
  ColdStartImporter: vi.fn().mockImplementation(function (config: any) {
    importerConfigs.push(config);
    return { importAll: mockImportAll };
  }),
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({ sharedStore: {} }));

vi.mock('../../../utils/discord-notifier.js', () => ({
  discordNotifier: { sendText: mockDiscordSendText },
}));

import { coldStartAll } from '../knowledge/knowledge-cold-start.js';

const savedRepoDir = process.env.REPO_DIR;

beforeEach(() => {
  vi.clearAllMocks();
  importerConfigs.length = 0;
  process.env.REPO_DIR = tmpProject;
});

afterAll(() => {
  if (savedRepoDir === undefined) delete process.env.REPO_DIR;
  else process.env.REPO_DIR = savedRepoDir;
});

describe('coldStartAll (P1b 四源冷启动)', () => {
  it('按四源配置构造 importer，记录结果并发送 Discord 通知', async () => {
    // 准备文档：memory 目录 2 个 md + 1 个非 md；项目根 CLAUDE.md（无 README.md）
    const memoryDir = path.join(tmpHome, '.claude', 'projects', '-root-projects', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'rule-a.md'), '# a');
    fs.writeFileSync(path.join(memoryDir, 'rule-b.md'), '# b');
    fs.writeFileSync(path.join(memoryDir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(tmpProject, 'CLAUDE.md'), '# claude');

    mockImportAll.mockResolvedValue([
      { source: { type: 'docs' }, entries: [{}, {}], errors: [] },
      { source: { type: 'git' }, entries: [], errors: ['some-error'] },
    ]);

    await coldStartAll();

    expect(importerConfigs).toHaveLength(1);
    const config = importerConfigs[0];
    expect(config.projectRoot).toBe(tmpProject);
    expect(config.sources).toEqual(['code', 'git', 'docs', 'manual']);
    expect(config.skipExisting).toBe(true);
    expect(config.docPaths).toEqual([
      path.join(memoryDir, 'rule-a.md'),
      path.join(memoryDir, 'rule-b.md'),
      path.join(tmpProject, 'CLAUDE.md'),
    ]);
    expect(config.manualEntries).toHaveLength(2);
    expect(config.manualEntries[0]).toMatchObject({ title: 'Agent Network Flow', type: 'process' });
    expect(config.manualEntries[1]).toMatchObject({ title: '8-Agent System', type: 'model' });

    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeCurator] Cold start import completed', {
      importedCount: 2,
      totalErrors: 1,
      sources: ['docs', 'git'],
    });
    expect(mockDiscordSendText).toHaveBeenCalledWith(
      '📚 冷启动知识导入完成',
      expect.stringContaining('导入了 2 条知识 (1 个错误)'),
    );
  });

  it('memory 目录不存在 → docPaths 只含存在的文档', async () => {
    // Clean up files created by previous test (shared tmpHome/tmpProject)
    fs.rmSync(path.join(tmpHome, '.claude'), { recursive: true, force: true });
    try { fs.unlinkSync(path.join(tmpProject, 'CLAUDE.md')); } catch {}
    fs.writeFileSync(path.join(tmpProject, 'README.md'), '# readme');

    mockImportAll.mockResolvedValue([]);
    await coldStartAll();

    const config = importerConfigs[0];
    expect(config.docPaths).toEqual([path.join(tmpProject, 'README.md')]);
    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeCurator] Cold start import completed', {
      importedCount: 0,
      totalErrors: 0,
      sources: [],
    });
  });

  it('importAll 失败 → logger.error，静默不抛、不发通知', async () => {
    mockImportAll.mockRejectedValue(new Error('importer crashed'));
    await expect(coldStartAll()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith('[KnowledgeCurator] Cold start import failed', { error: 'Error: importer crashed' });
    expect(mockDiscordSendText).not.toHaveBeenCalled();
  });
});
