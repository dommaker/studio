// AuthorAvatar — 频道消息作者头像：人类 = 品牌色 + 用户名首字（用户传了 avatar 图则用图）；
// Agent = identicon 式确定性图形（#440：AgentAvatar，图样逻辑在 utils/avatar 纯函数，
// 同一角色恒定同图，无需后端加字段）。纯展示组件，无数据请求。
import { useAuthStore } from '../../stores/authStore';
import { AgentAvatar } from './AgentAvatar';

/** 首字（Array.from 兼容 emoji/CJK 代理对） */
function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

export function AuthorAvatar({ isHuman, agentName }: { isHuman: boolean; agentName?: string }) {
  const user = useAuthStore(s => s.user);

  if (isHuman) {
    const display = user?.name || user?.email || 'You';
    if (user?.avatar) {
      return <img className="mc-avatar" src={user.avatar} alt={display} title={display} />;
    }
    return (
      <span className="mc-avatar mc-avatar-human" title={display}>
        {initialOf(display)}
      </span>
    );
  }

  return <AgentAvatar name={agentName || 'Agent'} />;
}
