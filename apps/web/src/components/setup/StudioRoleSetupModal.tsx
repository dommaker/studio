/**
 * AC-2.2: studio 角色 provider=null 弹框提醒
 *
 * 检测到 studio 角色 provider 未配置时弹框，用户选 provider 后 PATCH 更新。
 * 用户关闭后 sessionStorage 标记，本次会话不再弹。
 *
 * #630（ADR 2026-09-23 决策 1）：退为壳——表单段换成 RoleFormModal 正本
 * （edit 模式 + initial=studio profile；name 输入对系统保留角色禁用，与服务端
 * STUDIO_ROLE_NAME 保护同口径）；本壳保留 dismiss 标记 + 系统角色说明语境。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { STUDIO_ROLE_SETUP_SESSION_KEY } from './dismissed';
import { RoleFormModal, type RoleFormInitial } from '../monitoring/RoleFormModal';

export interface StudioRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  /** studio 角色 profile（App 自 rosterStore 切片取；null/undefined = 未加载，不渲染） */
  profile?: RoleFormInitial | null;
  /** 保存成功后回调（App：强刷 roster 切片，防 store 残留 provider=null 触发重弹） */
  onSaved?: () => void;
}

export function StudioRoleSetupModal({ open, onClose, profile, onSaved }: StudioRoleSetupModalProps) {
  const handleDismiss = () => {
    try { sessionStorage.setItem(STUDIO_ROLE_SETUP_SESSION_KEY, '1'); } catch { /* sessionStorage 不可用 */ }
    onClose();
  };

  if (!profile) return null;

  // 表单段 = RoleFormModal 正本（edit）；onClose=handleDismiss（关窗即 sessionStorage 标记，
  // 保存成功走 onSaved → 直接 onClose 不标记，与原 onSave 语义一致）
  return (
    <RoleFormModal
      open={open}
      mode="edit"
      initial={profile}
      title="系统执行角色未配置"
      onClose={handleDismiss}
      onSaved={() => {
        onSaved?.();
        onClose();
      }}
    >
      <p className="u-text-2" style={{ margin: '0 0 12px', fontSize: 'var(--fs-sm)' }}>
        系统内部任务（知识维护、诊断、提取等）需要选择一个 CLI 作为执行角色。
      </p>
    </RoleFormModal>
  );
}
