/**
 * 测试/生产日志路径隔离（P0 观测性修复 5）。
 *
 * 问题：vitest 运行时与生产共用 ~/.studio/logs 路径，O_APPEND 写同一批文件
 * 互相污染（tasks-YYYY-MM-DD.jsonl 曾 100% 是测试记录）。
 *
 * 约定：当 process.env.VITEST 或 NODE_ENV==='test' 时，日志统一改写到
 * os.tmpdir()/studio-test-logs/ 下（文件名格式不变）；生产行为不变。
 */
import * as os from 'node:os';
import * as path from 'node:path';

/** 是否测试环境（vitest 设置 VITEST=true；CI/脚本常用 NODE_ENV=test） */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test';
}

/**
 * 日志根目录：测试 → os.tmpdir()/studio-test-logs；生产 → ~/.studio/logs。
 * 注意：生产日志都落在 ~/.studio/logs 下，测试隔离目录是平铺的，
 * 调用方保持原有文件名拼接即可（文件名格式不变）。
 */
export function resolveStudioLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return isTestEnv(env)
    ? path.join(os.tmpdir(), 'studio-test-logs')
    : path.join(os.homedir(), '.studio', 'logs');
}

/** 解析 ~/.studio/logs 下某日志文件的实际路径（测试时改写到隔离目录，文件名不变） */
export function resolveStudioLogFile(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStudioLogsDir(env), fileName);
}
