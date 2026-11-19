/**
 * runtime-paths — KNOWLEDGE_DIR / TUNNEL_URL_FILE 归数据根（#571）
 *
 * 冻结结论（docs/architecture/data-directory-contract.md §8 待归位）：
 * - KNOWLEDGE_DIR 缺省自 monorepo 相对路径迁至 studioPath('harness-knowledge')，env 可覆盖；
 * - TUNNEL_URL_FILE 自 ~/.claude/tunnel-url 迁至 studioPath('tunnel-url')，env 可覆盖。
 */

import { studioPath } from '@dommaker/studio-shared/studio-dir';

/** KNOWLEDGE_DIR 缺省值（env 已设则原样返回） */
export function defaultKnowledgeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.KNOWLEDGE_DIR || studioPath('harness-knowledge');
}

/** tunnel URL 落盘文件（契约 §2② 新条目 tunnel-url） */
export function tunnelUrlFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TUNNEL_URL_FILE || studioPath('tunnel-url');
}
