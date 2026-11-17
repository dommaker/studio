// AgentLoop 守卫函数区（2026-08 工单 28 从 agent-loop.ts 原样抽出，行为不变）：
// B2 测试特征 WU 守卫（防测试数据空烧 token）+ F4 评审解锚 excludeAssignee 解析。
// agent-loop.ts re-export 公开导出保持对外语义不变。
import type { WorkUnitMetadata } from '../workunit/index.js';

/** B2（2026-08-03 token-burn issue P0-1c）：测试特征 scope 判定 ——
 *  scope 中出现独立单词 test/tests 即视为测试 WU（命中历史污染源 'tree-tokens test' / 'test' 等）。
 *  仅作 daemon 兜底：正常隔离由 B1（测试独立数据根）保证，这里是防漏网的第二道。 */
const TEST_SCOPE_PATTERN = /(?:^|[\s\-_/:])tests?(?:[\s\-_/:]|$)/i;

/** B2 守卫开关：默认仅生产/开发进程启用；测试环境（NODE_ENV=test / VITEST）默认关闭
 *  （仓库自身单测用 scope 'test' 驱动 loop，守卫会误伤）；可用 STUDIO_TEST_WU_GUARD=on/off 显式覆盖。 */
export function testWuGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STUDIO_TEST_WU_GUARD === 'on') return true;
  if (env.STUDIO_TEST_WU_GUARD === 'off') return false;
  return env.NODE_ENV !== 'test' && !env.VITEST;
}

/** B2 测试特征 WU 判定：metadata 显式标记（test/testWorkUnit）或 scope 命中测试名单模式 */
export function isTestLikeWorkUnit(wu: { scope: string }, metadata: WorkUnitMetadata): boolean {
  if (metadata.test === true || metadata.testWorkUnit === true) return true;
  return TEST_SCOPE_PATTERN.test(wu.scope ?? '');
}

/** F4 + #720：普通评审排除单个实现者，整体评审排除全部实现者。 */
export function parseExcludeAssignees(metadata: unknown): string[] {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const record = m as { excludeAssignee?: unknown; excludeAssignees?: unknown } | null;
    const single = typeof record?.excludeAssignee === 'string' && record.excludeAssignee
      ? [record.excludeAssignee] : [];
    const multiple = Array.isArray(record?.excludeAssignees)
      ? record.excludeAssignees.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
    return [...new Set([...single, ...multiple])];
  } catch {
    return [];
  }
}
