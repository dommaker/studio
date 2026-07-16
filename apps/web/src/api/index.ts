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

// Task API (backend route: /workunits)
export const taskApi = {
  create: (data: any) => api.post('/workunits', data),
  list: (params?: any) => api.get('/workunits', { params }),
  get: (id: string) => api.get(`/workunits/${id}`),
  update: (id: string, data: any) => api.put(`/workunits/${id}`, data),
  cancel: (id: string) => api.post(`/workunits/${id}/cancel`),
};

// Agent API
export const agentApi = {
  list: (params?: { category?: string; page?: number; limit?: number }) =>
    api.get('/agents', { params }),
  get: (id: string, version?: string) =>
    api.get(`/agents/${id}`, { params: { version } }),
  create: (data: any) => api.post('/agents', data),
  update: (id: string, version: string, data: any) =>
    api.put(`/agents/${id}`, data, { params: { version } }),
  delete: (id: string, version: string) =>
    api.delete(`/agents/${id}`, { params: { version } }),
};

// Workflow Runtime API（已迁移到本地模块，Workflow CRUD 已删除）
export const runtimeWorkflowApi = {
  get: (id: string) => api.get(`/workflows/${id}`),
  execute: (workflowId: string, inputs: Record<string, any>, options?: any) =>
    api.post('/executions', { workflowId, parameters: { inputs, ...options } }),
  getStatus: (executionId: string) => api.get(`/executions/${executionId}`),
  listExecutions: (options?: { page?: number; limit?: number }) =>
    api.get('/executions', { params: options }),
  getExecution: (id: string) => api.get(`/executions/${id}`),
  listSteps: () => api.get('/skills'),
  listSkills: () => api.get('/skills'),
  listWorkflows: () => api.get('/workflows'),
  // 配置
  getConfig: () => api.get('/runtime-config'),
  updateConfig: (data: {
    discordWebhook?: string;
    discordEnabled?: boolean;
    agents?: {
      codex: { apiKey: string; endpoint?: string };
      claude: { apiKey: string; endpoint?: string };
    };
    llm?: {
      openai: { apiKey: string; enabled: boolean };
      hunyuan: { apiKey: string; enabled: boolean };
    };
    defaultIntentLLM?: 'openai' | 'hunyuan';
    contextMonitor?: {
      enabled: boolean;
      warningThreshold: number;
      criticalThreshold: number;
    };
  }) => api.post('/runtime-config', data),
  // 项目
  listProjects: () => api.get('/pmo/project'),
  createProject: (data: { name: string; path: string; type?: string; description?: string }) =>
    api.post('/pmo/project', data),
  deleteProject: (id: string) => api.delete(`/pmo/project/${id}`),
};

// Step API - 步骤管理
export const stepApi = {
  list: () => api.get('/steps'),
  get: (id: string, category?: string) => api.get(`/steps/${id}`, { params: { category } }),
  create: (data: {
    name: string;
    description?: string;
    category?: string;
    agent?: 'codex' | 'claude';
    toolIds: string[];
    inputs?: any[];
    outputs?: any[];
    execute?: any;
  }) => api.post('/steps', data),
  update: (id: string, data: {
    name?: string;
    description?: string;
    category?: string;
    agent?: 'codex' | 'claude';
    toolIds?: string[];
    inputs?: any[];
    outputs?: any[];
    execute?: any;
    newCategory?: string;
  }, currentCategory?: string) => api.put(`/steps/${id}`, data, { params: { category: currentCategory } }),
  delete: (id: string, category?: string) => api.delete(`/steps/${id}`, { params: { category } }),
};

// Superpowers API - 铁律、检查点、Meta Skills（通过 agent-studio 代理到 agent-runtime）
export const superpowersApi = {
  // 铁律
  listIronLaws: () => api.get('/iron-laws'),
  getIronLaw: (id: string) => api.get(`/iron-laws/${id}`),
  checkIronLaw: (data: {
    operation: string;
    workflowId?: string;
    stepId?: string;
    taskDescription?: string;
    hasRootCauseInvestigation?: boolean;
    hasVerificationEvidence?: boolean;
    hasTest?: boolean;
    hasFailingTest?: boolean;
  }) => api.post('/iron-laws/check', data),

  // 技能（CSO 优化后）
  listSkills: () => api.get('/skills'),
  
  // Meta Skills
  checkMetaSkills: (data: { message: string; projectDir?: string }) =>
    api.post('/meta-skills/check', data),
  
  // CSO 验证
  validateCSO: () => api.get('/cso/validate'),
};



// Capabilities Stage API（UI-001）
export const capabilitiesStageApi = {
  // 获取 Stage 分类数据
  getStages: () => api.get('/capabilities/stages'),
};

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
  // 创建项目（自动生成 PMO 号）
  create: (data: {
    companyId: string;
    title: string;
    description?: string;
    requirement?: string;
    okrId?: string;
    priority?: string;
    gitBranch?: string;
    gitRepo?: string;
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

  // 发布 PMO 到 Channel
  publish: (id: string, channelId: string) =>
    api.post(`/pmo/project/${id}/publish`, { channelId }),

  // 删除项目
  delete: (id: string) => api.delete(`/pmo/project/${id}`),

  // 解析 CEO 指令中的 PMO 号
  parseCommand: (command: string) =>
    api.post('/pmo/project/parse-command', { command }),

};

// Wiki API (B2-008)
export const wikiApi = {
  list: (params?: { search?: string; status?: string }) =>
    api.get('/wiki', { params }),
  getDoc: (id: string) =>
    api.get(`/wiki/${id}`),
  updateDoc: (id: string, data: { content?: string; title?: string; linkedDocIds?: string[] }) =>
    api.put(`/wiki/${id}`, data),
  getGraph: () =>
    api.get('/wiki/graph'),
};

// Workspace API — AS-020 P2/P7
export const workspaceApi = {
  list: () => api.get('/workspaces'),
  get: (id: string) => api.get(`/workspaces/${id}`),
  discover: (id: string, path: string, timeout?: number) =>
    api.get(`/workspaces/${id}/discover`, { params: { path, timeout } }),
};

// Workspace Token API — AS-020 P2-05/P7-03
export const workspaceTokenApi = {
  generate: (name: string, permissions?: string[]) =>
    api.post('/workspace-tokens', { name, permissions }),
  list: () => api.get('/workspace-tokens'),
  revoke: (id: string) => api.delete(`/workspace-tokens/${id}`),
};

// LLM Config API — AS-020 P9
export const llmConfigApi = {
  list: (scope?: string) => api.get('/llm/configs', { params: { scope } }),
  save: (data: { scope: string; provider: string; model: string; baseUrl?: string }) =>
    api.post('/llm/configs', data),
  delete: (id: string) => api.delete(`/llm/configs/${id}`),
  test: (scope: string) => api.post(`/llm/configs/test`, { scope }),
};
