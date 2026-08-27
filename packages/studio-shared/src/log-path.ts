/**
 * 测试/生产日志路径隔离（P0 观测性修复 5）。
 *
 * 问题：vitest 运行时与生产共用 ~/.studio/logs 路径，O_APPEND 写同一批文件
 * 互相污染（tasks-YYYY-MM-DD.jsonl 曾 100% 是测试记录）。
 *
 * 约定：当 process.env.VITEST 或 NODE_ENV==='test' 时，日志统一改写到
 * os.tmpdir()/studio-test-logs/ 下（文件名格式不变）；生产行为不变。
 *
 * #361 自 apps/api utils/studio-log-path.ts 下沉：studio-agent 等 packages 的
 * 事件/日志写口（studio-events）需要同一隔离规则，实现必须住共享包。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { studioPath } from './config/studio-dir';

/** 是否测试环境（vitest 设置 VITEST=true；CI/脚本常用 NODE_ENV=test） */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test';
}

/**
 * 本测试进程（模块实例）唯一 id：pid + uuid。
 * vitest 并行下每个测试文件是独立 fork 进程/隔离模块图，本值 per 文件唯一（#135）。
 */
const TEST_RUN_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * 测试隔离子根：os.tmpdir()/<name>/<TEST_RUN_ID>。
 * 各并行测试文件各拿一份，afterEach/afterAll 整删自己那份不互踩（#135）；
 * 生产路径不经过本函数。
 */
export function testTmpRoot(name: string): string {
  return path.join(os.tmpdir(), name, TEST_RUN_ID);
}

/**
 * 日志根目录：测试 → os.tmpdir()/studio-test-logs；生产 → ~/.studio/logs。
 * 注意：生产日志都落在 ~/.studio/logs 下，测试隔离目录是平铺的，
 * 调用方保持原有文件名拼接即可（文件名格式不变）。
 */
export function resolveStudioLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return isTestEnv(env)
    ? path.join(os.tmpdir(), 'studio-test-logs')
    : studioPath('logs');
}

/** 解析 ~/.studio/logs 下某日志文件的实际路径（测试时改写到隔离目录，文件名不变） */
export function resolveStudioLogFile(fileName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStudioLogsDir(env), fileName);
}
