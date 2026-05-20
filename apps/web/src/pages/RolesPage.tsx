// RolesPage.tsx - 角色管理页面
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Role, Capability, Company, CreateRoleInput } from '../types';
import { getApiBase } from '../utils/api';
import { toast } from '../utils/toast';
import { DeleteButton } from '../components/DeleteButton';

// 角色类型配置
const ROLE_TYPES = [
  { id: 'strategy-lead', name: '方案策划', icon: '🧠', desc: '出方案、发散思考' },
  { id: 'reviewer', name: '评审专家', icon: '🔍', desc: '审议挑刺、质疑假设' },
  { id: 'tech-lead', name: '项目负责人', icon: '👤', desc: '汇总决策、派发任务' },
  { id: 'developer', name: '开发工程师', icon: '👨‍💻', desc: '代码实现' },
  { id: 'architect', name: '架构师', icon: '🏗️', desc: '技术方案设计' },
  { id: 'qa', name: '测试工程师', icon: '🧪', desc: '质量保障' },
  { id: 'designer', name: '设计师', icon: '🎨', desc: 'UI/UX 设计、交互优化' },
  { id: 'product-manager', name: '产品经理', icon: '📊', desc: '需求分析、产品规划' },
];

// 角色类型预设能力（按能力类型匹配）
const ROLE_TYPE_PRESETS: Record<string, {
  capabilityTypes: string[];
}> = {
  'strategy-lead': {
    capabilityTypes: ['step', 'workflow'],
  },
  'reviewer': {
    capabilityTypes: ['step', 'tool'],
  },
  'tech-lead': {
    capabilityTypes: ['workflow', 'step'],
  },
  'developer': {
    capabilityTypes: ['tool', 'step'],
  },
  'architect': {
    capabilityTypes: ['step', 'workflow'],
  },
  'qa': {
    capabilityTypes: ['step', 'tool'],
  },
  'designer': {
    capabilityTypes: ['step', 'workflow'],
  },
  'product-manager': {
    capabilityTypes: ['step', 'workflow'],
  },
};

// 状态配置
const STATUS_MAP = {
  active: { label: '在职', color: '#4CAF50' },
  on_leave: { label: '休假', color: '#FF9800' },
  resigned: { label: '离职', color: '#F44336' },
};

