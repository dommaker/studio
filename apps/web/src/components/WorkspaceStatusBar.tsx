import React, { useEffect, useState } from 'react';
import { workspaceApi } from '../api';

interface Runtime {
  id: string;
  provider: string;
  status: string;
  version: string;
}

interface Workspace {
  id: string;
  name: string;
  status: string;
  workspaceRoot: string;
  runtimes: Runtime[];
  _count: { runtimes: number };
}

export const WorkspaceStatusBar: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    workspaceApi.list().then((res) => {
      setWorkspaces(res.data.data);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (workspaces.length === 0) {
    return <div>No workspaces connected</div>;
  }

  return (
    <div>
      {workspaces.map((ws) => (
        <div key={ws.id}>
          <span>{ws.name}</span>
          <span>{ws.status}</span>
          <span>{ws._count.runtimes} runtimes</span>
        </div>
      ))}
    </div>
  );
};
