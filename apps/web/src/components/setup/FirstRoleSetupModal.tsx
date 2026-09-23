/**
 * AC-2.3（F2，2026-07-28）: 无已配置 provider 的用户角色时弹框提醒
 *
 * 检测到不存在任何 provider 非空的 active 角色（不含 studio）时弹框——
 * 角色存在但 provider 为空 = 没有可用执行体，与"没有角色"同样需要引导。
 * 用户填 name/description/provider 创建第一个角色。关闭后 sessionStorage 标记。
 *
 * #465（首用路径断点）：两步流——创建成功后不直接关窗，进「加入频道」引导步
 * （一键加入 #研发 / 跳过）；角色不进频道等于不存在（@mention 以频道成员为界、
 * loop 认领同口径）。
 *
 * #630（ADR 2026-09-23 决策 1）：退为壳——表单段换成 RoleFormModal 正本
 * （provider 候选/校验/提交/错误行/pending 锁存全部归正本）；本壳保留 dismiss 标记 +
 * 「加入频道」两步流语境。创建失败语义归一为正本「内联报错留窗」，原静默关窗退役。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { useState } from 'react';
import { FIRST_ROLE_SETUP_SESSION_KEY } from './dismissed';
import { Modal } from '../ui';
import { RoleFormModal } from '../monitoring/RoleFormModal';

/** onSaved 成功时回传的创建结果（AgentProfile 最小子集，供「加入频道」步使用） */
export interface CreatedRole {
  id: string;
  name: string;
}

export interface FirstRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  /** #630：创建成功后回调（App：强刷 roster 切片让新角色即时可见，同 StudioRoleSetupModal 先例） */
  onCreated?: () => void;
  /** #465：一键加入 #研发频道；返回是否成功（失败时引导步内联报错，不关窗） */
  onJoinChannel: (agentId: string) => Promise<boolean>;
}

export function FirstRoleSetupModal({ open, onClose, onCreated, onJoinChannel }: FirstRoleSetupModalProps) {
  // #465 两步流：form = 创建表单（RoleFormModal 正本）/ join = 加入频道引导
  const [step, setStep] = useState<'form' | 'join'>('form');
  const [createdRole, setCreatedRole] = useState<CreatedRole | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // 弹窗打开时在渲染期同步重置两步流状态（prevOpen 上升沿；表单域状态由正本自管同模式）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setStep('form');
      setCreatedRole(null);
      setJoinError(null);
    }
  }

  if (!open) {
    // 关窗态仍渲染正本（open=false）：#448 懒扫描契约——useDetectedProviders 须以 enabled=false
    // 在调用栈出现（正本内部据此不发请求），而不是随壳早退消失
    return (
      <RoleFormModal open={false} mode="create" title="请创建角色" onClose={() => { /* 关窗态无关闭动作 */ }} onSaved={() => {}} />
    );
  }

  const handleJoin = async () => {
    if (!createdRole || joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const ok = await onJoinChannel(createdRole.id);
      if (ok) {
        onClose();
      } else {
        setJoinError('加入失败，请稍后在频道顶栏 ⋯ 菜单的「成员」里手动添加');
      }
    } finally {
      setJoining(false);
    }
  };

  const handleDismiss = () => {
    try { sessionStorage.setItem(FIRST_ROLE_SETUP_SESSION_KEY, '1'); } catch { /* ignore */ }
    onClose();
  };

  if (step === 'join' && createdRole) {
    return (
      <Modal
        onClose={onClose}
        maxWidth="400px"
        title="角色已创建"
        footer={
          <>
            <button className="btn btn-secondary" onClick={onClose} disabled={joining}>跳过</button>
            <button
              className="btn btn-primary"
              onClick={handleJoin}
              disabled={joining}
              data-testid="first-role-join-channel"
            >
              {joining ? '加入中…' : '加入 #研发频道'}
            </button>
          </>
        }
      >
        <p className="u-text-2 text-sm mb-3">
          @{createdRole.name} 已创建。角色要加入频道才能接收任务和 @ 消息——把它加入 #研发 频道就可以开始派活了。
        </p>
        {joinError && (
          <p className="u-err text-sm mb-3">
            {joinError}
          </p>
        )}
      </Modal>
    );
  }

  // 表单步 = RoleFormModal 正本；onClose=handleDismiss（关窗即 sessionStorage 标记）
  return (
    <RoleFormModal
      open={open}
      mode="create"
      title="请创建角色"
      onClose={handleDismiss}
      onSaved={(profile) => {
        // 创建成功 → onCreated（roster 刷新）+ 接续引导「加入频道」（不直接关窗）；
        // 创建失败由正本内联报错留窗（决策 1）
        onCreated?.();
        setCreatedRole({ id: profile.id, name: profile.name });
        setStep('join');
      }}
    >
      <p className="u-text-2 text-sm mb-3">
        Agent Network 需要至少一个角色才能接收任务。请创建你的第一个角色。
      </p>
    </RoleFormModal>
  );
}
