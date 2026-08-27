/**
 * 薄壳转发（#361）：实现下沉 @dommaker/studio-shared/src/log-path.ts，
 * studio-agent 等 packages 的日志写口需要同一隔离规则。
 * apps/api 内部调用方保持原 import 路径不变。
 */
export {
  isTestEnv,
  testTmpRoot,
  resolveStudioLogsDir,
  resolveStudioLogFile,
} from '@dommaker/studio-shared';
