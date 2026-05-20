// useCapabilities.ts - 获取 Stage 分类数据
import { useState, useEffect } from 'react';
import { capabilitiesStageApi } from '../api';

export interface StageCategory {
  id: string;
  name: string;
  workflows: Array<{
    name: string;
    type: string;
    category: string;
    description: string;
    path: string;
  }>;
  tools: Array<{
    name: string;
    type: string;
    category: string;
    description: string;
    path: string;
  }>;
}

/**
 * 获取 Stage 分类数据（UI-001）
 */
export function useCapabilities() {
  const [data, setData] = useState<StageCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    capabilitiesStageApi.getStages()
      .then(res => {
        setData(res.data.data || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err);
        setLoading(false);
      });
  }, []);

  return { data, loading, error };
}

/**
 * 获取指定 Stage 的数据
 */
export function useStageCapabilities(stageId: string) {
  const { data: stages, loading, error } = useCapabilities();
  
  const stage = stages?.find(s => s.id === stageId);
  
  return {
    loading,
    error,
    data: stage,
    workflows: stage?.workflows || [],
    tools: stage?.tools || [],
  };
}