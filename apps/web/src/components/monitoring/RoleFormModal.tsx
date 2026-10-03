// 角色表单唯一正本（#630，ADR 2026-09-23-role-form-module 决策 1/2/3）：
// 承载表单域全部逻辑——provider 候选（唯一来源 = useDetectedProviders + buildProviderOptions，
// 未检测到的内置 CLI 列禁用项、auth=failed 带「⚠ 未登录」徽标）、校验、提交、错误行、pending 锁存。
// create 收窄为单角色（一个 name + 一个 provider Select；多 CLI 批量勾选形态已删，ADR 否决备选）；
// #633（ADR 2026-09-23-role-preset-surface）：create 加「从模板开始」入口（preset 清单来自
// GET /agent-profiles/presets，服务端扫 .agents/roles/ 不硬编码；不选则手工填空，拉取失败降级仅手工）；
// edit 暴露 name/description/provider/persona/acceptedTypes（skills 不进表单——RoleSkillsModal 是技能编辑正本），
// PATCH 只带脏字段（幂等 + 不覆盖并发修改；studio 角色改名被服务端整体拒绝，脏字段diff是正本可提交前提），
// 409 名称冲突走服务端 message 内联报错留窗（创建/编辑同口径，#298）。
// 改 provider 即刻生效（#634）：provider 变更发布 agent-profile.updated（changedFields），
// registry 停旧 loop、等当前步跑完后以最新配置重挂——表单内 inline 提示「正在运行的实例
// 将在当前步结束后换用新 CLI（无需重启）」。
// 壳（CreateRoleModal / FirstRoleSetupModal / StudioRoleSetupModal）保留各自语境，表单段全部换本模块。
import { useEffect, useMemo, useState } from 'react';
import { channelApi, type AgentProfile } from '../../api/channel';
import type { RolePresetSummary } from '@dommaker/studio-contract';
import { useDetectedProviders, buildProviderOptions } from '../../hooks/useDetectedProviders';
import { Modal, Select } from '../ui';
import { errorMessage } from '../../utils/errorMessage';

/** edit 模式的预填 + PATCH 目标（AgentProfile 最小子集） */
export interface RoleFormInitial {
  id: string;
  name: string;
  description?: string | null;
  provider?: string | null;
  /** #633: 角色自述（prompt「## 你的角色」段内容） */
  persona?: string;
  /** #633: 职能域（阶段词表） */
  acceptedTypes?: string[];
}

/** 职能域文本 ↔ 数组：逗号/空白分隔，去空去重（显示用 ', ' 连接） */
function joinAcceptedTypes(types?: string[]): string {
  return (types ?? []).join(', ');
}

function parseAcceptedTypes(text: string): string[] {
  return [...new Set(text.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];
}

export interface RoleFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** create 限定：provider 锁定为只读展示（WorkspacePage 行内「设为角色」presetProvider 映射），锁定时不扫 runtime */
  lockProvider?: string;
  /** edit 必填：预填值 + PATCH 目标 id */
  initial?: RoleFormInitial;
  /** 壳覆盖标题；缺省 create=「创建角色」/ edit=「编辑资料 — @name」 */
  title?: string;
  onClose: () => void;
  /** 提交成功后回调（参数 = 服务端返回的 profile）；后续动作（关窗/进引导步/刷新名册）由壳决定 */
  onSaved: (profile: AgentProfile) => void;
  /** 壳语境文案（首用引导/系统角色说明等），渲染在表单上方 */
  children?: React.ReactNode;
}

/** 系统保留角色名（与服务端 STUDIO_ROLE_NAME 同口径）：edit 时 name 输入禁用——
 *  服务端拒绝一切 name='studio' 的 PATCH（含未改名幂等提交），正本直接不给入口 */
const RESERVED_ROLE_NAME = 'studio';

