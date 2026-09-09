// errorMessage — 错误文案提取唯一出口（2026-09 批次A 项6，以 BlockedActions 提取逻辑为正本收敛）。
// serverErrorMessage：仅服务端 error 信封的 message（409 拒绝原因等对人可读），取不到返回 null；
// errorMessage：信封优先，回退 Error.message（axios 裸 message 如 "Request failed with status code 500"
// 对人不可读，toast 场景应走 serverErrorMessage + 通用文案回退，参照 CreateOkrDialog）。
import axios from 'axios';

/** 服务端 error 信封 message（无信封 → null） */
export function serverErrorMessage(e: unknown): string | null {
  if (axios.isAxiosError(e)) {
    const msg = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (msg) return msg;
  }
  return null;
}

/** 内联错误文案：信封 message 优先，回退 Error.message / String(e) */
export function errorMessage(e: unknown): string {
  return serverErrorMessage(e) ?? (e instanceof Error ? e.message : String(e));
}
