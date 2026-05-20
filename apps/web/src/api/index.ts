// API 客户端
import axios from 'axios';

// API 基础 URL（相对路径，由 nginx 反向代理）
const API_BASE = import.meta.env.VITE_API_URL || '/api/v1';
export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// Task API
export const taskApi = {
  create: (data: any) => api.post('/tasks', data),
  list: (params?: any) => api.get('/tasks', { params }),
  get: (id: string) => api.get(`/tasks/${id}`),
  update: (id: string, data: any) => api.put(`/tasks/${id}`, data),
  cancel: (id: string) => api.post(`/tasks/${id}/cancel`),
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
  listTools: () => api.get('/tools-std'),
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

// Execution API
export const executionApi = {
  list: (workflowId?: string) => api.get('/executions', { params: { workflowId } }),
  get: (id: string) => api.get(`/executions/${id}`),
  stats: () => api.get('/executions/stats'),
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
    api.post('/auth/session', { guestId }),
  checkAuth: () => api.get('/auth/check'),
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (email: string, password: string, name?: string) =>
    api.post('/auth/register', { email, password, name }),
  logout: () => api.post('/auth/logout'),
  fetchMe: () => api.get('/auth/me'),
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

// Goal API
export const goalApi = {
  list: (params?: { companyId?: string; status?: string }) =>
    api.get('/goals', { params }),
  get: (id: string) => api.get(`/goals/${id}`),
  stats: (companyId?: string) =>
    api.get('/goals/stats', { params: { companyId } }),
  listExecutions: (goalId: string) =>
    api.get(`/goals/${goalId}/executions`),
  cancelExecution: (goalId: string, executionId: string) =>
    api.post(`/goals/${goalId}/executions/${executionId}/cancel`),
  retryExecution: (goalId: string, executionId: string) =>
    api.post(`/goals/${goalId}/executions/${executionId}/retry`),
};
