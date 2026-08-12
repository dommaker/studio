/**
 * #94 会话续用判定（会话号 per-WU 化）：纯函数，零服务依赖。
 *
 * 会话号只信任务档案 metadata.sessionId（实例单槽位已废弃——并行互踩 + 重启孤儿化）。
 * claude 会话按 (HOME, cwd) 落盘为 ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 * （2.1.80 实测：异 cwd --resume 报 "No conversation found with session ID"），
 * 因此续用前可按 cwd 校验会话文件存在性；kimi/codex/opencode 为 cwd 维度续用，
 * Studio 自建 UUID 对 CLI 无意义、无 id 对应文件可查（实证见 studio-agent cli-adapter 头部）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** cwd → claude projects 目录 slug：'/' 与 '.' 均换 '-'（生产实测：/root/.claude → -root--claude；下划线保留） */
export function claudeCwdSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** claude projects 根目录（os.homedir() POSIX 优先读 $HOME，测试可 stubEnv） */
export function defaultClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** claude 会话文件存在性：<projectsDir>/<cwd-slug>/<sessionId>.jsonl */
export function claudeSessionFileExists(sessionId: string, cwd: string, projectsDir?: string): boolean {
  return fs.existsSync(path.join(projectsDir ?? defaultClaudeProjectsDir(), claudeCwdSlug(cwd), `${sessionId}.jsonl`));
}

/**
 * 续用判定：只信档案 sessionId。
 *  - 无 sessionId → false
 *  - 非 claude（kimi/codex/opencode 为 cwd 维度续用，无 id 对应文件可查）→ true
 *  - claude 且 cwd 未知（workspaceRoot 解析不出）→ true（无法校验，交给 CLI 错误 + 降级兜底）
 *  - claude 且 cwd 已知 → 会话文件存在性
 */
export function shouldResumeSession(provider: string, sessionId: string | undefined | null, cwd: string | null): boolean {
  if (!sessionId) return false;
  if (provider !== 'claude') return true;
  if (!cwd) return true;
  return claudeSessionFileExists(sessionId, cwd);
}

/** 续用失败错误识别（降级触发条件）：「会话不存在」类 */
export const RESUME_FAILURE_RE = /no conversation found|session not found/i;
