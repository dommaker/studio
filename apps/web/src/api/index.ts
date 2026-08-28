// API 客户端
import axios from 'axios';

// API 基础 URL（相对路径，由 nginx 反向代理）
const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';
export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// ─── Auth interceptor ───
// Reads localStorage directly (not authStore) to avoid circular dep:
// authStore.ts imports from '../api', so api cannot import authStore.

const AUTH_PATHS = ['/auth/login', '/auth/register', '/auth/guest-session', '/auth/refresh', '/auth/me', '/auth/forgot-password', '/auth/reset-password'];

function isAuthPath(url: string | undefined): boolean {
  if (!url) return false;
  return AUTH_PATHS.some((p) => url.includes(p));
}

function getStoredAuth(): { token: string | null; refreshToken: string | null } {
  try {
    const raw = localStorage.getItem('auth-storage');
    if (!raw) return { token: null, refreshToken: null };
    const parsed = JSON.parse(raw);
    return { token: parsed?.state?.token ?? null, refreshToken: parsed?.state?.refreshToken ?? null };
  } catch {
    return { token: null, refreshToken: null };
  }
}

// Request interceptor: inject Bearer token
api.interceptors.request.use((config) => {
  const { token } = getStoredAuth();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});


interface QueuedRequest {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}

let isRefreshing = false;
let failedQueue: QueuedRequest[] = [];

function flushQueue(error: unknown, token: string | null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error || !token) {
      reject(error);
    } else {
      resolve(token);
    }
  });
  failedQueue = [];
}

/** Refresh access token using a refresh token. Uses standalone axios — no interceptor recursion. */
export async function refreshToken(refreshTokenValue: string): Promise<{ accessToken: string; refreshToken: string }> {
  const { data } = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken: refreshTokenValue });
  return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}

