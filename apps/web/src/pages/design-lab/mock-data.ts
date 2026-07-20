// Design Lab — 视觉方向稿共用 mock 数据（T1 方向稿专用，不接任何真实 API）
// 两个方向共用同一套信息架构：左频道列表 / 中对话流 / 右侧抽屉

export type AgentStatus = 'online' | 'busy' | 'offline';

export interface LabAgent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
}

export interface LabChannel {
  id: string;
  name: string;
  type: 'rnd' | 'decision' | 'system';
  unread: number;
  agentsOnline: number;
  agentsTotal: number;
  lastSnippet: string;
  lastTime: string;
}

export type CardType =
  | 'text'        // 普通消息（人/Agent）
  | 'requirement' // 需求文档卡
  | 'progress'    // WorkUnit 执行中
  | 'need_input'  // NEED_INPUT 待确认（卡片内可直接回复）
  | 'approval'    // 审批卡
  | 'done';       // 完成卡

export type CardStatus = 'active' | 'running' | 'need_input' | 'done' | 'pending';

export interface LabMessage {
  id: string;
  author: string;
  authorKind: 'human' | 'agent' | 'system';
  cardType: CardType;
  status: CardStatus;
  createdAt: string; // ISO
  title?: string;    // 卡片标题
  body: string;
  workUnitId?: string;
  reqId?: string;
  progress?: number;       // progress 卡专用
  knowledgeHits?: number;  // 知识命中标记
  replyToId?: string;      // 回复引用
  waitingForInput?: boolean;
  question?: string;       // need_input 卡的提问
}

export interface LabWorkUnit {
  id: string;
  reqId: string;
  title: string;
  owner: string;
  status: 'running' | 'blocked' | 'pending' | 'done';
  progress: number;
  tokens: { injected: number; total: number };
  knowledge: Array<{ id: string; title: string; tokens: number }>;
  checkpoints: Array<{ label: string; state: 'done' | 'running' | 'todo' }>;
}

export interface LabRequirement {
  id: string;
  title: string;
  status: 'dispatching' | 'in_progress' | 'review' | 'done';
  workUnitIds: string[];
}

export interface LabTokenStat {
  injected: number;   // 注入 tokens（知识/上下文封装）
  total: number;      // 总 tokens
  overheadRatio: number; // 封装开销 vs 直连
  redLine: number;    // 红线（1.2x）
}

export const labAgents: LabAgent[] = [
  { id: 'ag-dispatch', name: 'dispatch', role: '调度', status: 'online' },
  { id: 'ag-architect', name: 'architect', role: '架构', status: 'online' },
  { id: 'ag-coder1', name: 'coder-1', role: '研发', status: 'busy' },
  { id: 'ag-librarian', name: 'librarian', role: '知识库', status: 'online' },
  { id: 'ag-reviewer', name: 'reviewer', role: '评审', status: 'offline' },
];

export const labChannels: LabChannel[] = [
  { id: 'ch-design', name: 'design-视觉方向', type: 'rnd', unread: 0, agentsOnline: 4, agentsTotal: 5, lastSnippet: 'WU-1017 方向稿原型搭建中 45%', lastTime: '10:42' },
  { id: 'ch-rnd', name: 'rnd-主研发', type: 'rnd', unread: 3, agentsOnline: 5, agentsTotal: 6, lastSnippet: '@coder-2 登录重构接口联调完成', lastTime: '10:31' },
  { id: 'ch-decision', name: 'decision-架构决策', type: 'decision', unread: 1, agentsOnline: 2, agentsTotal: 3, lastSnippet: '审批：知识注入策略 v2 待确认', lastTime: '09:58' },
  { id: 'ch-req', name: 'req-登录重构', type: 'rnd', unread: 0, agentsOnline: 3, agentsTotal: 4, lastSnippet: 'REQ-0041 已拆分为 4 个 WorkUnit', lastTime: '昨天' },
  { id: 'ch-ops', name: 'ops-监控告警', type: 'system', unread: 0, agentsOnline: 1, agentsTotal: 1, lastSnippet: 'token 开销周报已生成', lastTime: '昨天' },
];

