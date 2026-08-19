// #272（决策 #251 Q2'）：顶栏「默认工程」= 本地 repo 下拉。
// 数据源 = /projects/discover 本地工程发现（非 Admin-only workspaces 接口，非 Admin 可用）；
// 选中值落 channel.defaultPath（归属链「频道默认工程」rung 读取）。
// 「默认执行机器」（远程 Workspace）与默认工程分家，由 #286 挪设置区。
import React, { useEffect, useState } from 'react';
import { channelApi, type LocalProject } from '../../api/channel';
import { Select, type SelectOption } from '../ui';

interface ChannelDefaultProjectSelectProps {
  channelId: string;
  defaultPath?: string | null;
}

export const ChannelDefaultProjectSelect: React.FC<ChannelDefaultProjectSelectProps> = ({
  channelId,
  defaultPath,
}) => {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [selected, setSelected] = useState(defaultPath || '');
  // 外部值变化（如频道切换后 channel 重新加载）时同步选中态——渲染期间调整（react.dev 推荐模式，免 effect 级联渲染）
  const [prevDefaultPath, setPrevDefaultPath] = useState(defaultPath);
  if (defaultPath !== prevDefaultPath) {
    setPrevDefaultPath(defaultPath);
    setSelected(defaultPath || '');
  }

  useEffect(() => {
    let alive = true;
    channelApi.discoverProjects()
      .then(res => { if (alive) setProjects(res.data.data || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const handleChange = (value: string) => {
    setSelected(value);
    channelApi.update(channelId, { defaultPath: value }).catch(() => {});
  };

  const options: SelectOption[] = [
    { value: '', label: '默认工程：无' },
    ...projects.map(p => ({ value: p.path, label: p.name })),
  ];
  // 已绑定值不在发现候选集（目录移出扫描根等）时补一项回显，不丢绑定
  if (selected && !options.some(o => o.value === selected)) {
    options.push({ value: selected, label: selected });
  }

  return (
    <Select
      value={selected}
      onChange={handleChange}
      options={options}
      className="mc-btn"
      title="默认工程"
      aria-label="默认工程"
    />
  );
};
