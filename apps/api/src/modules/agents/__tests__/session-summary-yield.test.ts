// #675：首跑全量提取（全新数据区，HEAD~50..HEAD 在合并历史下可达数百提交）的
// recordPattern 循环是「同步 ingest 写 + microtask await」紧循环——await 一个同步
// 函数只让出 microtask，事件循环的 I/O（请求/SSE）在整个提取期间插不进来
// （实测见 performance-baseline.md §10：fix+feat 两段循环各成 1.3s/2.0s 连续阻塞）。
// 修复：逐条提取之间 setImmediate 让出（macrotask），请求得以穿插。
// 本测试用「上一次调用调度的 setImmediate 在下一次调用前已执行」判定让出真实发生——
// 仅靠 microtask 链时该回调不可能在两次 recordPattern 之间运行（RED → GREEN）。
// 夹具与 session-summary.test.ts 同构：真实 git 仓库 + STUDIO_HOME 隔离 + knowledge barrel mock。
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { tmpHome, tmpRepo, origHomedir, origStudioHome, rootCommit } = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execSync } = require('node:child_process');
  const orig = os.homedir;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-yield-home-'));
  os.homedir = () => home;

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-yield-repo-'));
  const git = (cmd: string) => execSync(`git -C "${repo}" ${cmd}`, { stdio: 'pipe' });
  git('init -q');
  git('-c user.name=test -c user.email=test@t commit -q --allow-empty -m "chore: init"');
  const root = execSync(`git -C "${repo}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
  // 两个同类型（fix）提交：两次 recordPattern 发生在同一个提取循环内、
  // 中间无动态 import 等天然 macrotask，让出与否只取决于循环自身是否显式 yield
  git('-c user.name=test -c user.email=test@t commit -q --allow-empty -m "fix: 甲"');
  git('-c user.name=test -c user.email=test@t commit -q --allow-empty -m "fix: 乙"');
  // REPO_DIR / CHECKPOINT_FILE 在 service 模块加载时解析——必须先设
  process.env.REPO_DIR = repo;
  const origStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(home, '.studio');
  return { tmpHome: home, tmpRepo: repo, origHomedir: orig, origStudioHome, rootCommit: root };
});

const { mockRecordPattern } = vi.hoisted(() => ({
  mockRecordPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../knowledge/index.js', () => ({
  knowledgeService: { recordPattern: mockRecordPattern },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import fs from 'node:fs';
import path from 'node:path';

const CHECKPOINT_FILE = path.join(tmpHome, '.studio', 'session-checkpoint.json');

describe('#675 SessionSummary 首跑提取让出事件循环', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fs.rmSync(CHECKPOINT_FILE, { force: true });
    fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ lastCommit: rootCommit, lastShutdown: '', updatedAt: '' }));
  });

  afterAll(() => {
    const os = require('node:os');
    os.homedir = origHomedir;
    delete process.env.REPO_DIR;
    if (origStudioHome === undefined) {
      delete process.env.STUDIO_HOME;
    } else {
      process.env.STUDIO_HOME = origStudioHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('连续 recordPattern 之间经过 macrotask 让出（setImmediate 回调先行）', async () => {
    const observedAtCall: boolean[] = [];
    let immediateRan = false;
    mockRecordPattern.mockImplementation(() => {
      observedAtCall.push(immediateRan);
      immediateRan = false;
      setImmediate(() => { immediateRan = true; });
      return Promise.resolve();
    });
    const { sessionSummaryService } = await import('../session-summary.service.js');

    const result = await sessionSummaryService.summarize();

    expect(result.commits).toBe(2);
    expect(mockRecordPattern).toHaveBeenCalledTimes(2);
    // 第二次调用时第一次调度的 setImmediate 已执行 ⇒ 两次提取之间让出了事件循环；
    // 未修复时循环只有 microtask 链，setImmediate（macrotask）不可能插队 ⇒ false
    expect(observedAtCall[1]).toBe(true);
  });

  it('提取结果语义不变：commits/patterns 计数与 checkpoint 更新', async () => {
    const { sessionSummaryService } = await import('../session-summary.service.js');

    const result = await sessionSummaryService.summarize();

    expect(result.commits).toBe(2);
    expect(result.patterns).toBe(2);
    expect(mockRecordPattern).toHaveBeenCalledTimes(2);
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    // checkpoint 推进到最新提交（commits[0] = git log 首条 = 最新）
    const head = require('node:child_process').execSync(`git -C "${tmpRepo}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
    expect(cp.lastCommit).toBe(head);
  });
});