export const labRequirements: LabRequirement[] = [
  { id: 'REQ-0042', title: '主界面视觉方向稿', status: 'in_progress', workUnitIds: ['WU-1017', 'WU-1018', 'WU-1019'] },
  { id: 'REQ-0041', title: '频道三栏改造', status: 'dispatching', workUnitIds: ['WU-1015', 'WU-1016'] },
  { id: 'REQ-0039', title: '知识注入优化', status: 'review', workUnitIds: ['WU-1012'] },
];

export const labWorkUnits: LabWorkUnit[] = [
  {
    id: 'WU-1017', reqId: 'REQ-0042', title: '方向稿 A/B 原型页搭建', owner: 'coder-1',
    status: 'running', progress: 45,
    tokens: { injected: 12400, total: 48200 },
    knowledge: [
      { id: 'SDD-012', title: '视觉规范 v0.3', tokens: 3200 },
      { id: 'SDD-004', title: '频道领域模型', tokens: 5100 },
      { id: 'KB-077', title: 'Tailwind v4 备忘', tokens: 4100 },
    ],
    checkpoints: [
      { label: '需求解析', state: 'done' },
      { label: '技术侦察', state: 'done' },
      { label: '原型搭建', state: 'running' },
      { label: '自检与交付', state: 'todo' },
    ],
  },
  {
    id: 'WU-1018', reqId: 'REQ-0042', title: '知识确认：视觉规范注入范围', owner: 'librarian',
    status: 'blocked', progress: 60,
    tokens: { injected: 3200, total: 9800 },
    knowledge: [
      { id: 'SDD-012', title: '视觉规范 v0.3', tokens: 3200 },
    ],
    checkpoints: [
      { label: '知识检索', state: 'done' },
      { label: '等待人类确认', state: 'running' },
      { label: '注入上下文', state: 'todo' },
    ],
  },
  {
    id: 'WU-1019', reqId: 'REQ-0042', title: '方向稿评审与选定', owner: 'reviewer',
    status: 'pending', progress: 0,
    tokens: { injected: 0, total: 0 },
    knowledge: [],
    checkpoints: [
      { label: '等待上游交付', state: 'running' },
      { label: '评审', state: 'todo' },
    ],
  },
  {
    id: 'WU-1015', reqId: 'REQ-0041', title: 'REQ chips 条落地', owner: 'coder-1',
    status: 'done', progress: 100,
    tokens: { injected: 8600, total: 31000 },
    knowledge: [{ id: 'SDD-004', title: '频道领域模型', tokens: 5100 }],
    checkpoints: [
      { label: '需求解析', state: 'done' },
      { label: '实现', state: 'done' },
      { label: '自检', state: 'done' },
    ],
  },
  {
    id: 'WU-1012', reqId: 'REQ-0039', title: '知识注入去重策略', owner: 'librarian',
    status: 'done', progress: 100,
    tokens: { injected: 15800, total: 52400 },
    knowledge: [{ id: 'KB-051', title: '注入策略 RFC', tokens: 6600 }],
    checkpoints: [
      { label: '需求解析', state: 'done' },
      { label: '实现', state: 'done' },
      { label: '自检', state: 'done' },
    ],
  },
];

