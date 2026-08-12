// #94 session-resume 纯函数单测：cwd slug 规则 / claude 会话文件存在性 / 续用判定 / 续用失败错误识别。
// HOME 经 vi.stubEnv 指向 tmpdir（os.homedir() POSIX 优先读 $HOME，已在仓内验证），
// 会话文件直接造在 <tmp>/.claude/projects/<slug>/<id>.jsonl，无需 mock 文件系统。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  claudeCwdSlug,
  defaultClaudeProjectsDir,
  claudeSessionFileExists,
  shouldResumeSession,
  RESUME_FAILURE_RE,
} from '../session-resume.js';

describe('claudeCwdSlug', () => {
  it("'/' 与 '.' 均换 '-'（生产实测 /root/.claude → -root--claude）", () => {
    expect(claudeCwdSlug('/root/.claude')).toBe('-root--claude');
    expect(claudeCwdSlug('/root/projects/studio')).toBe('-root-projects-studio');
  });
});

describe('claudeSessionFileExists', () => {
  let home: string;
  const cwd = '/root/projects/studio';
  const sessionId = 'sess-abc';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** 在 stub 的 HOME 下造 <cwd-slug>/<sessionId>.jsonl 会话文件 */
  function createSessionFile(id: string, forCwd = cwd): string {
    const dir = path.join(defaultClaudeProjectsDir(), claudeCwdSlug(forCwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '');
    return file;
  }

  it('会话文件在 → true；缺文件 / 异 cwd → false', () => {
    expect(claudeSessionFileExists(sessionId, cwd)).toBe(false);
    createSessionFile(sessionId);
    expect(claudeSessionFileExists(sessionId, cwd)).toBe(true);
    // 同 id 异 cwd（slug 不同）→ false
    expect(claudeSessionFileExists(sessionId, '/root/other')).toBe(false);
    // 同 cwd 异 id → false
    expect(claudeSessionFileExists('sess-other', cwd)).toBe(false);
  });

  it('projectsDir 参数注入优先于 HOME 推导', () => {
    const customDir = path.join(home, 'custom-projects');
    fs.mkdirSync(path.join(customDir, claudeCwdSlug(cwd)), { recursive: true });
    fs.writeFileSync(path.join(customDir, claudeCwdSlug(cwd), `${sessionId}.jsonl`), '');
    expect(claudeSessionFileExists(sessionId, cwd, customDir)).toBe(true);
    expect(claudeSessionFileExists(sessionId, cwd)).toBe(false);
  });
});

describe('shouldResumeSession', () => {
  let home: string;
  const cwd = '/root/projects/studio';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-resume-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('无 sessionId → false（一律新建）', () => {
    expect(shouldResumeSession('claude', undefined, cwd)).toBe(false);
    expect(shouldResumeSession('claude', null, cwd)).toBe(false);
    expect(shouldResumeSession('kimi', undefined, cwd)).toBe(false);
  });

  it('非 claude（kimi/codex/opencode 为 cwd 维度续用，无 id 文件可查）→ true', () => {
    expect(shouldResumeSession('kimi', 'sess-1', cwd)).toBe(true);
    expect(shouldResumeSession('codex', 'sess-1', cwd)).toBe(true);
    expect(shouldResumeSession('opencode', 'sess-1', null)).toBe(true);
  });

  it('claude + cwd 未知（workspaceRoot 解析不出）→ true（交给 CLI 错误 + 降级兜底）', () => {
    expect(shouldResumeSession('claude', 'sess-1', null)).toBe(true);
  });

  it('claude + cwd 已知：会话文件在 → true；文件缺 → false', () => {
    expect(shouldResumeSession('claude', 'sess-1', cwd)).toBe(false);
    const dir = path.join(home, '.claude', 'projects', claudeCwdSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), '');
    expect(shouldResumeSession('claude', 'sess-1', cwd)).toBe(true);
  });
});

describe('RESUME_FAILURE_RE（降级触发条件）', () => {
  it('匹配「会话不存在」错误（大小写不敏感）', () => {
    expect(RESUME_FAILURE_RE.test('No conversation found with session ID sess-1')).toBe(true);
    expect(RESUME_FAILURE_RE.test('Session not found')).toBe(true);
  });

  it('非续用类错误不匹配（超时/spawn/业务失败）', () => {
    expect(RESUME_FAILURE_RE.test('CLI boom')).toBe(false);
    expect(RESUME_FAILURE_RE.test('timeout after 120s')).toBe(false);
    expect(RESUME_FAILURE_RE.test('spawn claude ENOENT')).toBe(false);
  });
});
