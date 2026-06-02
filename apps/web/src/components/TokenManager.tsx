import React, { useEffect, useState } from 'react';
import { workspaceTokenApi } from '../api';

interface Token {
  id: string;
  name: string;
  createdAt: string;
}

export const TokenManager: React.FC = () => {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    workspaceTokenApi.list().then((res) => {
      setTokens(res.data.data);
      setLoading(false);
    });
  }, []);

  const handleRevoke = async (id: string) => {
    await workspaceTokenApi.revoke(id);
    setTokens((prev) => prev.filter((t) => t.id !== id));
  };

  if (loading) return <div>Loading...</div>;

  if (tokens.length === 0) return <div>No tokens</div>;

  return (
    <div>
      {tokens.map((token) => (
        <div key={token.id}>
          <span>{token.name}</span>
          <button onClick={() => handleRevoke(token.id)}>Revoke</button>
        </div>
      ))}
    </div>
  );
};
