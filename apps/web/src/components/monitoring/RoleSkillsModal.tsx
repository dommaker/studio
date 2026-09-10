// 角色技能编辑弹框（#462：role.skills 显式声明 → 注入索引候选，与 WU +skill 点名同权）
// 候选 = GET /skills/manifest（SKILL.md frontmatter 清单，loop-consumer 已被服务端过滤）；
// 保存 = PATCH /agent-profiles/:id { skills }（[] = 清空声明）。
// acceptedTypes 不进 UI（#462 scope 定稿：数据模型保留做长尾排序与子单 type 推导，交互退场）。
// 结构走 theme.css modal-*（style-guide §4.3，经 ui/Modal 壳）。
import { useEffect, useState } from 'react';
import { channelApi, type AgentProfile } from '../../api/channel';
import { skillsApi, type SkillManifestEntry } from '../../api/skills';
import { Modal, SkeletonText } from '../ui';
import { errorMessage } from '../../utils/errorMessage';

export function RoleSkillsModal({ open, profile, onClose, onSaved }: {
  open: boolean;
  profile: Pick<AgentProfile, 'id' | 'name'> & { skills?: string[] };
  onClose: () => void;
  /** 保存成功后回调（调用方刷新名册） */
  onSaved: () => void;
}) {
  const [options, setOptions] = useState<SkillManifestEntry[]>([]);
  const [selected, setSelected] = useState<string[]>(profile.skills ?? []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开沿渲染期重置（prevOpen 上升沿，同 CreateRoleModal 模式）
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setSelected(profile.skills ?? []);
      setError(null);
      setLoading(true);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    skillsApi.listManifest()
      .then((res) => { if (!cancelled) setOptions(res.data.data || []); })
      .catch(() => { if (!cancelled) setError('获取 skill 清单失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // 已声明但不在 MANIFEST 的 skill 并入候选（防保存时静默丢声明）
  const manifestNames = new Set(options.map((o) => o.name));
  const extraSelected = selected.filter((s) => !manifestNames.has(s));

  const toggle = (name: string) => {
    setSelected((prev) => prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]);
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await channelApi.updateAgent(profile.id, { skills: selected });
      onSaved();
      onClose();
    } catch (e) {
      setError('保存失败：' + errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`编辑技能 — @${profile.name}`}
      maxWidth="480px"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || loading}
            data-testid="role-skills-save"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <p className="u-text-3 text-xs m-0 mb-3">
        声明的 skill 会进入该角色每次执行的技能注入索引（与工单 +点名同权）；不控制接单范围。
      </p>
      {loading ? (
        <SkeletonText lines={5} className="space-y-2 py-2" />
      ) : (
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <label key={o.name} className="flex items-start gap-2 u-text text-sm" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                value={o.name}
                checked={selected.includes(o.name)}
                onChange={() => toggle(o.name)}
                style={{ accentColor: 'var(--accent-primary)', marginTop: '2px' }}
              />
              <span>
                <span className="font-medium">{o.name}</span>
                {o.description && <span className="u-text-3"> — {o.description}</span>}
              </span>
            </label>
          ))}
          {extraSelected.map((name) => (
            <label key={name} className="flex items-start gap-2 u-text text-sm" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                value={name}
                checked
                onChange={() => toggle(name)}
                style={{ accentColor: 'var(--accent-primary)', marginTop: '2px' }}
              />
              <span>
                <span className="font-medium">{name}</span>
                <span className="u-text-3"> — 不在 MANIFEST（已下架/改名）</span>
              </span>
            </label>
          ))}
          {options.length === 0 && extraSelected.length === 0 && (
            <div className="empty-state">skills MANIFEST 为空</div>
          )}
        </div>
      )}
      {error && <div className="u-err text-sm mt-2">{error}</div>}
    </Modal>
  );
}
