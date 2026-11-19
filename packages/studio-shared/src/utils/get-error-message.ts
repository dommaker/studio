/**
 * getErrorMessage — 统一错误消息提取口径（#359；正本自 apps/api/src/utils/errors.ts 下沉本包）
 *
 * 替代手写 `err instanceof Error ? err.message : String(err)`：
 * Error → message；string → 原文；其他（number/null/object）→ 'Unknown error'。
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
