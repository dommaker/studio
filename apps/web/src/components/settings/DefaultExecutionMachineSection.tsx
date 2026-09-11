// 默认执行机器 section（#286，决策 #251 Q2'）：远程 Workspace 绑定从频道顶栏挪入设置区，
// 正名「默认执行机器」= WU 在哪台远程机器上跑（执行 cwd 解析活链路，与「默认工程」= 本地 repo 分家）。
// 三修：
// - 非 Admin 读 workspaces 列表 403 → 明确「无权限」降级呈现（绑定值只读回显，不无限加载）
// - 孤儿绑定（绑定值指向已删除 workspace）→ 失效提示 + 一键解除绑定（PATCH ''）
// - 已绑定值正确回显：channels 数据加载完成后才渲染选择器，杜绝旧版 useState 初值只跑一次的回显 bug
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatChannelName } from '@dommaker/studio-shared/web';
import { workspaceApi } from '../../api';
import { channelApi, type Channel } from '../../api/channel';
import { Select, SkeletonText } from '../ui';
import { toast } from '../../utils/toast';
import { isForbidden } from '../../utils/http';
import { useAuthStore } from '../../stores/authStore';

interface Workspace {
  id: string;
  name: string;
  status?: string;
}

export function DefaultExecutionMachineSection() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  // 非 Admin：workspaces 列表 Admin-only（403）→ 降级只读呈现
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  // E8-1：保存成功轻反馈——Select 旁「✓ 已保存」2s 后淡出（失败仍走 toast）
  const [savedChannelId, setSavedChannelId] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const chRes = await channelApi.list();
        if (cancelled) return;
        // 归档频道（重命名 -archived- 后缀）不参与绑定管理
        setChannels((chRes.data?.data ?? []).filter((c) => !c.name.includes('-archived-')));
      } catch (err) {
        console.error('Failed to load channels:', err);
        toast.error('加载频道列表失败');
      }
      try {
        // #448 问题3：已知非 Admin 时 /workspaces 列表注定 403（Admin-only），
        // 不发请求直接走降级呈现；角色未知（未登录/初始化中）保持原请求路径
        const role = useAuthStore.getState().user?.role;
        if (role && role !== 'Admin') {
          if (!cancelled) setForbidden(true);
        } else {
          const wsRes = await workspaceApi.list();
          if (!cancelled) setWorkspaces(wsRes.data?.data ?? []);
        }
      } catch (err) {
        if (cancelled) return;
        if (isForbidden(err)) {
          setForbidden(true);
        } else {
          console.error('Failed to load workspaces:', err);
          toast.error('加载执行机器列表失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const bind = (channelId: string, workspaceId: string) => {
    channelApi
      .update(channelId, { defaultWorkspaceId: workspaceId })
      .then((res) => {
        const updated = res.data?.data;
        setChannels((prev) =>
          prev
            ? prev.map((c) =>
                c.id === channelId
                  ? { ...c, defaultWorkspaceId: updated?.defaultWorkspaceId ?? (workspaceId || null) }
                  : c,
              )
            : prev,
        );
        setSavedChannelId(channelId);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setSavedChannelId(null), 2000);
      })
      .catch((err) => {
        console.error('Failed to update default execution machine:', err);
        toast.error('保存默认执行机器失败');
      });
  };

  const workspaceIds = new Set((workspaces ?? []).map((w) => w.id));
  const isOrphan = (c: Channel) => !!c.defaultWorkspaceId && !workspaceIds.has(c.defaultWorkspaceId);

  return (
    <section className="space-y-4">
      <h2 className="mc-block-label mc-block-label-flush">默认执行机器</h2>
      <p className="text-sm u-text-2">
        每个频道的任务在哪台机器跑（远程 Workspace，决定执行目录的解析）；
        与频道顶栏的「默认工程」（本地 repo）是两个概念。不绑定时按频道与需求的归属关系自动解析。
      </p>
      <div className="card p-4 space-y-3">
        {loading ? (
          <SkeletonText lines={2} className="space-y-2" />
        ) : forbidden ? (
          // 非 Admin 降级：workspaces 列表 Admin-only，绑定值只读回显，不出选择器
          <>
            <p className="text-sm u-text-2">
              当前账号无权限管理执行机器（需 Admin 权限）。以下为各频道当前绑定的只读视图：
            </p>
            {(channels ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium truncate">{formatChannelName(c.name)}</span>
                <span className="text-xs u-text-2 truncate">{c.defaultWorkspaceId ?? '无'}</span>
              </div>
            ))}
          </>
        ) : (
          (channels ?? []).map((c) =>
            isOrphan(c) ? (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium truncate">{formatChannelName(c.name)}</span>
                  <span className="text-xs block truncate" style={{ color: 'var(--error)' }}>
                    绑定已失效（执行机器 {c.defaultWorkspaceId} 已删除）
                  </span>
                </div>
                <button
                  className="btn btn-secondary text-sm shrink-0"
                  onClick={() => bind(c.id, '')}
                >
                  解除绑定
                </button>
              </div>
            ) : (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium truncate">{formatChannelName(c.name)}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {savedChannelId === c.id && (
                    <span className="text-xs u-ok" data-testid={`exec-machine-saved-${c.id}`}>✓ 已保存</span>
                  )}
                  <Select
                    value={c.defaultWorkspaceId ?? ''}
                    onChange={(v) => bind(c.id, v)}
                    options={[
                      { value: '', label: '无' },
                      ...(workspaces ?? []).map((w) => ({ value: w.id, label: w.name })),
                    ]}
                    placeholder="无"
                    data-testid={`exec-machine-select-${c.id}`}
                    title={`${formatChannelName(c.name)} 的默认执行机器`}
                  />
                </div>
              </div>
            ),
          )
        )}
      </div>
      {/* E8-1：机器详情入口——WorkspacePage 原无站内入口，机器名直链 /workspaces/:id（仅 Admin 拿到清单时呈现） */}
      {workspaces && workspaces.length > 0 && (
        <p className="text-sm u-text-2">
          执行机器详情：
          {workspaces.map((w, i) => (
            <span key={w.id}>
              {i > 0 && ' · '}
              <Link to={`/workspaces/${w.id}`} className="u-accent">{w.name}</Link>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
