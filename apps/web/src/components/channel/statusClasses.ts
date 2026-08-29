// 频道/agent 状态点样式映射（从 ChannelRail.tsx 拆出共用）

/** agent 状态 → 状态点修饰类（active=执行中 pulse / idle=在线 / error=故障 / 其余=离线） */
export function agentDotClass(status: string): string {
  if (status === 'active') return 'mc-dot mc-dot-busy';
  if (status === 'idle') return 'mc-dot mc-dot-online';
  if (status === 'error') return 'mc-dot mc-dot-error';
  return 'mc-dot mc-dot-offline';
}
