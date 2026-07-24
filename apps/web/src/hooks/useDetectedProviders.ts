// 运行环境 CLI 探测 hook — 2026-07 频道角色修复
// 数据源：GET /workspaces/runtimes（服务端聚合前会对本机做 best-effort 重扫，
// 扫描实现见 apps/api/src/modules/workspaces/local-workspace.ts → daemon/cli-scanner.ts）
import { useEffect, useState } from 'react';
import { api } from '../api';

export interface DetectedProvider {
  provider: string;
  version: string;
  workspaceName: string;
  nodeId: string;
}

/** 内置 CLI provider（与 packages/studio-shared/src/providers.ts 的 BUILTIN_PROVIDERS 对齐） */
export const BUILTIN_PROVIDERS = ['claude', 'kimi', 'codex', 'opencode'] as const;

interface RuntimesResponse {
  runtimes?: Array<{ nodeId: string; provider: string; version: string; workspaceName: string }>;
}

/**
 * 当前运行环境已安装的 agent CLI 列表。
 * - detected：扫到的 provider（内置顺序优先，用户扩展的按字母序附后），附版本号
 * - noneDetected：一个都没扫到（未安装/扫描失败）——调用方应回退到全量可选，避免卡死用户
 */
export function useDetectedProviders() {
  const [detected, setDetected] = useState<DetectedProvider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get<RuntimesResponse>('/workspaces/runtimes')
      .then((res) => {
        if (cancelled) return;
        const byProvider = new Map<string, DetectedProvider>();
        for (const rt of res.data.runtimes ?? []) {
          if (!rt?.provider || byProvider.has(rt.provider)) continue;
          byProvider.set(rt.provider, {
            provider: rt.provider,
            version: rt.version ?? '',
            workspaceName: rt.workspaceName ?? '',
            nodeId: rt.nodeId ?? '',
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
      })
      .catch(() => {
        if (!cancelled) setDetected([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { detected, loading, noneDetected: !loading && detected.length === 0 };
}

export interface ProviderOption {
  value: string;
  label: string;
  disabled: boolean;
}

function shortVersion(v: string): string {
  return v.length > 24 ? `${v.slice(0, 24)}…` : v;
}

/**
 * 构造 provider 下拉选项：
 * 已检测到的可选（带版本）；未检测到的内置项禁用展示；
 * 一个都没检测到时全部回退可选（由调用方配提示文案）。
 */
export function buildProviderOptions(detected: DetectedProvider[], noneDetected: boolean): ProviderOption[] {
  if (noneDetected) {
    return BUILTIN_PROVIDERS.map((p) => ({ value: p, label: p, disabled: false }));
  }
  const detectedSet = new Set(detected.map((d) => d.provider));
  const options: ProviderOption[] = detected.map((d) => ({
    value: d.provider,
    label: d.version && d.version !== 'unknown' ? `${d.provider}（${shortVersion(d.version)}）` : d.provider,
    disabled: false,
  }));
  for (const p of BUILTIN_PROVIDERS) {
    if (!detectedSet.has(p)) {
      options.push({ value: p, label: `${p}（未检测到）`, disabled: true });
    }
  }
  return options;
}
