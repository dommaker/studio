// 创建角色弹框（#397，redesign §6.4：弹框不跳页——上下文不丢）
// #630（ADR 2026-09-23 决策 1/2）：退为壳——表单段换成 RoleFormModal 正本（单角色：一个 name +
// 一个 provider Select，多 CLI 批量勾选形态已删）；本壳只保留标题语境 + presetProvider → lockProvider
// 映射（WorkspacePage 行内「设为角色」）+ 保存语义（创建成功 → 关弹框 → onCreated 就地刷新名册，不跳页）。
import { RoleFormModal } from './RoleFormModal';

export function CreateRoleModal({ open, onClose, onCreated, presetProvider }: {
  open: boolean;
  onClose: () => void;
  /** 创建成功后回调（页面侧就地刷新名册） */
  onCreated: () => void;
  /** E8-4：调用方已锁定 CLI 时传入（WorkspacePage 行内「设为角色」）——映射为 RoleFormModal lockProvider */
  presetProvider?: string;
}) {
  return (
    <RoleFormModal
      open={open}
      mode="create"
      lockProvider={presetProvider}
      title="创建角色"
      onClose={onClose}
      onSaved={() => {
        // §6.4：保存 = 创建 → 关弹框 → onCreated（页面就地刷新名册），不跳页
        onCreated();
        onClose();
      }}
    />
  );
}
