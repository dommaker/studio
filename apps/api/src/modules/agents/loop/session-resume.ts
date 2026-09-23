/**
 * #94 会话续用判定（会话号 per-WU 化）：纯函数，零服务依赖。
 *
 * 续用候选号只信任务档案：claude 信 metadata.sessionId（档案会话号 UUID 即 claude
 * CLI 真实会话号，`--session-id <uuid>` 建会话）；kimi/codex/opencode 信
 * metadata.cliSessionId（#639：CLI 真实会话号，由 extractCliSessionId 从流内解析落盘
 * ——自建 UUID 这三家 CLI 不认识，cwd 维度续用已撤除，见 #637 串扰）。
 * claude 会话按 (HOME, cwd) 落盘为 ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 * （2.1.80 实测：异 cwd --resume 报 "No conversation found with session ID"），
 * 因此续用前可按 cwd 校验会话文件存在性；非 claude 无 id 对应文件可查
 * （会话池为机器全局 × cwd，实证见 studio-agent cli-adapter 头部），只判候选号有无，
 * 编号失效由 CLI 报错 + #94 降级链兜底。
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
 * 续用判定：只信档案候选号（claude = metadata.sessionId；非 claude = metadata.cliSessionId，
 * 由调用方选取传入）。
 *  - 无候选号 → false（#639：非 claude 无 CLI 会话号即新建，不再 cwd 维度「接最新」）
 *  - 非 claude（无 id 文件可查）→ true（编号失效交给 CLI 错误 + #94 降级链兜底）
 *  - claude 且 cwd 未知（workspaceRoot 解析不出）→ true（无法校验，交给 CLI 错误 + 降级兜底）
 *  - claude 且 cwd 已知 → 会话文件存在性
 */
export function shouldResumeSession(provider: string, sessionId: string | undefined | null, cwd: string | null): boolean {
  if (!sessionId) return false;
  if (provider !== 'claude') return true;
  if (!cwd) return true;
  return claudeSessionFileExists(sessionId, cwd);
}

/** 续用失败错误识别（降级触发条件）：「会话不存在」类。
 *  claude "No conversation found" / kimi·opencode "Session not found" /
 *  codex "no rollout found for thread id"（0.154.0 #639 冒烟实测） */
export const RESUME_FAILURE_RE = /no conversation found|session not found|no rollout found/i;
