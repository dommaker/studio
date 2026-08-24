// 负责人展示标签（#290 清单 #24）——解析到角色名则渲染 @名字 并链到 /agents/:roleId；
// 查不到回退短 UUID（span，不可点）。WU 抽屉负责人行 / REQ 链路节点共用。
import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { useAssigneeDisplay } from '../../hooks/useAssigneeDisplay';

interface AssigneeLabelProps {
  assigneeId: string;
  className?: string;
  style?: CSSProperties;
}

export function AssigneeLabel({ assigneeId, className, style }: AssigneeLabelProps) {
  const display = useAssigneeDisplay(assigneeId);
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
