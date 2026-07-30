// AuthorAvatar — 频道消息作者头像：人类 = 品牌色 + 用户名首字（用户传了 avatar 图则用图）；
// Agent = 名字 hash 稳定色 + 首字（同一角色恒定同色，无需后端加字段）。纯展示组件，无数据请求。
import { useAuthStore } from '../../stores/authStore';

/** 名字 → 稳定 hue（简单散列，同一名称跨会话恒定同色） */
function nameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

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

  const name = agentName || 'Agent';
  return (
    <span
      className="mc-avatar"
      style={{ background: `hsl(${nameHue(name)}, 55%, 38%)` }}
      title={name}
    >
      {initialOf(name)}
    </span>
  );
}
