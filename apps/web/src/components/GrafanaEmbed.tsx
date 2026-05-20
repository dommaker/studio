// Grafana iframe 嵌入组件
import { useState, useEffect } from 'react';

interface GrafanaEmbedProps {
  /** Dashboard UID */
  uid: string;
  /** Dashboard 标题 */
  title: string;
  /** 时间范围（默认最近 1 小时） */
  timeRange?: string;
  /** 主题：dark/light */
  theme?: 'dark' | 'light';
  /** 面板 ID（可选，只显示特定面板） */
  panelId?: number;
  /** 高度 */
  height?: string;
  /** 是否显示刷新按钮 */
  showRefresh?: boolean;
}

export function GrafanaEmbed({
  uid,
  title,
  timeRange = 'now-1h',
  theme = 'dark',
  panelId,
  height = '400px',
  showRefresh = true,
}: GrafanaEmbedProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Grafana 地址（从环境变量或默认值）
  const grafanaUrl = import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3000';

  // 构建 iframe URL
  const buildIframeUrl = () => {
    const params = new URLSearchParams({
      from: timeRange,
      to: 'now',
      theme,
      kiosk: '1', // 隐藏侧边栏
    });

    if (panelId) {
      params.set('panelId', String(panelId));
      return `${grafanaUrl}/d-solo/${uid}?${params}`;
    }

    return `${grafanaUrl}/d/${uid}?${params}`;
  };

  const iframeUrl = buildIframeUrl();

  // 刷新 iframe
  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
    setIsLoading(true);
    setError(null);
  };

  // 检查 Grafana 连接
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const response = await fetch(`${grafanaUrl}/api/health`, {
          method: 'GET',
          mode: 'cors',
        });
        if (!response.ok) {
          throw new Error('Grafana not responding');
        }
      } catch (err) {
        setError('无法连接 Grafana 服务，请确保 Grafana 正在运行');
      }
    };

    checkConnection();
  }, [grafanaUrl]);

  return (
    <div className="grafana-embed" style={{ 
      background: 'var(--bg-secondary)', 
      borderRadius: '8px',
      overflow: 'hidden',
      border: '1px solid var(--border-default)',
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 16px',
        background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border-default)',
      }}>
        <h3 style={{
          margin: 0,
          fontSize: '14px',
          fontWeight: 500,
          color: 'var(--text-primary)',
        }}>
          {title}
        </h3>
        
        {showRefresh && (
          <button
            onClick={handleRefresh}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-default)',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span style={{ display: 'inline-block', transition: 'transform 0.3s' }}>
              ↻
            </span>
            刷新
          </button>
        )}
      </div>

      {/* 内容区 */}
      <div style={{ position: 'relative', height }}>
        {/* 加载状态 */}
        {isLoading && !error && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-secondary)',
            zIndex: 10,
          }}>
            <div style={{
              width: '32px',
              height: '32px',
              border: '3px solid var(--border-default)',
              borderTopColor: 'var(--accent-primary)',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
            }} />
            <style>{`
              @keyframes spin {
                to { transform: rotate(360deg); }
              }
            `}</style>
          </div>
        )}

        {/* 错误状态 */}
        {error && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            color: 'var(--text-secondary)',
            padding: '20px',
            textAlign: 'center',
          }}>
            <span style={{ fontSize: '32px' }}>⚠️</span>
            <p style={{ margin: 0, fontSize: '14px' }}>{error}</p>
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>
              请确保 Grafana 服务正在运行，或配置环境变量 VITE_GRAFANA_URL
            </p>
            <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--text-tertiary)', background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '6px' }}>
              <code># 启动 Grafana (Docker)</code><br/>
              <code>docker run -d -p 3000:3000 grafana/grafana</code><br/><br/>
              <code># 或配置 .env</code><br/>
              <code>VITE_GRAFANA_URL=http://your-grafana:3000</code>
            </div>
            <button
              onClick={handleRefresh}
              style={{
                background: 'var(--accent-primary)',
                border: 'none',
                borderRadius: '4px',
                padding: '8px 16px',
                color: '#000',
                fontSize: '14px',
                cursor: 'pointer',
                marginTop: '8px',
              }}
            >
              重试
            </button>
          </div>
        )}

        {/* Grafana iframe */}
        {!error && (
          <iframe
            key={refreshKey}
            src={iframeUrl}
            width="100%"
            height="100%"
            frameBorder="0"
            onLoad={() => setIsLoading(false)}
            onError={() => setError('加载 Dashboard 失败')}
            style={{
              display: isLoading ? 'none' : 'block',
            }}
          />
        )}
      </div>
    </div>
  );
}