import React, { useEffect, useState, useCallback } from 'react';
import { workspaceApi } from '../api';

interface DiscoverEntry {
  path: string;
  type: 'directory' | 'git-repo';
  lastModified: string;
}

interface DirectoryBrowserProps {
  workspaceId: string;
  onSelect?: (path: string) => void;
}

export const DirectoryBrowser: React.FC<DirectoryBrowserProps> = ({
  workspaceId,
  onSelect,
}) => {
  const [entries, setEntries] = useState<DiscoverEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchEntries = useCallback(
    (path: string) => {
      setLoading(true);
      workspaceApi.discover(workspaceId, path).then((res) => {
        setEntries(res.data.data);
        setCurrentPath(path);
        setLoading(false);
      });
    },
    [workspaceId],
  );

  useEffect(() => {
    fetchEntries('');
  }, [fetchEntries]);

  const handleClick = (entry: DiscoverEntry) => {
    fetchEntries(entry.path);
    onSelect?.(entry.path);
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      {currentPath && (
        <div>
          <span>{currentPath}</span>
        </div>
      )}
      {entries.length === 0 ? (
        <div>Empty directory</div>
      ) : (
        entries.map((entry) => (
          <div key={entry.path} onClick={() => handleClick(entry)}>
            <span>{entry.path}</span>
            <span>{entry.type}</span>
          </div>
        ))
      )}
    </div>
  );
};