export function RolesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [roles, setRoles] = useState<Role[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCapModal, setShowCapModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ type: '', status: '' });

  // 加载数据
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const apiBase = getApiBase();
      const [rolesRes, companiesRes, capsRes] = await Promise.all([
        fetch(`${apiBase}/api/v1/roles`).then(r => r.json()),
        fetch(`${apiBase}/api/v1/companies`).then(r => r.json()),
        fetch(`${apiBase}/api/v1/capabilities`).then(r => r.json()),
      ]);
      // 后端返回 data 字段
      setRoles(rolesRes.data || []);
      setCompanies(companiesRes.data || []);
      setCapabilities(capsRes.data || []);
    } catch (err) {
      console.error('加载失败:', err);
      toast.error('加载角色数据失败');
    }
    setLoading(false);
  };

  // 筛选角色
  const filteredRoles = roles.filter(role => {
    if (filter.type && role.type !== filter.type) return false;
    if (filter.status && role.status !== filter.status) return false;
    return true;
  });

  // 创建角色
  const handleCreateRole = async (data: Partial<Role>) => {
    try {
      const res = await fetch(`${getApiBase()}/api/v1/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        loadData();
        setShowCreateModal(false);
      }
    } catch (err) {
      console.error('创建失败:', err);
      toast.error('创建角色失败');
    }
  };

  // 添加能力
  const handleAddCapability = async (roleId: string, capId: string) => {
    try {
      const res = await fetch(`${getApiBase()}/api/v1/roles/${roleId}/capabilities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilityId: capId }),
      });
      if (res.ok) {
        loadData();
        setShowCapModal(false);
      }
    } catch (err) {
      console.error('添加能力失败:', err);
      toast.error('添加能力失败');
    }
  };

  // 获取角色类型信息
  const getRoleTypeInfo = (type: string) => {
    return ROLE_TYPES.find(t => t.id === type) || { name: type, icon: '👤', desc: '' };
  };

  return (
    <div className="p-6" style={{ maxWidth: '1400px' }}>
      {/* 头部 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            👥 {t('roles.title')}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {t('roles.subtitle', '管理你的 Agent 团队 - 拟人化角色，像开公司一样开发')}
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          style={{
            background: 'var(--accent-primary)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: '0.5rem',
            border: 'none',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500,
            transition: 'all 0.2s',
          }}
        >
          {t('roles.createRole')}
        </button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('roles.stats.total', '总角色数')}</div>
          <div className="text-2xl font-bold mt-1">{roles.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('roles.stats.active', '在职角色')}</div>
          <div className="text-2xl font-bold mt-1" style={{ color: '#4CAF50' }}>
            {roles.filter(r => r.status === 'active').length}
          </div>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-4 mb-4">
        <select
          value={filter.type}
          onChange={(e) => setFilter({ ...filter, type: e.target.value })}
          className="input"
        >
          <option value="">所有类型</option>
          {ROLE_TYPES.map(t => (
            <option key={t.id} value={t.id}>{t.icon} {t.name}</option>
          ))}
        </select>
        <select
          value={filter.status}
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          className="input"
        >
          <option value="">所有状态</option>
          <option value="active">在职</option>
          <option value="on_leave">休假</option>
          <option value="resigned">离职</option>
        </select>
      </div>

      {/* 角色列表 */}
      {loading ? (
        <div className="text-center py-12">{t('common.loading')}</div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filteredRoles.map(role => {
            const typeInfo = getRoleTypeInfo(role.type);
            const statusInfo = STATUS_MAP[role.status as keyof typeof STATUS_MAP];

            return (
              <div
                key={role.id}
                className="card cursor-pointer hover:shadow-lg transition-shadow"
                onClick={() => setSelectedRole(role)}
              >
                <div className="p-4">
                  {/* 头部 */}
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                      style={{ background: 'var(--bg-elevated)', border: '2px solid var(--border-subtle)' }}
                    >
                      {role.avatar || typeInfo.icon}
                    </div>
                    <div className="flex-1">
                      <div className="font-bold" style={{ color: 'var(--text-primary)' }}>
                        {role.name}
                      </div>
                      <div className="text-sm flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                        <span>{typeInfo.name}</span>
                      </div>
                    </div>
                    <div
                      className="px-2 py-1 rounded text-xs"
                      style={{ background: statusInfo.color + '20', color: statusInfo.color }}
                    >
                      {statusInfo.label}
                    </div>
                  </div>

                  {/* 能力数量 */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>能力:</span>
                    <span className="font-bold">
                      {role.roleCapabilities?.length || 0}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 角色详情弹窗 */}
      {selectedRole && !showCapModal && (
        <RoleDetailModal
          role={selectedRole}
          capabilities={capabilities}
          onClose={() => setSelectedRole(null)}
          onAddCapability={() => setShowCapModal(true)}
          onRefresh={loadData}
        />
      )}

      {/* 创建角色弹窗 */}
      {showCreateModal && (
        <CreateRoleModal
          companies={companies}
          capabilities={capabilities}
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateRole}
        />
      )}

      {/* 添加能力弹窗 */}
      {showCapModal && selectedRole && (
        <AddCapabilityModal
          role={selectedRole}
          capabilities={capabilities}
          onClose={() => setShowCapModal(false)}
          onAdd={handleAddCapability}
        />
      )}
    </div>
  );
}

// 角色详情弹窗
function RoleDetailModal({
  role,
  capabilities,
  onClose,
  onAddCapability,
  onRefresh,
}: {
  role: Role;
  capabilities: Capability[];
  onClose: () => void;
  onAddCapability: () => void;
  onRefresh: () => void;
}) {
  const typeInfo = ROLE_TYPES.find(t => t.id === role.type) || { name: role.type, icon: '👤' };
  const roleCaps = capabilities.filter(c =>
    role.roleCapabilities?.some(rc => rc.capabilityId === c.id)
  );

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '800px' }}>
        <div className="modal-header">
          <h2 className="text-xl font-bold">{typeInfo.icon} {role.name}</h2>
          <button onClick={onClose} className="btn btn-ghost">✕</button>
        </div>

        <div className="modal-body">
          {/* 基本信息 */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>角色类型</div>
              <div className="font-bold">{typeInfo.name}</div>
            </div>
            <div>
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>入职时间</div>
              <div>{new Date(role.createdAt).toLocaleDateString()}</div>
            </div>
          </div>

          {/* 能力列表 */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold">
                拥有能力 ({roleCaps.length})
              </div>
              <button onClick={onAddCapability} className="btn btn-ghost text-sm">
                ➕ 添加
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {roleCaps.map(cap => (
                <div
                  key={cap.id}
                  className="p-2 rounded flex items-center gap-2"
                  style={{ background: 'var(--bg-secondary)' }}
                >
                  <span>{cap.type === 'tool' ? '🔧' : cap.type === 'workflow' ? '📋' : '📚'}</span>
                  <span className="text-sm">{cap.name}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {cap.category}
                  </span>
                </div>
              ))}
              {roleCaps.length === 0 && (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  暂无能力
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <DeleteButton
            deleteUrl={`${getApiBase()}/api/v1/roles/${role.id}`}
            resourceType="角色"
            resourceId={role.id}
            resourceName={role.name}
            warningMessage="删除角色将同时解除其所有能力关联"
            variant="button"
            onSuccess={onRefresh}
            onError={(msg) => console.error('删除失败:', msg)}
          >
            删除角色
          </DeleteButton>
          <button onClick={onClose} className="btn btn-ghost">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// 创建角色弹窗
function CreateRoleModal({
  companies,
  capabilities,
  onClose,
  onCreate,
}: {
  companies: Company[];
  capabilities: Capability[];
  onClose: () => void;
  onCreate: (data: CreateRoleInput) => void;
}) {
  const [form, setForm] = useState({
    name: '',
    type: 'developer',
    companyId: '',
    initialCapabilities: [] as string[],
  });

  const preset = ROLE_TYPE_PRESETS[form.type];

  // 根据角色类型筛选推荐能力
  const recommendedCapabilities = preset
    ? capabilities.filter(c => preset.capabilityTypes.includes(c.type))
    : capabilities;

  // 应用预设配置
  const applyPreset = (type: string) => {
    const newPreset = ROLE_TYPE_PRESETS[type];
    if (newPreset) {
      // 筛选推荐能力（最多取前 5 个）
      const recommended = capabilities
        .filter(c => newPreset.capabilityTypes.includes(c.type))
        .slice(0, 5)
        .map(c => c.id);

      setForm({
        ...form,
        type,
        initialCapabilities: recommended,
      });
    } else {
      setForm({ ...form, type });
    }
  };

  const handleSubmit = () => {
    if (!form.name || !form.companyId) {
      toast.warning('请填写名称和公司');
      return;
    }
    onCreate({
      name: form.name,
      type: form.type,
      companyId: form.companyId,
      initialCapabilities: form.initialCapabilities,
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <h2 className="text-xl font-bold">➕ 创建新角色</h2>
          <button onClick={onClose} className="btn btn-ghost">✕</button>
        </div>

        <div className="modal-body">
          <div className="grid gap-4">
            {/* 名称 */}
            <div>
              <label className="text-sm font-bold">角色名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input w-full mt-1"
                placeholder="如: 张三、代码侠..."
              />
            </div>

            {/* 类型 */}
            <div>
              <label className="text-sm font-bold">角色类型</label>
              <select
                value={form.type}
                onChange={(e) => applyPreset(e.target.value)}
                className="input w-full mt-1"
              >
                {ROLE_TYPES.map(t => (
                  <option key={t.id} value={t.id}>{t.icon} {t.name} - {t.desc}</option>
                ))}
              </select>
              {preset && (
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  💡 已自动填充推荐能力
                </div>
              )}
            </div>

            {/* 公司 */}
            <div>
              <label className="text-sm font-bold">所属公司</label>
              <select
                value={form.companyId}
                onChange={(e) => setForm({ ...form, companyId: e.target.value })}
                className="input w-full mt-1"
              >
                <option value="">选择公司</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {companies.length === 0 && (
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  请先创建公司
                </div>
              )}
            </div>

            {/* 初始能力 */}
            <div>
              <label className="text-sm font-bold">
                初始能力 (已选 {form.initialCapabilities.length} 个)
              </label>

              {/* 推荐能力 */}
              {preset && recommendedCapabilities.length > 0 && (
                <div className="mt-2 mb-2">
                  <div className="text-xs font-bold mb-1" style={{ color: 'var(--accent-primary)' }}>
                    ⭐ 推荐能力（{form.type} 类型）
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {recommendedCapabilities.slice(0, 6).map(cap => (
                      <label
                        key={cap.id}
                        className="flex items-center gap-2 p-2 rounded cursor-pointer"
                        style={{
                          background: form.initialCapabilities.includes(cap.id)
                            ? 'var(--accent-primary)30'
                            : 'var(--bg-secondary)',
                          border: form.initialCapabilities.includes(cap.id)
                            ? '1px solid var(--accent-primary)'
                            : '1px solid transparent'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={form.initialCapabilities.includes(cap.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setForm({ ...form, initialCapabilities: [...form.initialCapabilities, cap.id] });
                            } else {
                              setForm({ ...form, initialCapabilities: form.initialCapabilities.filter(id => id !== cap.id) });
                            }
                          }}
                        />
                        <span className="text-sm">{cap.name}</span>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>({cap.type})</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* 其他能力 */}
              <div className="text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>
                其他能力
              </div>
              <div className="grid grid-cols-2 gap-2 max-h-32 overflow-y-auto">
                {capabilities
                  .filter(cap => !recommendedCapabilities.includes(cap) || recommendedCapabilities.length === 0)
                  .map(cap => (
                    <label
                      key={cap.id}
                      className="flex items-center gap-2 p-2 rounded cursor-pointer"
                      style={{ background: form.initialCapabilities.includes(cap.id) ? 'var(--accent-primary)20' : 'var(--bg-secondary)' }}
                    >
                      <input
                        type="checkbox"
                        checked={form.initialCapabilities.includes(cap.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setForm({ ...form, initialCapabilities: [...form.initialCapabilities, cap.id] });
                          } else {
                            setForm({ ...form, initialCapabilities: form.initialCapabilities.filter(id => id !== cap.id) });
                          }
                        }}
                      />
                      <span className="text-sm">{cap.name}</span>
                    </label>
                  ))}
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={handleSubmit} className="btn btn-primary">
            创建角色
          </button>
          <button onClick={onClose} className="btn btn-ghost">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

// 添加能力弹窗
function AddCapabilityModal({
  role,
  capabilities,
  onClose,
  onAdd,
}: {
  role: Role;
  capabilities: Capability[];
  onClose: () => void;
  onAdd: (roleId: string, capId: string) => void;
}) {
  const roleCapIds = role.roleCapabilities?.map(rc => rc.capabilityId) || [];
  const availableCaps = capabilities.filter(c => !roleCapIds.includes(c.id));

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: '500px' }}>
        <div className="modal-header">
          <h2 className="text-xl font-bold">➕ 添加能力</h2>
          <button onClick={onClose} className="btn btn-ghost">✕</button>
        </div>

        <div className="modal-body">
          <div className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
            当前: {roleCapIds.length}
          </div>

          <div className="grid gap-2 max-h-64 overflow-y-auto">
            {availableCaps.map(cap => (
              <button
                key={cap.id}
                onClick={() => onAdd(role.id, cap.id)}
                className="p-3 rounded flex items-center gap-2"
                style={{ background: 'var(--bg-secondary)' }}
              >
                <span>{cap.type === 'tool' ? '🔧' : cap.type === 'workflow' ? '📋' : '📚'}</span>
                <span className="font-bold">{cap.name}</span>
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {cap.category}
                </span>
              </button>
            ))}
            {availableCaps.length === 0 && (
              <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
                无可添加的能力
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn btn-ghost">关闭</button>
        </div>
      </div>
    </div>
  );
}
