/**
 * F1 provider 默认选取工具（2026-07-28 内置角色与信任模型分析，决策见
 * docs/plans/2026-07-28-builtin-roles-trust-model-analysis.md）：
 *
 * 从本机 CLI 扫描结果（daemon/cli-scanner.scanAllProviders）选默认 provider，
 * 替代旧语义"provider=null + 运行时隐式兜底 claude"——配置透明化：
 * 任何角色创建路径（agent-profile.service.create）不设 provider 时打戳为
 * 扫描到的默认值；一个 CLI 都没扫到则保持 null + warning（健康探测失败会
 * 记录 startup-fatal，UI 可见；FirstRoleSetupModal 的 noneDetected 文案兜底提示）。
 *
 * backfillProfileProviders：启动时一次性回填存量 provider 为空的 active 角色
 * （不含 studio —— studio 的 provider 由 StudioRoleSetupModal 引导用户显式选择，
 * 系统身份模型档位是用户决策，不自动打戳）。幂等：provider 非空不动。
 */
import { logger, type FileStore } from '@dommaker/studio-shared';
import { scanAllProviders, type DetectedRuntime } from '../../daemon/cli-scanner.js';

// 与 agent-profile.service.ts 的 STUDIO_ROLE_NAME 同值；就地写字面量避免循环import
// （service.ts 也 import 本文件的 resolveDefaultProvider）
const STUDIO_ROLE = 'studio';

/** 选默认 provider：扫描结果第一个（注册表顺序）。扫不到返回 null。 */
export function resolveDefaultProvider(
  scan: () => DetectedRuntime[] = scanAllProviders,
): string | null {
  const detected = scan();
  const first = detected[0]?.provider ?? null;
  if (!first) {
    logger.warn('[DefaultProvider] 未检测到任何 agent CLI（claude/kimi/codex/opencode），新建角色将无可用执行体');
  }
  return first;
}

/**
 * 回填存量角色的空 provider。返回打戳数量。
 * 幂等；scan 可注入（测试）；扫不到 CLI 时不动任何角色（warning 已由 resolveDefaultProvider 发出）。
 */
export async function backfillProfileProviders(
  fileStore: FileStore,
  scan: () => DetectedRuntime[] = scanAllProviders,
): Promise<number> {
  const provider = resolveDefaultProvider(scan);
  if (!provider) return 0;
  const all = await fileStore.listProfiles();
  let stamped = 0;
  for (const p of all) {
    if (p.name === STUDIO_ROLE || p.status !== 'active' || p.provider) continue;
    await fileStore.updateProfile(p.id, { provider });
    stamped++;
    logger.info('[DefaultProvider] Backfilled profile provider', { name: p.name, provider });
  }
  return stamped;
}
