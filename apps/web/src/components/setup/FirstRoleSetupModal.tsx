/**
 * AC-2.3（F2，2026-07-28）: 无已配置 provider 的用户角色时弹框提醒
 *
 * 检测到不存在任何 provider 非空的 active 角色（不含 studio）时弹框——
 * 角色存在但 provider 为空 = 没有可用执行体，与"没有角色"同样需要引导。
 * 用户填 name/description/provider 创建第一个角色。关闭后 sessionStorage 标记。
 *
 * #465（首用路径断点）：两步流——创建成功后不直接关窗，进「加入频道」引导步
 * （一键加入 #研发 / 跳过）；角色不进频道等于不存在（@mention 以频道成员为界、
 * loop 认领同口径）。创建失败保持原静默关窗语义（best-effort）。
 *
 * 样式遵循方向 A「Mission Control」设计体系（docs/specs/ui/style-guide.md），
 * 一律消费 theme.css 组件类（modal-* / input / btn），禁止内联写死颜色。
 */
import { useState } from 'react';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { FIRST_ROLE_SETUP_SESSION_KEY } from './dismissed';
import { Select, Modal } from '../ui';
import '../../styles/theme.css';

/** onCreate 成功时回传的创建结果（AgentProfile 最小子集，供「加入频道」步使用） */
export interface CreatedRole {
  id: string;
  name: string;
}

export interface FirstRoleSetupModalProps {
  open: boolean;
  onClose: () => void;
  /** 创建角色；成功返回创建结果（进「加入频道」引导步），失败返回 null（静默关窗） */
  onCreate: (data: { name: string; description?: string; provider?: string }) => Promise<CreatedRole | null>;
  /** #465：一键加入 #研发频道；返回是否成功（失败时引导步内联报错，不关窗） */
  onJoinChannel: (agentId: string) => Promise<boolean>;
}

export function FirstRoleSetupModal({ open, onClose, onCreate, onJoinChannel }: FirstRoleSetupModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // 用户显式选择的 CLI；空 = 未选过（或选择已失效），由下方派生值回退默认
  const [providerOverride, setProviderOverride] = useState<string>('');
  // #465 两步流：form = 创建表单 / join = 加入频道引导
  const [step, setStep] = useState<'form' | 'join'>('form');
  const [createdRole, setCreatedRole] = useState<CreatedRole | null>(null);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // #448 问题3：弹框关着不扫运行环境（App 根无条件挂载本组件，enabled=false 时才不发请求）
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders({ enabled: open });
  // 扫描进行中同样回退全量可选，避免加载窗口期无可选项
  const providerOptions = buildProviderOptions(detected, providersLoading || noneDetected);

  // 生效的 provider 为渲染期纯派生（替代原 effect 同步回填）：显式选择仍有效则用选择，
  // 否则回退第一个可用 CLI——选项异步晚到自动回填、选择失效自动回退的语义不变
  const provider = providerOverride && providerOptions.some((o) => o.value === providerOverride && !o.disabled)
    ? providerOverride
    : providerOptions.find((o) => !o.disabled)?.value ?? '';

  // 弹窗打开时在渲染期同步重置表单（prevOpen 上升沿，替代原 effect 同步重置）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName('');
      setDescription('');
      setStep('form');
      setCreatedRole(null);
      setJoinError(null);
    }
  }

  if (!open) return null;

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const created = await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        provider,
      });
      if (created) {
        // #465：创建成功 → 接续引导「加入频道」（不直接关窗）
        setCreatedRole(created);
        setStep('join');
      } else {
        onClose(); // 创建失败：保持原静默关窗语义
      }
    } finally {
      setCreating(false);
    }
  };

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
    // 批次 I-2：收编 ui/Modal（§4.3 正本）
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

  // 批次 I-2：收编 ui/Modal（§4.3 正本）；onClose=handleDismiss（关窗即 sessionStorage 标记）
  return (
    <Modal
      onClose={handleDismiss}
      maxWidth="400px"
      title="请创建角色"
      footer={
        <>
          <button className="btn btn-secondary" onClick={handleDismiss} disabled={creating}>稍后</button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={!name.trim() || !provider || creating}
            data-testid="first-role-create"
          >
            {creating ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
          <p className="u-text-2 text-sm mb-3">
            Agent Network 需要至少一个角色才能接收任务。请创建你的第一个角色。
          </p>
          <div className="mb-3">
            <label htmlFor="first-role-name" className="form-label">名称</label>
            <input
              id="first-role-name"
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 dev-agent、reviewer"
              style={{ width: '100%' }}
              data-testid="first-role-name"
            />
          </div>
          <div className="mb-3">
            <label htmlFor="first-role-desc" className="form-label">描述（可选）</label>
            <input
              id="first-role-desc"
              type="text"
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="角色职责说明"
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label htmlFor="first-role-provider" className="form-label">CLI</label>
            <Select
              id="first-role-provider"
              className="input"
              value={provider}
              onChange={setProviderOverride}
              options={providerOptions}
              style={{ width: '100%' }}
              data-testid="first-role-provider"
            />
            {noneDetected && (
              <p className="u-text-2 text-sm mt-1.5">
                未在服务器上检测到已安装的 CLI，请确认安装后再选择。
              </p>
            )}
          </div>
    </Modal>
  );
}
