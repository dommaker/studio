import React, { useEffect, useState } from 'react';
import { workspaceApi } from '../api';
import { channelApi } from '../api/channel';

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

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    setSelected(value);
    channelApi.update(channelId, { defaultWorkspaceId: value });
  };

  return (
    <select role="combobox" value={selected} onChange={handleChange}>
      <option value="">None</option>
      {workspaces.map((ws) => (
        <option key={ws.id} value={ws.id}>
          {ws.name}
        </option>
      ))}
    </select>
  );
};
