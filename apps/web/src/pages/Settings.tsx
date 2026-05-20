// 设置页面 - API 配置 + 通知 + 公司 + 主题语言
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, runtimeWorkflowApi } from '../api';
import { useTheme, type Theme } from '../contexts/ThemeContext';
import { changeLanguage, getCurrentLanguage, supportedLanguages } from '../i18n';
import { toast } from '../utils/toast';
import '../styles/theme.css';

interface Config {
  discord: { enabled: boolean; webhookUrl: string };
  wecom: { enabled: boolean; webhookUrl: string };
  telegram: { enabled: boolean; botToken: string; chatId: string };
  contextMonitor: { enabled: boolean; warningThreshold: number; criticalThreshold: number };
  roleExecution: { maxConcurrent: number; tokenWarningThreshold: number; showTokenUsage: boolean };
}

interface MaskedLLMConfig {
  id: string;
  scope: string;
  provider: string;
  baseUrl: string | null;
  apiKeyMasked: string;
  model: string;
  options: Record<string, any> | null;
  isActive: boolean;
}

interface Company { id: string; name: string; size: string; balance: number }

function LanguageSettings() {
  const currentLang = getCurrentLanguage();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {supportedLanguages.map((lang) => (
        <button key={lang.code} onClick={() => changeLanguage(lang.code as 'zh-CN' | 'en-US')}
          className="p-4 rounded-xl text-left transition-all flex items-center gap-3"
          style={{
            background: currentLang === lang.code || currentLang.startsWith(lang.code.split('-')[0]) ? 'var(--bg-elevated)' : 'var(--bg-tertiary)',
            border: currentLang === lang.code || currentLang.startsWith(lang.code.split('-')[0]) ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
          }}>
          <span className="text-2xl">{lang.flag}</span>
          <div>
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{lang.name}</div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{lang.code === 'zh-CN' ? '默认语言' : 'English'}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

const LLM_SCOPES = [
  { value: 'studio', label: 'Studio（全局默认）' },
  { value: 'orchestrator', label: 'Orchestrator（编排器）' },
  { value: 'agent_default', label: 'Agent 默认' },
  { value: 'agent_codex', label: 'Agent Codex' },
  { value: 'agent_claude', label: 'Agent Claude' },
  { value: 'agent_opencode', label: 'Agent OpenCode' },
];

const LLM_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'tencent', label: '腾讯云' },
  { value: 'custom', label: '自定义' },
];

function LLMConfigSection() {
  const [configs, setConfigs] = useState<MaskedLLMConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ key: string; success: boolean; latencyMs: number; error?: string } | null>(null);
  const [form, setForm] = useState({ scope: 'studio', provider: 'openai', baseUrl: '', apiKey: '', model: '' });
  const [saving, setSaving] = useState(false);

  const loadConfigs = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/llm');
      setConfigs(data.data || []);
    } catch (err) {
      console.error('Failed to load LLM configs:', err);
      toast.error('加载 LLM 配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  const handleSave = async () => {
    if (!form.apiKey || !form.model) return;
    setSaving(true);
    try {
      await api.post('/settings/llm', form);
      setForm({ scope: 'studio', provider: 'openai', baseUrl: '', apiKey: '', model: '' });
      setShowAdd(false);
      await loadConfigs();
    } catch (err) {
      console.error('Failed to save LLM config:', err);
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (scope: string) => {
    setTesting(scope);
    setTestResult(null);
    try {
      const { data } = await api.post(`/settings/llm/${scope}/test`);
      setTestResult({ key: scope, ...data });
    } catch (err) {
      setTestResult({ key: scope, success: false, latencyMs: 0, error: String(err) });
    } finally {
      setTesting(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此配置？')) return;
    try {
      await api.delete(`/settings/llm/${id}`);
      await loadConfigs();
    } catch (err) {
      console.error('Failed to delete LLM config:', err);
      toast.error('删除配置失败');
    }
  };

  if (loading) {
    return <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {/* 已保存的配置 */}
      {configs.length > 0 ? (
        <div className="space-y-2">
          {configs.map(c => (
            <div key={c.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--accent-primary)', color: 'white' }}>{c.scope}</span>
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>{c.provider}</span>
                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{c.model}</span>
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  Key: {c.apiKeyMasked} {c.baseUrl && `• ${c.baseUrl}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {testResult?.key === c.scope && (
                  <span className={`text-xs ${testResult.success ? 'text-green-500' : 'text-red-500'}`}>
                    {testResult.success ? `${testResult.latencyMs}ms` : `失败: ${testResult.error?.slice(0, 30)}`}
                  </span>
                )}
                <button onClick={() => handleTest(c.scope)} disabled={testing === c.scope}
                  className="px-2 py-1 text-xs rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                  {testing === c.scope ? '测试中...' : '测试'}
                </button>
                <button onClick={() => handleDelete(c.id)}
                  className="px-2 py-1 text-xs rounded text-red-500" style={{ background: 'var(--bg-elevated)' }}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-4 rounded-lg text-center text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}>
          尚未配置 LLM，添加一个即可使用 AI 功能
        </div>
      )}

      {/* 添加配置 */}
      {showAdd ? (
        <div className="p-4 rounded-xl space-y-3" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Scope</label>
              <select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}
                className="input w-full text-sm">
                {LLM_SCOPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Provider</label>
              <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}
                className="input w-full text-sm">
                {LLM_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>API Key</label>
            <input type="password" placeholder="sk-xxx..." value={form.apiKey}
              onChange={e => setForm({ ...form, apiKey: e.target.value })} className="input w-full text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Model</label>
              <input type="text" placeholder="gpt-4o" value={form.model}
                onChange={e => setForm({ ...form, model: e.target.value })} className="input w-full text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Base URL（可选）</label>
              <input type="text" placeholder="默认" value={form.baseUrl}
                onChange={e => setForm({ ...form, baseUrl: e.target.value })} className="input w-full text-sm" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowAdd(false); setForm({ scope: 'studio', provider: 'openai', baseUrl: '', apiKey: '', model: '' }); }}
              className="btn btn-secondary text-sm">取消</button>
            <button onClick={handleSave} disabled={saving || !form.apiKey || !form.model}
              className="btn btn-primary text-sm">{saving ? '保存中...' : '保存'}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="w-full p-3 rounded-lg text-sm text-center transition" style={{ background: 'var(--bg-tertiary)', border: '1px dashed var(--border-subtle)', color: 'var(--text-secondary)' }}>
          + 添加 LLM 配置
        </button>
      )}
    </div>
  );
}

function ThemeSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const themes: { value: Theme; label: string; icon: string; desc: string }[] = [
    { value: 'dark', label: t('theme.dark'), icon: '🌙', desc: '适合夜间工作，科幻极简风格' },
    { value: 'light', label: t('theme.light'), icon: '☀️', desc: '适合日间工作，明亮清爽' },
    { value: 'system', label: t('theme.system'), icon: '💻', desc: '自动跟随系统主题设置' },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {themes.map((t) => (
        <button key={t.value} onClick={() => setTheme(t.value)}
          className="p-4 rounded-xl text-left transition-all"
          style={{
            background: theme === t.value ? 'var(--bg-elevated)' : 'var(--bg-tertiary)',
            border: theme === t.value ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
            boxShadow: theme === t.value ? 'var(--shadow-glow)' : 'none',
          }}>
          <div className="text-2xl mb-2">{t.icon}</div>
          <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t.label}</div>
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t.desc}</div>
        </button>
      ))}
    </div>
  );
}

export function Settings() {
  const [config, setConfig] = useState<Config>({
    discord: { enabled: false, webhookUrl: '' },
    wecom: { enabled: false, webhookUrl: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    contextMonitor: { enabled: true, warningThreshold: 50, criticalThreshold: 70 },
    roleExecution: { maxConcurrent: 3, tokenWarningThreshold: 15000, showTokenUsage: true },
  });
  const [company, setCompany] = useState<Company | null>(null);
  const [newCompanyName, setNewCompanyName] = useState('');
  const [newCompanyBalance, setNewCompanyBalance] = useState(30000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifySyncStatus, setNotifySyncStatus] = useState<'checking' | 'synced' | 'needs-resave' | 'no-config'>('checking');
  const LOCAL_STORAGE_KEY = 'agent-studio-secrets';

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const localSecrets = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (localSecrets) {
          const secrets = JSON.parse(localSecrets);
          setConfig(prev => ({
            ...prev,
            discord: secrets.discord || prev.discord,
            wecom: secrets.wecom || prev.wecom,
            telegram: secrets.telegram || prev.telegram,
            roleExecution: secrets.roleExecution || prev.roleExecution,
          }));
        }
        const { data } = await runtimeWorkflowApi.getConfig();
        setConfig(prev => ({ ...prev, contextMonitor: data.contextMonitor || prev.contextMonitor }));

        // 检查通知配置同步状态
        try {
          const notifyRes = await api.get('/api/v1/notify/config/status');
          const hasNotifyUserConfig = notifyRes.data.discord.hasUserConfig || notifyRes.data.wecom.hasUserConfig || notifyRes.data.telegram.hasUserConfig;
          if (hasNotifyUserConfig) {
            setNotifySyncStatus('synced');
          } else {
            const localSecrets = localStorage.getItem(LOCAL_STORAGE_KEY);
            if (localSecrets) {
              const secrets = JSON.parse(localSecrets);
              if (secrets.discord?.enabled || secrets.wecom?.enabled || secrets.telegram?.enabled) {
                setNotifySyncStatus('needs-resave');
              } else {
                setNotifySyncStatus('no-config');
              }
            } else {
              setNotifySyncStatus('no-config');
            }
          }
        } catch (e) {
          console.error('Failed to check notify status:', e);
          toast.error('检查通知状态失败');
          setNotifySyncStatus('no-config');
        }

        // 加载公司信息
        const storedCompanyId = localStorage.getItem('companyId');
        if (storedCompanyId) {
          const companyRes = await api.get(`/companies/${storedCompanyId}`).catch(() => null);
          if (companyRes?.data) {
            setCompany(companyRes.data);
            setNewCompanyName(companyRes.data.name);
            setNewCompanyBalance(companyRes.data.balance);
          } else {
            localStorage.removeItem('companyId');
            await fetchOrCreateCompany();
          }
        } else {
          await fetchOrCreateCompany();
        }
      } catch (err) {
        console.error('Failed to load config:', err);
        toast.error('加载配置失败');
      } finally {
        setLoading(false);
      }
    };

    async function fetchOrCreateCompany() {
      const companiesRes = await api.get('/companies');
      if (companiesRes.data?.data?.length > 0) {
        // 已有公司 → 使用第一个
        const firstCompany = companiesRes.data.data[0];
        localStorage.setItem('companyId', firstCompany.id);
        setCompany(firstCompany);
        setNewCompanyName(firstCompany.name);
        setNewCompanyBalance(firstCompany.balance);
      } else {
        // 无公司 → 创建默认公司
        const createRes = await api.post('/companies', { 
          name: '我的工作空间', 
          balance: 30000 
        }).catch(() => null);
        if (createRes?.data?.id) {
          localStorage.setItem('companyId', createRes.data.id);
          setCompany(createRes.data);
          setNewCompanyName(createRes.data.name);
          setNewCompanyBalance(createRes.data.balance);
        }
      }
    }

    loadConfig();
  }, []);

  const saveSecretsToLocal = (secrets: Partial<Config>) => {
    const currentSecrets = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...currentSecrets, ...secrets }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      saveSecretsToLocal({
        discord: config.discord,
        wecom: config.wecom,
        telegram: config.telegram,
        roleExecution: config.roleExecution,
      });

      // 保存 Webhook 配置到进程内存
      await api.post('/api/v1/notify/config', {
        discord: config.discord,
        wecom: config.wecom,
        telegram: config.telegram,
      });
      setNotifySyncStatus('synced');

      // 保存角色执行配置到 Redis
      await api.post('/runtime-config', {
        maxConcurrent: config.roleExecution.maxConcurrent,
        tokenWarningThreshold: config.roleExecution.tokenWarningThreshold,
        showTokenUsage: config.roleExecution.showTokenUsage,
      });

      // 触发 TaskWorker 热更新
      await api.post('/runtime-config/reload');

      await runtimeWorkflowApi.updateConfig({ contextMonitor: config.contextMonitor });
      toast.success('设置已保存');
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = <K extends keyof Config>(key: K, value: Config[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto min-h-full flex items-center justify-center">
        <div className="loading-spinner"></div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto min-h-full overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>⚙️ 设置</h1>
        <p style={{ color: 'var(--text-secondary)' }}>配置 Agent API Keys、Studio LLM 和通知</p>
      </div>

      <div className="space-y-8">
        {/* 🧠 LLM 配置（加密存储） */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>🧠 LLM 配置</h2>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            API Key 加密存储在数据库中（AES-256-GCM），服务重启后自动恢复。支持按 scope 配置不同模型。
          </p>
          <LLMConfigSection />
        </section>

        {/* 🎭 角色执行配置 */}
        <section className="space-y-6">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>🎭 角色执行配置</h2>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>控制会议内角色并行执行的参数</p>
          <div className="space-y-4 p-4 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>并发上限</label>
              <div className="flex items-center gap-4">
                <input type="number" min="1" max="5" value={config.roleExecution.maxConcurrent}
                  onChange={(e) => updateConfig('roleExecution', { ...config.roleExecution, maxConcurrent: parseInt(e.target.value) || 3 })}
                  className="input w-20" />
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>个角色同时执行（推荐 2-3）</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Token 警告阈值</label>
              <div className="flex items-center gap-4">
                <input type="number" min="1000" step="5000" value={config.roleExecution.tokenWarningThreshold}
                  onChange={(e) => updateConfig('roleExecution', { ...config.roleExecution, tokenWarningThreshold: parseInt(e.target.value) || 15000 })}
                  className="input w-24" />
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Token（超出时提醒）</span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>参考：需求分析 ~3000、代码生成 ~10000、复杂任务 ~20000</p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={config.roleExecution.showTokenUsage}
                  onChange={(e) => updateConfig('roleExecution', { ...config.roleExecution, showTokenUsage: e.target.checked })}
                  className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent-primary)' }} />
                <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>执行时显示 Token 消耗</span>
              </label>
            </div>
          </div>
        </section>

        {/* 📢 通知配置同步状态提示 */}
        {notifySyncStatus === 'needs-resave' && (
          <div className="p-3 rounded-lg" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid #f59e0b' }}>
            <div className="flex items-center gap-2">
              <span>⚠️</span>
              <span className="text-sm font-medium" style={{ color: '#f59e0b' }}>通知配置需要重新保存</span>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              服务器配置已丢失（可能已重启），请点击"保存设置"重新同步配置。
            </p>
          </div>
        )}
        {notifySyncStatus === 'synced' && (
          <div className="p-2 rounded-lg" style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid #22c55e' }}>
            <div className="flex items-center gap-2">
              <span>✅</span>
              <span className="text-xs" style={{ color: '#22c55e' }}>通知配置已同步到服务器</span>
            </div>
          </div>
        )}
        
        {/* 📢 Discord */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>📢 Discord 通知</h2>
            <span className={`text-xs px-2 py-1 rounded-full ${config.discord.enabled ? 'status-running' : 'status-pending'}`}>{config.discord.enabled ? '已启用' : '未启用'}</span>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Webhook URL</label>
            <input type="text" placeholder="https://discord.com/api/webhooks/..." value={config.discord.webhookUrl}
              onChange={(e) => updateConfig('discord', { ...config.discord, webhookUrl: e.target.value, enabled: !!e.target.value })}
              className="input w-full" />
          </div>
        </section>

        {/* 💼 企业微信 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>💼 企业微信通知</h2>
            <span className={`text-xs px-2 py-1 rounded-full ${config.wecom.enabled ? 'status-running' : 'status-pending'}`}>{config.wecom.enabled ? '已启用' : '未启用'}</span>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Webhook URL</label>
            <input type="text" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" value={config.wecom.webhookUrl}
              onChange={(e) => updateConfig('wecom', { ...config.wecom, webhookUrl: e.target.value, enabled: !!e.target.value })}
              className="input w-full" />
          </div>
        </section>

        {/* 📱 Telegram */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>📱 Telegram 通知</h2>
            <span className={`text-xs px-2 py-1 rounded-full ${config.telegram.enabled ? 'status-running' : 'status-pending'}`}>{config.telegram.enabled ? '已启用' : '未启用'}</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Bot Token</label>
              <input type="text" placeholder="123456:ABC-DEF..." value={config.telegram.botToken}
                onChange={(e) => updateConfig('telegram', { ...config.telegram, botToken: e.target.value, enabled: !!(e.target.value && config.telegram.chatId) })}
                className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Chat ID</label>
              <input type="text" placeholder="-1001234567890" value={config.telegram.chatId}
                onChange={(e) => updateConfig('telegram', { ...config.telegram, chatId: e.target.value, enabled: !!(config.telegram.botToken && e.target.value) })}
                className="input w-full" />
            </div>
          </div>
        </section>

        {/* 📊 上下文监控 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>📊 上下文监控</h2>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={config.contextMonitor.enabled}
                onChange={(e) => updateConfig('contextMonitor', { ...config.contextMonitor, enabled: e.target.checked })}
                className="w-4 h-4 rounded" style={{ accentColor: 'var(--accent-primary)' }} />
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>启用</span>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>提示阈值 (%)</label>
              <input type="number" min="30" max="90" value={config.contextMonitor.warningThreshold}
                onChange={(e) => updateConfig('contextMonitor', { ...config.contextMonitor, warningThreshold: parseInt(e.target.value) || 50 })}
                className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>警告阈值 (%)</label>
              <input type="number" min="50" max="95" value={config.contextMonitor.criticalThreshold}
                onChange={(e) => updateConfig('contextMonitor', { ...config.contextMonitor, criticalThreshold: parseInt(e.target.value) || 70 })}
                className="input w-full" />
            </div>
          </div>
        </section>

        {/* 🏢 公司信息 */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>🏢 公司信息</h2>
          
          <div className="p-4 rounded-xl space-y-4" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
            {/* 公司名称 */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>公司名称</label>
              <input type="text" value={company?.name || newCompanyName} 
                onChange={(e) => {
                  setNewCompanyName(e.target.value);
                  if (company) {
                    // 自动保存
                    api.patch(`/companies/${company.id}`, { name: e.target.value }).then(() => {
                      setCompany({ ...company!, name: e.target.value });
                    }).catch(err => { console.error('Auto-save failed:', err); toast.error('自动保存失败'); });
                  }
                }}
                placeholder="输入公司名称" className="input w-full" />
            </div>

            {/* Token 余额 */}
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>Token 余额</label>
              <div className="flex items-center gap-2">
                <input type="number" min="0" step="1000"
                  value={company?.balance || newCompanyBalance}
                  onChange={(e) => {
                    const newBalance = parseInt(e.target.value) || 0;
                    setNewCompanyBalance(newBalance);
                    if (company) {
                      // 自动保存
                      api.patch(`/companies/${company.id}`, { balance: newBalance }).then(() => {
                        setCompany({ ...company!, balance: newBalance });
                      }).catch(err => { console.error('Auto-save failed:', err); toast.error('自动保存失败'); });
                    }
                  }}
                  className="input w-full" />
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Token</span>
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>用于 Agent 任务执行的额度，修改后自动保存</p>
            </div>

            {/* 如果没有公司，显示创建提示 */}
            {!company && newCompanyName.trim() && (
              <button onClick={() => {
                api.post('/companies', { name: newCompanyName, balance: newCompanyBalance }).then(res => {
                  if (res.data?.id) {
                    localStorage.setItem('companyId', res.data.id);
                    setCompany(res.data);
                  }
                }).catch(err => toast.error('创建失败: ' + err.message));
              }} className="btn btn-primary text-sm">保存为新公司</button>
            )}
          </div>
        </section>

        {/* 📚 知识库 */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>📚 公司知识库</h2>
          <div className="p-4 rounded-xl" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
            <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>管理公司所有项目的文档资产</p>
            <div className="flex gap-3">
              <button onClick={() => {
                const companyId = localStorage.getItem('companyId') || '';
                window.location.href = `/knowledge?companyId=${companyId}`;
              }} className="px-4 py-2 rounded-lg text-sm" style={{ background: 'var(--accent-primary)', color: 'white' }}>查看知识库 →</button>
              <button onClick={() => { window.location.href = '/knowledge/import'; }}
                className="px-4 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>
                📥 冷启动导入
              </button>
            </div>
          </div>
        </section>

        {/* 🌐 语言（最下面） */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>🌐 语言设置</h2>
          <LanguageSettings />
        </section>

        {/* 🎨 主题（最下面） */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>🎨 主题设置</h2>
          <ThemeSettings />
        </section>

        {/* 保存 */}
        <div className="flex justify-end gap-3 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={() => window.history.back()} className="btn btn-secondary" disabled={saving}>取消</button>
          <button onClick={handleSave} disabled={saving} className="btn btn-primary">{saving ? '保存中...' : '💾 保存设置'}</button>
        </div>
      </div>
    </div>
  );
}

export default Settings;