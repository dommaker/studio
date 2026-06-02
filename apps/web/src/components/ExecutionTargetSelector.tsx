import React, { useEffect, useState, useCallback } from 'react';
import { workspaceApi } from '../api';

interface Workspace {
  id: string;
  name: string;
  status: string;
}

interface DiscoverEntry {
  path: string;
  type: string;
  lastModified: string;
}

interface ExecutionTargetSelectorProps {
  onSelect?: (target: string) => void;
}

export const ExecutionTargetSelector: React.FC<ExecutionTargetSelectorProps> = ({
  onSelect,
}) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState<Workspace | null>(null);
  const [entries, setEntries] = useState<DiscoverEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    workspaceApi.list().then((res) => {
      setWorkspaces(res.data.data);
      setLoading(false);
    });
  }, []);

  const handleSelectWorkspace = useCallback(
    (ws: Workspace) => {
      setSelectedWs(ws);
      setLoading(true);
      workspaceApi.discover(ws.id, '').then((res) => {
        setEntries(res.data.data);
        setCurrentPath('');
        setLoading(false);
      });
    },
    [],
  );

  const handleSelectEntry = (entry: DiscoverEntry) => {
    const newPath = currentPath ? `${currentPath}/${entry.path}` : entry.path;
    onSelect?.(`${selectedWs?.name}/${newPath}`);
  };

  if (loading && !selectedWs) return <div>Loading...</div>;

  if (!selectedWs) {
    return (
      <div>
        {workspaces.map((ws) => (
          <div key={ws.id} onClick={() => handleSelectWorkspace(ws)}>
            <span>{ws.name}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div>{selectedWs.name}</div>
      {currentPath && <div>{currentPath}</div>}
      {entries.length === 0 ? (
        <div>Empty</div>
      ) : (
        entries.map((entry) => (
          <div key={entry.path} onClick={() => handleSelectEntry(entry)}>
            <span>{entry.path}</span>
            <span>{entry.type}</span>
          </div>
        ))
      )}
    </div>
  );
};
