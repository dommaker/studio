// P5b: SessionSummary checkpoint 失效修复 —— checkpoint.lastCommit 不在仓库（历史改写/
// 换过 REPO_DIR）时，原行为每次启动 git log 报 Invalid revision range 且 checkpoint 永不
// 更新（周期性报错）；修复后校验存在性并回退 HEAD~50（短仓库 --max-count=50 兜底），
// 成功跑完一次后 checkpoint 自愈。
// 夹具：真实 git 仓库（tmpdir）+ homedir require-patch（CHECKPOINT_FILE 落 tmpHome）；
// knowledge-service mock 掉（recordPattern 不落真实知识库）。
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { tmpHome, tmpRepo, origHomedir } = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execSync } = require('node:child_process');
  const orig = os.homedir;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-home-'));
  os.homedir = () => home;

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-repo-'));
  const git = (cmd: string) => execSync(`git -C "${repo}" ${cmd}`, { stdio: 'pipe' });
  git('init -q');
  git('-c user.name=test -c user.email=test@t commit -q --allow-empty -m "chore: init"');
  git('-c user.name=test -c user.email=test@t commit -q --allow-empty -m "fix: 修复登录超时"');
  git('-c user.name=test -c user.email=test@t commit -q --allow-empty -m "feat: 新增频道面板"');
  // REPO_DIR 在 service 模块加载时解析 —— 必须先设
  process.env.REPO_DIR = repo;
  return { tmpHome: home, tmpRepo: repo, origHomedir: orig };
});

const { mockRecordPattern, mockLoggerWarn } = vi.hoisted(() => ({
  mockRecordPattern: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { recordPattern: mockRecordPattern },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
}));

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CHECKPOINT_FILE = path.join(tmpHome, '.studio', 'session-checkpoint.json');

function writeCheckpoint(lastCommit: string): void {
  fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ lastCommit, lastShutdown: '', updatedAt: '' }));
}

function headHash(): string {
  return execSync(`git -C "${tmpRepo}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
}

describe('SessionSummary checkpoint 失效回退（P5b）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fs.rmSync(CHECKPOINT_FILE, { force: true });
  });

  afterAll(() => {
    const os = require('node:os');
    os.homedir = origHomedir;
    delete process.env.REPO_DIR;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('checkpoint commit 不在仓库 → 回退跑通，不报 Git log failed，checkpoint 自愈为有效 hash', async () => {
    writeCheckpoint('730d534eb46536e88eb391bedfd24813a3da8488'); // 不存在的 hash
    const { sessionSummaryAgent } = await import('../session-summary-agent.service.js');

    const result = await sessionSummaryAgent.summarize();

    expect(result.commits).toBeGreaterThan(0);
    // 不再出现周期性的 Git log failed
    expect(mockLoggerWarn.mock.calls.some(c => (c[0] as string).includes('Git log failed'))).toBe(false);
    // fix commit 的 pattern 被提取
    expect(mockRecordPattern.mock.calls.some(c => (c[0] as { title: string }).title.includes('修复登录超时'))).toBe(true);
    // checkpoint 自愈：写入仓库中真实存在的 hash
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    execSync(`git -C "${tmpRepo}" cat-file -e "${cp.lastCommit}^{commit}"`);
  });

  it('checkpoint commit 有效 → 正常增量（无回退、无告警）', async () => {
    // 从第一个提交起算 → 后两个提交入增量
    const firstCommit = execSync(`git -C "${tmpRepo}" rev-list --max-parents=0 HEAD`, { encoding: 'utf-8' }).trim();
    writeCheckpoint(firstCommit);
    const { sessionSummaryAgent } = await import('../session-summary-agent.service.js');

    const result = await sessionSummaryAgent.summarize();

    expect(result.commits).toBe(2);
    expect(mockLoggerWarn.mock.calls.some(c => (c[0] as string).includes('Git log failed'))).toBe(false);
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    expect(cp.lastCommit).toBe(headHash());
  });

  it('无 checkpoint 文件 → 默认 HEAD~50/短仓库兜底，不报错', async () => {
    const { sessionSummaryAgent } = await import('../session-summary-agent.service.js');

    const result = await sessionSummaryAgent.summarize();

    expect(result.commits).toBeGreaterThan(0);
    expect(mockLoggerWarn.mock.calls.some(c => (c[0] as string).includes('Git log failed'))).toBe(false);
  });
});
