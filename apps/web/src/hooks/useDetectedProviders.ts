// 运行环境 CLI 探测 hook — 2026-07 频道角色修复
// 数据源：GET /workspaces/runtimes（服务端返回前会对本机做 best-effort 重扫，
// 扫描实现见 apps/api/src/modules/workspaces/local-workspace.ts → daemon/cli-scanner.ts）
// 2026-09-10：端点收敛为本机 CLI 清单，nodeId / workspaceName 随远程节点方向废弃
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export interface DetectedProvider {
  provider: string;
  version: string;
  /** #565: 登录态三态；failed 时下拉标徽标 + 修复 hint，unknown 不标 */
  auth?: 'ok' | 'failed' | 'unknown';
  /** auth=failed 时的修复提示（服务端注册表 authProbe.authHint） */
  authHint?: string;
}

/** 内置 CLI provider（与 packages/studio-shared/src/providers.ts 的 BUILTIN_PROVIDERS 对齐） */
export const BUILTIN_PROVIDERS = ['claude', 'kimi', 'codex', 'opencode'] as const;

interface RuntimesResponse {
  runtimes?: Array<{ provider: string; version: string; auth?: 'ok' | 'failed' | 'unknown'; authHint?: string }>;
}

/**
 * 当前运行环境已安装的 agent CLI 列表。
 * - detected：扫到的 provider（内置顺序优先，用户扩展的按字母序附后），附版本号
 * - noneDetected：一个都没扫到（未安装/扫描失败）——调用方应回退到全量可选，避免卡死用户
 * - enabled=false 不发起请求（#403 懒挂载：成员面板首次展开才扫，不再进页即扫）；
 *   loading 保持 true，展开后发起且每次挂载只扫一次
 */
export function useDetectedProviders(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const [detected, setDetected] = useState<DetectedProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!enabled || requestedRef.current) return;
    requestedRef.current = true;
    api.get<RuntimesResponse>('/workspaces/runtimes')
      .then((res) => {
        const byProvider = new Map<string, DetectedProvider>();
        for (const rt of res.data.runtimes ?? []) {
          if (!rt?.provider || byProvider.has(rt.provider)) continue;
          byProvider.set(rt.provider, {
            provider: rt.provider,
            version: rt.version ?? '',
            auth: rt.auth,
            authHint: rt.authHint,
          });
        }
        const ordered = [
          ...BUILTIN_PROVIDERS.filter((p) => byProvider.has(p)).map((p) => byProvider.get(p)!),
          ...[...byProvider.keys()]
            .filter((p) => !(BUILTIN_PROVIDERS as readonly string[]).includes(p))
            .sort()
            .map((p) => byProvider.get(p)!),
        ];
        setDetected(ordered);
        setLoading(false);
      })
      .catch(() => {
        setDetected([]);
        setLoading(false);
      });
  }, [enabled]);

  return { detected, loading, noneDetected: !loading && detected.length === 0 };
}

export interface ProviderOption {
  value: string;
  label: string;
  disabled: boolean;
  /** #565: 选项行 tooltip（auth=failed 时放修复 hint） */
  title?: string;
  /** #565: 该 provider 的登录态（failed 时 label 已带徽标） */
  auth?: 'ok' | 'failed' | 'unknown';
}

function shortVersion(v: string): string {
  return v.length > 24 ? `${v.slice(0, 24)}…` : v;
}

/**
 * 构造 provider 下拉选项：
 * 已检测到的可选（带版本）；未检测到的内置项禁用展示；
 * 一个都没检测到时全部回退可选（由调用方配提示文案）。
 * #565 AC4：auth=failed 标「未登录」徽标 + title 放修复 hint；unknown 不标。
 */
export function buildProviderOptions(detected: DetectedProvider[], noneDetected: boolean): ProviderOption[] {
  if (noneDetected) {
    return BUILTIN_PROVIDERS.map((p) => ({ value: p, label: p, disabled: false }));
  }
  const detectedSet = new Set(detected.map((d) => d.provider));
  const options: ProviderOption[] = detected.map((d) => {
    const base = d.version && d.version !== 'unknown' ? `${d.provider}（${shortVersion(d.version)}）` : d.provider;
    if (d.auth === 'failed') {
      return {
        value: d.provider,
        label: `${base} ⚠ 未登录`,
        disabled: false,
        title: d.authHint ?? '该 CLI 未登录',
        auth: 'failed',
      };
    }
    return { value: d.provider, label: base, disabled: false, auth: d.auth };
  });
  for (const p of BUILTIN_PROVIDERS) {
    if (!detectedSet.has(p)) {
      options.push({ value: p, label: `${p}（未检测到）`, disabled: true });
    }
  }
  return options;
}
