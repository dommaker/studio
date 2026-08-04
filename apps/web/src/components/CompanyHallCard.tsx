// CompanyHallCard - 公司大厅卡片组件
import { useState, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface HallCardProps {
  // 卡片基本信息
  icon: string;
  title: string;
  description?: string;
  to?: string; // 路由跳转
  
  // 状态数据
  stats?: {
    label: string;
    value: string | number;
    color?: 'default' | 'success' | 'warning' | 'danger';
  }[];
  
  // 操作按钮
  action?: {
    label: string;
    onClick?: () => void;
  };
  
  // 样式
  variant?: 'default' | 'primary' | 'accent';
  className?: string;
  
  // children（自定义内容）
  children?: ReactNode;
}

const variantStyles = {
  default: {
    background: 'var(--accent-dim)',
    border: '2px solid transparent',
    hoverBorder: '2px solid var(--accent-primary)',
  },
  primary: {
    background: 'var(--success-dim)',
    border: '2px solid var(--success)',
    hoverBorder: '2px solid var(--success)',
  },
  accent: {
    background: 'var(--warning-dim)',
    border: '2px solid transparent', // 默认无边框
    hoverBorder: '2px solid transparent',
  },
};

const colorMap = {
  default: 'var(--text-secondary)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--error)',
};

export function CompanyHallCard({
  icon,
  title,
  description,
  to,
  stats,
  action,
  variant = 'default',
  className = '',
  children,
}: HallCardProps) {
  const style = variantStyles[variant];
  
  // 点击动效状态
  const [isPressed, setIsPressed] = useState(false);
  const [showBorder, setShowBorder] = useState(false);
  
  // 点击时展示边框 + 按下效果
  const handleMouseDown = useCallback(() => {
    setIsPressed(true);
    setShowBorder(true);
  }, []);
  
  const handleMouseUp = useCallback(() => {
    setIsPressed(false);
    // 边框延迟消失（动画效果）
    setTimeout(() => setShowBorder(false), 300);
  }, []);
  
  const handleMouseLeave = useCallback(() => {
    setIsPressed(false);
  }, []);
  
  const cardContent = (
    <>
      {/* 头部：图标 + 标题 */}
      <div className="flex items-center gap-3 mb-3">
        <div 
          className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
          style={{ 
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate" style={{ color: 'var(--text-primary)', fontSize: '16px' }}>
            {title}
          </div>
          {description && (
            <div className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
              {description}
            </div>
          )}
        </div>
      </div>

      {/* 状态数据 */}
      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          {stats.map((stat, index) => (
            <div 
              key={index}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <span 
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {stat.label}:
              </span>
              <span 
                className="text-sm font-medium"
                style={{ color: colorMap[stat.color || 'default'] }}
              >
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 自定义内容 */}
      {children}

      {/* 操作按钮 */}
      {action && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {to ? (
            <Link
              to={to}
              className="btn btn-primary w-full text-center"
              style={{ padding: '8px 16px' }}
            >
              {action.label} →
            </Link>
          ) : (
            <button
              onClick={action.onClick}
              className="btn btn-primary w-full"
              style={{ padding: '8px 16px' }}
            >
              {action.label} →
            </button>
          )}
        </div>
      )}

      {/* 跳转箭头（无 action 时） */}
      {!action && to && (
        <div 
          className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ color: 'var(--accent-primary)' }}
        >
          →
        </div>
      )}
    </>
  );

  const cardStyle = {
    background: style.background,
    border: showBorder && variant === 'accent' ? '2px solid var(--warning)' : style.border,
    transform: isPressed ? 'scale(0.98)' : 'scale(1)',
    boxShadow: isPressed ? 'var(--shadow-sm)' : 'none',
    transition: 'all 0.2s ease',
  };

  const cardProps = {
    className: `block relative p-4 rounded-xl transition-all group ${className}`,
    style: cardStyle,
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
    onMouseLeave: handleMouseLeave,
  };

  if (to && !action) {
    return (
      <Link
        to={to}
        {...cardProps}
      >
        {cardContent}
      </Link>
    );
  }

  return (
    <div {...cardProps}>
      {cardContent}
    </div>
  );
}

export default CompanyHallCard;