export function RoleFormModal({
  open, mode, lockProvider, initial, title, onClose, onSaved, children,
}: RoleFormModalProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  // 用户显式选择的 CLI；生效值为渲染期纯派生（显式选择仍有效则用选择，否则回退第一个可用项）
  const [providerOverride, setProviderOverride] = useState(initial?.provider ?? '');
  // #633: create 模板选择（'' = 手工创建不带 preset）；edit 的 persona/acceptedTypes
  const [preset, setPreset] = useState('');
  const [presetOptions, setPresetOptions] = useState<RolePresetSummary[]>([]);
  const [persona, setPersona] = useState(initial?.persona ?? '');
  const [acceptedTypesText, setAcceptedTypesText] = useState(joinAcceptedTypes(initial?.acceptedTypes));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // #633: create 打开时拉 preset 清单（服务端扫 .agents/roles/，目录演化免改前端）；
  // 拉取失败降级为空清单（只剩「手工创建」），不卡死表单
  useEffect(() => {
    if (!open || mode !== 'create') return;
    let cancelled = false;
    channelApi.listRolePresets()
      .then((res) => { if (!cancelled) setPresetOptions(res.data.data ?? []); })
      .catch(() => { if (!cancelled) setPresetOptions([]); });
    return () => { cancelled = true; };
  }, [open, mode]);

  // lockProvider 时跳过 runtime 扫描（preset 语义：单项固定预选，无需清单）
  const { detected, loading: providersLoading, noneDetected } = useDetectedProviders({ enabled: open && !lockProvider });
  // 扫描进行中同样回退全量可选，避免加载窗口期无可选项（同 FirstRoleSetupModal 先例）
  const providerOptions = useMemo(() => {
    const opts = buildProviderOptions(detected, providersLoading || noneDetected);
    // edit：当前 provider 不在可用候选（CLI 已卸载/自定义/仍在扫描）时补「当前」可选项，保住现状值不被回退冲掉
    const current = mode === 'edit' ? initial?.provider : undefined;
    if (current && !opts.some((o) => o.value === current && !o.disabled)) {
      return [
        { value: current, label: `${current}（当前）`, disabled: false },
        ...opts.filter((o) => o.value !== current),
      ];
    }
    return opts;
  }, [detected, providersLoading, noneDetected, mode, initial?.provider]);

  const provider = lockProvider ?? (
    providerOverride && providerOptions.some((o) => o.value === providerOverride && !o.disabled)
      ? providerOverride
      : providerOptions.find((o) => !o.disabled)?.value ?? ''
  );

  // 打开沿渲染期重置表单（prevOpen 上升沿，同 RoleSkillsModal 模式；
  // effect 内同步 setState 触发 react-hooks/set-state-in-effect）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
      setProviderOverride(initial?.provider ?? '');
      setPreset('');
      setPersona(initial?.persona ?? '');
      setAcceptedTypesText(joinAcceptedTypes(initial?.acceptedTypes));
      setError(null);
    }
  }

  // edit 脏字段派生（提交键禁用 + PATCH diff 共用同一口径；描述 trim 后空串 ≡ null）
  const trimmedName = name.trim();
  const trimmedDesc = description.trim();
  const nameDirty = mode === 'edit' && trimmedName !== (initial?.name ?? '');
  const descDirty = mode === 'edit' && trimmedDesc !== (initial?.description ?? '');
  const providerDirty = mode === 'edit' && provider !== (initial?.provider ?? '');
  // #633: persona trim 后比较（空白 ≡ 清空）；acceptedTypes 解析后按数组口径比较
  const personaDirty = mode === 'edit' && persona.trim() !== (initial?.persona ?? '').trim();
  const acceptedTypesDirty = mode === 'edit'
    && parseAcceptedTypes(acceptedTypesText).join(',') !== (initial?.acceptedTypes ?? []).join(',');
  const dirty = nameDirty || descDirty || providerDirty || personaDirty || acceptedTypesDirty;

  const nameReadonly = mode === 'edit' && initial?.name === RESERVED_ROLE_NAME;
  const submitDisabled = submitting || !trimmedName || (!lockProvider && !provider) || (mode === 'edit' && !dirty);

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'create') {
        const res = await channelApi.createAgent({
          name: trimmedName,
          description: trimmedDesc || undefined,
          provider,
          // #633: 选中模板才带 preset（预填逻辑在服务端 loadRolePreset，前端只传名）
          ...(preset ? { preset } : {}),
        });
        onSaved(res.data.data);
      } else {
        // 只 PATCH 脏字段：幂等、不覆盖并发修改；studio 角色改名被服务端整体拒绝，全量提交会恒败
        const diff: Partial<{ name: string; description: string | null; provider: string | null; persona: string | null; acceptedTypes: string[] }> = {};
        if (nameDirty) diff.name = trimmedName;
        if (descDirty) diff.description = trimmedDesc || null;
        if (providerDirty) diff.provider = provider || null;
        // #633: persona 空白 ≡ 清空（null）；acceptedTypes 清空 = []（与 skills 同口径）
        if (personaDirty) diff.persona = persona.trim() || null;
        if (acceptedTypesDirty) diff.acceptedTypes = parseAcceptedTypes(acceptedTypesText);
        const res = await channelApi.updateAgent(initial!.id, diff);
        onSaved(res.data.data);
      }
    } catch (e) {
      // 409 名称冲突等：服务端 error 信封 message 优先（errorMessage 收口），内联报错留窗
      setError((mode === 'create' ? '创建失败：' : '保存失败：') + errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? (mode === 'create' ? '创建角色' : `编辑资料 — @${initial?.name ?? ''}`)}
      maxWidth="440px"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>取消</button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitDisabled}
            data-testid="create-role-submit"
          >
            {mode === 'create'
              ? (submitting ? '创建中…' : '创建')
              : (submitting ? '保存中…' : '保存')}
          </button>
        </>
      }
    >
      {children}
      {mode === 'create' && (
        <div className="mb-3">
          <label htmlFor="role-form-preset" className="form-label">从模板开始（可选）</label>
          <Select
            id="role-form-preset"
            className="input"
            value={preset}
            onChange={setPreset}
            options={[
              { value: '', label: '手工创建（不使用模板）', disabled: false },
              ...presetOptions.map((p) => ({
                value: p.name,
                label: p.description ? `${p.name} — ${p.description}` : p.name,
                disabled: false,
              })),
            ]}
            style={{ width: '100%' }}
            data-testid="role-form-preset"
          />
          {preset && (
            <p className="u-text-2 text-sm mt-1.5">
              模板将带入描述、角色自述、职能域与技能声明；表单里显式填写的内容优先。
            </p>
          )}
        </div>
      )}
      <div className="mb-3">
        <label htmlFor="role-form-name" className="form-label">名称</label>
        <input
          id="role-form-name"
          type="text"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="角色名称（如 dev-agent）"
          style={{ width: '100%' }}
          disabled={nameReadonly}
          title={nameReadonly ? '系统保留角色名不可改' : undefined}
          data-testid="role-form-name"
        />
      </div>
      <div className="mb-3">
        <label htmlFor="role-form-desc" className="form-label">描述（可选）</label>
        <input
          id="role-form-desc"
          type="text"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="描述（可选）"
          style={{ width: '100%' }}
        />
      </div>
      {mode === 'edit' && (
        <>
          <div className="mb-3">
            <label htmlFor="role-form-persona" className="form-label">角色自述（persona，可选）</label>
            <textarea
              id="role-form-persona"
              className="input"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="prompt「## 你的角色」段内容；留空则清空"
              rows={4}
              style={{ width: '100%', resize: 'vertical' }}
              data-testid="role-form-persona"
            />
          </div>
          <div className="mb-3">
            <label htmlFor="role-form-accepted-types" className="form-label">职能域（acceptedTypes，逗号分隔，可选）</label>
            <input
              id="role-form-accepted-types"
              type="text"
              className="input"
              value={acceptedTypesText}
              onChange={(e) => setAcceptedTypesText(e.target.value)}
              placeholder="如 implement, review；留空则清空"
              style={{ width: '100%' }}
              data-testid="role-form-accepted-types"
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor="role-form-provider" className="form-label">CLI</label>
        {lockProvider ? (
          // lockProvider（WorkspacePage 行内「设为角色」）：provider 只读展示，不扫 runtime
          <div className="text-sm font-medium u-text">{lockProvider}</div>
        ) : (
          <Select
            id="role-form-provider"
            className="input"
            value={provider}
            onChange={setProviderOverride}
            options={providerOptions}
            style={{ width: '100%' }}
            data-testid="role-form-provider"
          />
        )}
        {!lockProvider && noneDetected && (
          <p className="u-text-2 text-sm mt-1.5">
            未检测到 CLI（已回退展示全部内置选项），请确认安装后再选择。
          </p>
        )}
        {providerDirty && (
          <p className="u-text-2 text-sm mt-1.5" data-testid="role-form-provider-hint">
            正在运行的实例将在当前步结束后换用新 CLI（无需重启）
          </p>
        )}
      </div>
      {error && <div className="u-err text-sm mt-2">{error}</div>}
    </Modal>
  );
}
