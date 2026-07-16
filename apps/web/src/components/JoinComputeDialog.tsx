import React, { useState } from 'react';
import { workspaceTokenApi } from '../api';

interface JoinComputeDialogProps {
  open: boolean;
  onClose: () => void;
  onGenerated?: (tokenId: string) => void;
}

export const JoinComputeDialog: React.FC<JoinComputeDialogProps> = ({
  open,
  onClose,
  onGenerated,
}) => {
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await workspaceTokenApi.generate(name);
      const data = res.data.data;
      setToken(data.token);
      onGenerated?.(data.id);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div role="dialog">
      <label htmlFor="token-name">Name</label>
      <input
        id="token-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {!token ? (
        <>
          <button onClick={handleGenerate} disabled={loading || !name}>
            Generate
          </button>
          <button onClick={onClose}>Cancel</button>
        </>
      ) : (
        <div>
          <code>studio daemon start --server-url {window.location.origin} --token {token}</code>
        </div>
      )}
    </div>
  );
};
