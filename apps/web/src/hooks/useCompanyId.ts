// useCompanyId - 统一获取公司 ID
import { useState, useEffect } from 'react';
import { companyApi } from '../api/company';

const LOCAL_STORAGE_KEY = 'companyId';

export function useCompanyId() {
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadCompanyId() {
      try {
        setLoading(true);

        // 1. 先从 localStorage 获取
        const storedId = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (storedId) {
          setCompanyId(storedId);
          return;
        }

        // 2. 从 API 获取默认公司
        const res = await companyApi.list();
        if (res.data?.data?.length > 0) {
          const id = res.data.data[0].id;
          localStorage.setItem(LOCAL_STORAGE_KEY, id);
          setCompanyId(id);
        }
      } catch (err) {
        console.error('Failed to load companyId:', err);
      } finally {
        setLoading(false);
      }
    }

    loadCompanyId();
  }, []);

  return { companyId, loading, setCompanyId };
}

// 辅助函数：直接获取（同步场景）
export function getCompanyId(): string {
  return localStorage.getItem(LOCAL_STORAGE_KEY) || '';
}

// 辅助函数：设置
export function setCompanyId(id: string) {
  localStorage.setItem(LOCAL_STORAGE_KEY, id);
}