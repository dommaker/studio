// ChannelRoutingEditor — #466：频道级「阶段→角色」路由表编辑（一屏三行下拉）。
// plan(规划) / implement(执行) / review(评审) 各指名一个频道成员角色（存 profile id）；
// 留空（自动认领）= 该阶段回池涌现（现状）。成本结构一目了然：贵模型角色放 plan，
// 便宜模型角色放 implement，评审放第三家。
// 数据面：候选 = 频道成员（members 空 = 全部 active，对齐成员面板口径）；路由值
// 面板展开时经 channelApi.get 拉取；保存走 channelApi.update（乐观选中 + 失败回滚 toast，
// ChannelDefaultProjectSelect 同款模式）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { channelApi, type ChannelRouting } from '../../api/channel';
import { useRosterStore, activeAgentsOf } from '../../stores/rosterStore';
import { useChannelDataStore } from '../../stores/channelDataStore';
import { Select, type SelectOption } from '../ui';
import { toast } from '../../utils/toast';
import { serverErrorMessage } from '../../utils/errorMessage';

interface ChannelRoutingEditorProps {
  channelId: string;
  /** E1：顶栏 ⋯ 菜单收纳时传入菜单行类（默认 mc-btn 顶栏钮形态不变） */
  triggerClassName?: string;
}

const STAGES: { key: keyof ChannelRouting; label: string }[] = [
  { key: 'plan', label: '规划（需求→任务清单）' },
  { key: 'implement', label: '执行' },
  { key: 'review', label: '评审' },
];

export const ChannelRoutingEditor: React.FC<ChannelRoutingEditorProps> = ({ channelId, triggerClassName }) => {
  const memberIds = useChannelDataStore((s) => s.members[channelId]);
  const profiles = useRosterStore((s) => s.profiles);
  const [isOpen, setIsOpen] = useState(false);
  const [routing, setRouting] = useState<ChannelRouting>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // 切换频道时收起弹层（渲染期调整，成员面板同款）
  const [prevChannelId, setPrevChannelId] = useState(channelId);
  if (prevChannelId !== channelId) {
    setPrevChannelId(channelId);
    setIsOpen(false);
    setRouting({});
  }

  useEffect(() => {
    void useRosterStore.getState().ensureFresh();
  }, []);

  useEffect(() => {
    if (!channelId) return;
    void useChannelDataStore.getState().ensureMembers(channelId);
  }, [channelId]);

  // 面板展开时拉取当前路由表
  useEffect(() => {
    if (!isOpen || !channelId) return;
    let alive = true;
    channelApi.get(channelId)
      .then(res => { if (alive) setRouting(res.data?.data?.routing ?? {}); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isOpen, channelId]);

  // Close on outside click（例外：Select 选项面板 portal 到 body（.select-panel），点选项不收面板）
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current && panelRef.current.contains(target)) return;
      if (target instanceof Element && target.closest('.select-panel')) return;
      setIsOpen(false);
    };
    if (isOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // 候选 = 频道成员（active）；members 空 = 全部 active（「空 = 所有 Agent 可见」同口径）。
  // profiles 防御：页面测试/水合前 store 可能未就位（非数组按空列表降级）
  const allAgents = useMemo(() => activeAgentsOf(Array.isArray(profiles) ? profiles : []), [profiles]);
  const candidates = useMemo(
    () => (memberIds && memberIds.length > 0 ? allAgents.filter((a) => memberIds.includes(a.id)) : allAgents),
    [allAgents, memberIds],
  );

  // 乐观选中保留，失败回滚 + toast（ChannelDefaultProjectSelect 同款）
  const handleChange = (stage: keyof ChannelRouting, value: string) => {
    const prev = routing;
    const next = { ...routing, [stage]: value || null };
    setRouting(next);
    channelApi.update(channelId, { routing: next }).catch((e) => {
      setRouting(prev);
      const m = serverErrorMessage(e);
      toast.error(m ? `保存工单路由失败：${m}` : '保存工单路由失败，已恢复原值');
    });
  };

  const configuredCount = STAGES.filter((s) => routing[s.key]).length;

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={triggerClassName ?? 'mc-btn'}
        title="工单路由（阶段→角色）"
      >
        路由 <span>{configuredCount > 0 ? `${configuredCount}/3` : '自动'}</span>
      </button>

      {isOpen && (
        <div className="mc-mention-popup" style={{ left: 'auto', right: 0, bottom: 'auto', top: '100%', marginTop: 4, width: 320, maxHeight: 'none' }}>
          <div className="border-b u-border" style={{ padding: '8px 10px' }}>
            <h3 className="mc-card-body" style={{ fontWeight: 600 }}>工单路由</h3>
            <p className="mc-drawer-note">哪种活给哪个角色；留空 = 频道成员自动认领</p>
          </div>
          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {STAGES.map((s) => {
              const options: SelectOption[] = [
                { value: '', label: '自动认领（涌现）' },
                ...candidates.map((a) => ({ value: a.id, label: `@${a.name}` })),
              ];
              const selected = routing[s.key] ?? '';
              // 已配置角色不在候选集（被移出频道/inactive）时补一项回显，不丢配置
              if (selected && !options.some((o) => o.value === selected)) {
                options.push({ value: selected, label: `${selected}（不可用）` });
              }
              return (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mc-drawer-note" style={{ flex: '0 0 auto', margin: 0 }}>{s.label}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Select
                      value={selected}
                      onChange={(v) => handleChange(s.key, v)}
                      options={options}
                      className="input"
                      aria-label={`工单路由-${s.key}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
