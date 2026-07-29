import React, { useEffect, useState } from 'react';
import { workspaceApi } from '../api';
import { channelApi } from '../api/channel';
import { Select } from './ui';

interface Workspace {
  id: string;
  name: string;
  status: string;
}

interface ChannelWorkspaceSettingProps {
  channelId: string;
  defaultWorkspaceId?: string;
}

export const ChannelWorkspaceSetting: React.FC<ChannelWorkspaceSettingProps> = ({
  channelId,
  defaultWorkspaceId,
}) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState(defaultWorkspaceId || '');

  useEffect(() => {
    workspaceApi.list().then((res) => {
      setWorkspaces(res.data.data);
    });
  }, []);

  const handleChange = (value: string) => {
    setSelected(value);
    channelApi.update(channelId, { defaultWorkspaceId: value });
  };

  return (
    <Select
      value={selected}
      onChange={handleChange}
      options={[
        { value: '', label: '默认工程：无' },
        ...workspaces.map((ws) => ({ value: ws.id, label: ws.name })),
      ]}
      className="mc-btn"
      title="默认工程"
    />
  );
};