// Response interceptor: catch 401 → refresh → retry
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as (typeof error.config & { _retry?: boolean }) | undefined;

    // Skip if: no response, already retried, or auth path
    if (!error.response || !originalRequest || originalRequest._retry || isAuthPath(originalRequest.url)) {
      return Promise.reject(error);
    }

    if (error.response.status !== 401) {
      return Promise.reject(error);
    }

    // Concurrent 401 handling: queue while refresh is in progress
    if (isRefreshing) {
      return new Promise<string>((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      }).then((newToken) => {
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        originalRequest._retry = true;
        return api.request(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    const { refreshToken: storedRefresh } = getStoredAuth();
    if (!storedRefresh) {
      isRefreshing = false;
      flushQueue(new Error('No refresh token'), null);
      localStorage.removeItem('auth-storage');
      return Promise.reject(error);
    }

    try {
      const { accessToken, refreshToken: newRefresh } = await refreshToken(storedRefresh);

      // Update localStorage
      const raw = localStorage.getItem('auth-storage');
      if (raw) {
        const stored = JSON.parse(raw);
        stored.state.token = accessToken;
        stored.state.refreshToken = newRefresh;
        localStorage.setItem('auth-storage', JSON.stringify(stored));
      }

      // Retry original + flush queue
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      flushQueue(null, accessToken);
      return api.request(originalRequest);
    } catch (refreshError) {
      flushQueue(refreshError, null);
      localStorage.removeItem('auth-storage');
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

// Auth API - 认证系统
export const authApi = {
  createGuestSession: (guestId: string) =>
    api.post('/auth/guest-session', { guestId }),
  checkAuth: () => api.get('/auth/me'),
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (email: string, password: string, name?: string) =>
    api.post('/auth/register', { email, password, name }),
  logout: () => api.post('/auth/logout'),
  fetchMe: () => api.get('/auth/me'),
  /** Returns the OAuth authorization URL for the given provider */
  getOAuthUrl: (provider: 'google' | 'github'): string =>
    `${API_BASE}/auth/${provider}`,
  /** Request password reset email */
  forgotPassword: (email: string) =>
    api.post('/auth/forgot-password', { email }),
  /** Reset password using token from email */
  resetPassword: (token: string, password: string) =>
    api.post('/auth/reset-password', { token, password }),
};


// Project API - GEN-005: PMO 项目管理
export const projectApi = {
  // 创建项目（自动生成 PMO 号；PMO-a: companyId 由服务端解析，前端不再传）
  // #114 T8：gitRepos 多工程入参（每选中工程一条交付腿）；单个工程仍走 gitRepo
  create: (data: {
    title: string;
    description?: string;
    requirement?: string;
    okrId?: string;
    priority?: string;
    gitBranch?: string;
    gitRepo?: string;
    gitRepos?: string[];
    deliveryPolicy?: 'auto-merge' | 'branch-only';
    requirementsDocId?: string;
  }) => api.post('/pmo/project', data),

  // 获取项目列表
  list: (params?: {
    companyId: string;
    status?: string;
    priority?: string;
    okrId?: string;
    limit?: number;
  }) => api.get('/pmo/project', { params }),

  // 获取项目详情
  get: (id: string) => api.get(`/pmo/project/${id}`),

  // 通过 PMO 号获取项目
  getByPmoNumber: (pmoNumber: string, companyId: string) =>
    api.get(`/pmo/project/by-pmo/${pmoNumber}`, { params: { companyId } }),

  // 更新项目
  update: (id: string, data: {
    title?: string;
    description?: string;
    okrId?: string;
    status?: string;
    priority?: string;
    progress?: number;
  }) => api.put(`/pmo/project/${id}`, data),

  // 更新项目状态
  updateStatus: (id: string, status: string) =>
    api.put(`/pmo/project/${id}/status`, { status }),

  // 发布 PMO 到 Channel（#177：可选 assigneeId 指派 analysis WU 执行角色，留空=涌现）
  publish: (id: string, channelId: string, assigneeId?: string) =>
    api.post(`/pmo/project/${id}/publish`, { channelId, ...(assigneeId ? { assigneeId } : {}) }),

  // 删除项目
  delete: (id: string) => api.delete(`/pmo/project/${id}`),

  // 解析 CEO 指令中的 PMO 号
  parseCommand: (command: string) =>
    api.post('/pmo/project/parse-command', { command }),

  // 🆕 PMO-b: 交付台账
  getDelivery: (id: string) => api.get(`/pmo/project/${id}/delivery`),

  // 🆕 PMO-b: 交付合并（human-only；branch-only 返回 409 BRANCH_ONLY）
  deliver: (id: string) => api.post(`/pmo/project/${id}/deliver`),

};

// 🆕 PMO-b: 交付台账（GET /pmo/project/:id/delivery 响应形状）
export interface DeliveryGap {
  id: string;
  title: string;
  type: string;
  missing: Array<'l1' | 'l2' | 'l3'>;
}

export interface DeliveryStatus {
  projectId: string;
  pmoNumber: string;
  branch: string | null;
  policy: 'auto-merge' | 'branch-only';
  gitRepo: string | null;
  wu: {
    total: number;
    finished: number;
    inFlight: number;
    byStatus: { unassigned: number; active: number; inReview: number; blocked: number };
  };
  evidence: {
    l1Missing: string[];
    l2Missing: string[];
    l3Missing: string[];
    selfReviewCount: number;
  };
  deliverable: boolean;
  missing: string[];
  /** 项目 WU 链路 token 总消耗 */
  tokens: number;
  /** 已完成但证据有缺口的 WU 明细 */
  gaps: DeliveryGap[];
  deliveredAt: string | null;
  deliveredBy: string | null;
  deliverCommit: string | null;
}

// Library API (#155 T5: 阅览室——跨项目 .studio/ 聚合只读层；无写路径)
export const libraryApi = {
  list: (params?: { search?: string; project?: string }) =>
    api.get('/library', { params }),
  getDoc: (id: string) =>
    api.get(`/library/${encodeURIComponent(id)}`),
};

// Workspace API — AS-020 P2/P7
export const workspaceApi = {
  list: () => api.get('/workspaces'),
  get: (id: string) => api.get(`/workspaces/${id}`),
};

// Workspace Token API — AS-020 P2-05/P7-03
export const workspaceTokenApi = {
  generate: (name: string, permissions?: string[]) =>
    api.post('/workspace-tokens', { name, permissions }),
  list: () => api.get('/workspace-tokens'),
  revoke: (id: string) => api.delete(`/workspace-tokens/${id}`),
};
