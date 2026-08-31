// 默认执行机器 section（#286，决策 #251 Q2'）：远程 Workspace 绑定从频道顶栏挪入设置区，
// 正名「默认执行机器」= WU 在哪台远程机器上跑（执行 cwd 解析活链路，与「默认工程」= 本地 repo 分家）。
// 三修：
// - 非 Admin 读 workspaces 列表 403 → 明确「无权限」降级呈现（绑定值只读回显，不无限加载）
// - 孤儿绑定（绑定值指向已删除 workspace）→ 失效提示 + 一键解除绑定（PATCH ''）
// - 已绑定值正确回显：channels 数据加载完成后才渲染选择器，杜绝旧版 useState 初值只跑一次的回显 bug
import { useEffect, useState } from 'react';
import { workspaceApi } from '../../api';
import { channelApi, type Channel } from '../../api/channel';
import { Select } from '../ui';
import { toast } from '../../utils/toast';
import { isForbidden } from '../../utils/http';

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
        const wsRes = await workspaceApi.list();
        if (!cancelled) setWorkspaces(wsRes.data?.data ?? []);
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
      <h2 className="mc-block-label" style={{ margin: 0 }}>🖥️ 默认执行机器</h2>
      <p className="text-sm u-text-2">
        每个频道的任务在哪台机器跑（远程 Workspace，决定执行目录的解析）；
        与频道顶栏的「默认工程」（本地 repo）是两个概念。不绑定时按归属链自动解析。
      </p>
      <div className="card p-4 space-y-3">
        {loading ? (
          <p className="text-sm u-text-2">加载中…</p>
        ) : forbidden ? (
          // 非 Admin 降级：workspaces 列表 Admin-only，绑定值只读回显，不出选择器
          <>
            <p className="text-sm u-text-2">
              当前账号无权限管理执行机器（需 Admin 权限）。以下为各频道当前绑定的只读视图：
            </p>
            {(channels ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium truncate">#{c.name}</span>
                <span className="text-xs u-text-2 truncate">{c.defaultWorkspaceId ?? '无'}</span>
              </div>
            ))}
          </>
        ) : (
          (channels ?? []).map((c) =>
            isOrphan(c) ? (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium truncate">#{c.name}</span>
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
                <span className="text-sm font-medium truncate">#{c.name}</span>
                <Select
                  value={c.defaultWorkspaceId ?? ''}
                  onChange={(v) => bind(c.id, v)}
                  options={[
                    { value: '', label: '无' },
                    ...(workspaces ?? []).map((w) => ({ value: w.id, label: w.name })),
                  ]}
                  placeholder="无"
                  data-testid={`exec-machine-select-${c.id}`}
                  title={`#${c.name} 的默认执行机器`}
                />
              </div>
            ),
          )
        )}
      </div>
    </section>
  );
}
