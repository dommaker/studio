// ChannelMessageEnv（#547）：Context 模块本体契约——缺 Provider → null（消息项各横切行为 fail-closed）；
// 挂 Provider → value 原样下发（消息项 useChannelMessageEnv() 自取横切值）。
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ChannelMessageEnvProvider, useChannelMessageEnv, type ChannelMessageEnv } from '../ChannelMessageEnv';

describe('ChannelMessageEnv（#547 频道消息环境）', () => {
  it('缺 Provider → useChannelMessageEnv 返回 null（fail-closed）', () => {
    const { result } = renderHook(() => useChannelMessageEnv());
    expect(result.current).toBeNull();
  });

  it('挂 Provider → value 原样下发（引用不变）', () => {
    const env: ChannelMessageEnv = {
      onAction: vi.fn(),
      onReply: vi.fn(),
      channelId: 'ch-1',
      onQuoteClick: vi.fn(),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChannelMessageEnvProvider value={env}>{children}</ChannelMessageEnvProvider>
    );
    const { result } = renderHook(() => useChannelMessageEnv(), { wrapper });
    expect(result.current).toBe(env);
    expect(result.current?.channelId).toBe('ch-1');
  });
});
