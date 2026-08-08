// 设置页面 - API 配置 + 通知 + 公司 + 主题语言
// 工单 35-E3（2026-08-07）：8 个 section 组件化抽至 components/settings/，本页只留加载/保存链路与组合
import { useState, useEffect } from 'react';
import { companyApi } from '../api/company';
import { notifyApi } from '../api/notify';
import { ComputeSection } from '../components/settings/ComputeSection';
import { NotifySyncStatusHint, type NotifySyncStatus } from '../components/settings/NotifySyncStatusHint';
import { NotifyChannelSection } from '../components/settings/NotifyChannelSection';
import { CompanySection, type Company } from '../components/settings/CompanySection';
import { KnowledgeEntrySection } from '../components/settings/KnowledgeEntrySection';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { toast } from '../utils/toast';
import '../styles/theme.css';

interface Config {
  discord: { enabled: boolean; webhookUrl: string };
  wecom: { enabled: boolean; webhookUrl: string };
  telegram: { enabled: boolean; botToken: string; chatId: string };
}

export function Settings() {
  const [config, setConfig] = useState<Config>({
    discord: { enabled: false, webhookUrl: '' },
    wecom: { enabled: false, webhookUrl: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
  });
  const [company, setCompany] = useState<Company | null>(null);
  const [newCompanyName, setNewCompanyName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifySyncStatus, setNotifySyncStatus] = useState<NotifySyncStatus>('checking');
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
          }));
        }

        // 检查通知配置同步状态
        try {
          const notifyRes = await notifyApi.getConfigStatus();
          const hasNotifyUserConfig = notifyRes.data?.discord?.hasUserConfig || notifyRes.data?.wecom?.hasUserConfig || notifyRes.data?.telegram?.hasUserConfig;
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
          const companyRes = await companyApi.get(storedCompanyId).catch(() => null);
          if (companyRes?.data) {
            setCompany(companyRes.data);
            setNewCompanyName(companyRes.data.name);
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
      const companiesRes = await companyApi.list();
      if (companiesRes.data?.data?.length > 0) {
        // 已有公司 → 使用第一个
        const firstCompany = companiesRes.data.data[0];
        localStorage.setItem('companyId', firstCompany.id);
        setCompany(firstCompany);
        setNewCompanyName(firstCompany.name);
      } else {
        // 无公司 → 创建默认公司
        const createRes = await companyApi.create({
          name: '我的工作空间',
        }).catch(() => null);
        if (createRes?.data?.id) {
          localStorage.setItem('companyId', createRes.data.id);
          setCompany(createRes.data);
          setNewCompanyName(createRes.data.name);
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
      });

      // 保存 Webhook 配置到服务端（落盘持久化，重启不丢）
      await notifyApi.saveConfig({
        discord: config.discord,
        wecom: config.wecom,
        telegram: config.telegram,
      });
      setNotifySyncStatus('synced');

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
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <div className="loading-spinner"></div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <h1 className="page-title">⚙️ 设置</h1>
        <p className="page-subtitle">配置通知、算力接入与偏好</p>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl space-y-8 mt-4">
          {/* 🖥️ 算力接入 — AS-020 P7 */}
          <ComputeSection />

          {/* 📢 通知配置同步状态提示 */}
          <NotifySyncStatusHint status={notifySyncStatus} />

          {/* 📢 Discord */}
          <NotifyChannelSection
            title="📢 Discord 通知"
            enabled={config.discord.enabled}
            fields={[
              { label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/...', value: config.discord.webhookUrl,
                onChange: (v) => updateConfig('discord', { ...config.discord, webhookUrl: v, enabled: !!v }) },
            ]}
          />

          {/* 💼 企业微信 */}
          <NotifyChannelSection
            title="💼 企业微信通知"
            enabled={config.wecom.enabled}
            fields={[
              { label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', value: config.wecom.webhookUrl,
                onChange: (v) => updateConfig('wecom', { ...config.wecom, webhookUrl: v, enabled: !!v }) },
            ]}
          />

          {/* 📱 Telegram */}
          <NotifyChannelSection
            title="📱 Telegram 通知"
            enabled={config.telegram.enabled}
            fields={[
              { label: 'Bot Token', placeholder: '123456:ABC-DEF...', value: config.telegram.botToken,
                onChange: (v) => updateConfig('telegram', { ...config.telegram, botToken: v, enabled: !!(v && config.telegram.chatId) }) },
              { label: 'Chat ID', placeholder: '-1001234567890', value: config.telegram.chatId,
                onChange: (v) => updateConfig('telegram', { ...config.telegram, chatId: v, enabled: !!(config.telegram.botToken && v) }) },
            ]}
          />

          {/* 🏢 公司信息 */}
          <CompanySection
            company={company}
            newCompanyName={newCompanyName}
            setCompany={setCompany}
            setNewCompanyName={setNewCompanyName}
          />

          {/* 📚 知识库 */}
          <KnowledgeEntrySection />

          {/* 🎨 主题（最下面） */}
          <section className="space-y-4">
            <h2 className="mc-block-label" style={{ margin: 0 }}>🎨 主题设置</h2>
            <ThemeSettings />
          </section>

          {/* 保存 */}
          <div className="flex justify-end gap-3 pt-4 border-t u-border">
            <button onClick={() => window.history.back()} className="btn btn-secondary" disabled={saving}>取消</button>
            <button onClick={handleSave} disabled={saving} className="btn btn-primary">{saving ? '保存中...' : '💾 保存设置'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
