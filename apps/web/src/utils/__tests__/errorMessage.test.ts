// errorMessage（2026-09 批次A 项6）：服务端 error 信封优先 / 回退 Error.message 的提取契约
import { describe, it, expect } from 'vitest';
import { AxiosError } from 'axios';
import { errorMessage, serverErrorMessage } from '../errorMessage';

const axiosErr = (status: number, data?: unknown) =>
  new AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data,
  } as never);

describe('serverErrorMessage', () => {
  it('axios 错误带 error 信封 → 透传服务端 message（409 人话）', () => {
    const e = axiosErr(409, { error: { message: '该提案已被审核，不可重复操作' } });
    expect(serverErrorMessage(e)).toBe('该提案已被审核，不可重复操作');
  });

  it('axios 错误无信封 → null（调用方回退通用文案）', () => {
    expect(serverErrorMessage(axiosErr(500, {}))).toBeNull();
    expect(serverErrorMessage(axiosErr(500))).toBeNull();
  });

  it('非 axios 错误 → null', () => {
    expect(serverErrorMessage(new Error('boom'))).toBeNull();
    expect(serverErrorMessage('boom')).toBeNull();
  });
});

describe('errorMessage', () => {
  it('信封 message 优先于 axios 裸 message', () => {
    const e = axiosErr(409, { error: { message: '状态机不允许该迁移' } });
    expect(errorMessage(e)).toBe('状态机不允许该迁移');
  });

  it('无信封回退 Error.message；非 Error 回退 String', () => {
    expect(errorMessage(axiosErr(500))).toBe('Request failed with status code 500');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('boom')).toBe('boom');
  });
});
