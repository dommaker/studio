// 负责人展示标签（#290 清单 #24）——解析到角色名则渲染 @名字 并链到 /agents/:roleId；
// 查不到回退短 UUID（span，不可点）。WU 抽屉负责人行 / REQ 链路节点共用。
import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { useAssigneeDisplay } from '../../hooks/useAssigneeDisplay';

interface AssigneeLabelProps {
  assigneeId: string;
  /** 认领时的 roleId 快照（有则优先按快照解析，兼容旧 WU 缺省） */
  assigneeRoleId?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function AssigneeLabel({ assigneeId, assigneeRoleId, className, style }: AssigneeLabelProps) {
  const display = useAssigneeDisplay(assigneeId, assigneeRoleId);
  if (display) {
    return (
      <Link to={`/agents/${display.roleId}`} className={className} style={style} title="认领 Agent">
        @{display.name}
      </Link>
    );
  }
  return (
    <span className={className} style={style} title="认领 Agent（查不到对应角色，显示实例短 id）">
      @{assigneeId.slice(0, 8)}
    </span>
  );
}