// 对话流：覆盖 人发需求 / 进度卡 / NEED_INPUT / 完成卡 / 审批卡 / 知识命中 / 线程回复 / 日期分隔
export const labMessages: LabMessage[] = [
  {
    id: 'm-01', author: '张弛', authorKind: 'human', cardType: 'text', status: 'active',
    createdAt: '2026-07-18T15:02:00', reqId: 'REQ-0041',
    body: '@dispatch REQ-0041《频道三栏改造》需求文档已确认，拆一下任务，优先把 REQ chips 条做了。',
  },
  {
    id: 'm-02', author: 'dispatch', authorKind: 'agent', cardType: 'requirement', status: 'done',
    createdAt: '2026-07-18T15:03:12', reqId: 'REQ-0041',
    title: '需求文档 · REQ-0041《频道三栏改造》',
    body: '已解析并拆分为 4 个 WorkUnit：REQ chips 条、线程分组、已完成折叠、右抽屉详情。',
  },
  {
    id: 'm-03', author: 'coder-1', authorKind: 'agent', cardType: 'done', status: 'done',
    createdAt: '2026-07-18T16:20:41', workUnitId: 'WU-1015', reqId: 'REQ-0041',
    title: 'WU-1015 REQ chips 条落地',
    body: 'chips 点击可开 RequirementChainPanel；已补 smoke test。',
  },
  {
    id: 'm-04', author: 'librarian', authorKind: 'agent', cardType: 'done', status: 'done',
    createdAt: '2026-07-18T17:48:05', workUnitId: 'WU-1012', reqId: 'REQ-0039',
    title: 'WU-1012 知识注入去重策略',
    body: '同一会话内重复命中的 SDD 只注入一次，token 开销下降 18%。',
  },
  {
    id: 'm-05', author: 'reviewer', authorKind: 'agent', cardType: 'approval', status: 'pending',
    createdAt: '2026-07-18T18:12:30', reqId: 'REQ-0039',
    title: '发布审批 · REQ-0039 知识注入优化',
    body: '策略已在 3 个频道灰度一周，开销比 1.18x，低于 1.2x 红线。申请全量发布。',
  },
  {
    id: 'm-06', author: '张弛', authorKind: 'human', cardType: 'text', status: 'active',
    createdAt: '2026-07-19T09:12:00', reqId: 'REQ-0042',
    body: '@architect 主界面视觉方向先出两版方向稿，我选定之后再正式实施，不要动现有页面。',
  },
  {
    id: 'm-07', author: 'coder-1', authorKind: 'agent', cardType: 'progress', status: 'running',
    createdAt: '2026-07-19T09:15:22', workUnitId: 'WU-1017', reqId: 'REQ-0042',
    title: 'WU-1017 方向稿 A/B 原型页搭建',
    body: '三栏骨架与 mock 数据就绪，正在铺 A/B 两套视觉 token。',
    progress: 45, knowledgeHits: 3,
  },
  {
    id: 'm-08', author: 'coder-1', authorKind: 'agent', cardType: 'text', status: 'active',
    createdAt: '2026-07-19T09:40:10', replyToId: 'm-07',
    body: '技术侦察完成：主题变量在 styles/theme.css，双方向各自定义 token，互不污染。',
  },
  {
    id: 'm-09', author: 'coder-1', authorKind: 'agent', cardType: 'text', status: 'active',
    createdAt: '2026-07-19T10:05:33', replyToId: 'm-07',
    body: 'A 方向定调 Mission Control：近纯黑 + 全等宽 + 磷光青；B 方向深夜编辑部：暖灰 + 衬线标题 + 暖金。',
  },
  {
    id: 'm-10', author: 'librarian', authorKind: 'agent', cardType: 'need_input', status: 'need_input',
    createdAt: '2026-07-19T10:20:18', workUnitId: 'WU-1018', reqId: 'REQ-0042',
    title: 'WU-1018 知识确认',
    body: '检索到 3 条相关知识，其中《视觉规范 v0.3》与本次方向稿强相关。',
    question: '是否将 SDD-012《视觉规范 v0.3》全文（3.2k tokens）注入 WU-1017 上下文？',
    waitingForInput: true, knowledgeHits: 3,
  },
  {
    id: 'm-11', author: 'architect', authorKind: 'agent', cardType: 'text', status: 'active',
    createdAt: '2026-07-19T10:35:47', replyToId: 'm-06',
    body: '收到。按架构宪法执行：对话流为绝对中心，不堆 dashboard；两版共用一套信息架构，只在视觉语言上分化。',
  },
];

// token 开销对比（注入 vs 总量；封装开销 vs 直连红线）
export const labTokenStat: LabTokenStat = {
  injected: 12400,
  total: 48200,
  overheadRatio: 1.18,
  redLine: 1.2,
};

export function findWorkUnit(id: string): LabWorkUnit | undefined {
  return labWorkUnits.find((w) => w.id === id);
}

export function findRequirement(id: string): LabRequirement | undefined {
  return labRequirements.find((r) => r.id === id);
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
