import React, { useEffect, useState } from 'react';
import { llmConfigApi } from '../api';

interface LlmConfig {
  id: string;
  scope: string;
  provider: string;
  model: string;
  hasKey: boolean;
}

export const LlmConfigDisplay: React.FC = () => {
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    llmConfigApi.list().then((res) => {
      setConfigs(res.data.data);
      setLoading(false);
    });
  }, []);

  if (loading) return <div>Loading...</div>;

  if (configs.length === 0) return <div>No configs</div>;

  return (
    <div>
      {configs.map((cfg) => (
        <div key={cfg.id}>
          <span>{cfg.scope}</span>
          <span>{cfg.provider}</span>
          <span>{cfg.model}</span>
          <span>{cfg.hasKey ? 'Configured' : 'Not configured'}</span>
        </div>
      ))}
    </div>
  );
};
