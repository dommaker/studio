// isForbidden — axios 403 判定（#283：非 Admin 降级体验的组件层判定入口）
import { describe, it, expect } from 'vitest';
import { isForbidden } from '../http';

const axiosError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

describe('isForbidden', () => {
  it('识别 axios 403 响应错误', () => {
    expect(isForbidden(axiosError(403))).toBe(true);
  });

  it('401/500 等其他状态不算 403', () => {
    expect(isForbidden(axiosError(401))).toBe(false);
    expect(isForbidden(axiosError(500))).toBe(false);
  });

  it('无 response 的普通 Error 与空值不算 403', () => {
    expect(isForbidden(new Error('Network Error'))).toBe(false);
    expect(isForbidden(null)).toBe(false);
    expect(isForbidden(undefined)).toBe(false);
  });
});
