// NodeConfigPanel - 节点配置面板（深色主题）
import { useState, useEffect } from 'react';
import { useAgentStore } from '../stores';
import type { AgentMetadata, JSONSchema } from '../types';

interface NodeConfigPanelProps {
  selectedNodeId: string | null;
  nodeConfig: Record<string, any>;
  onUpdateConfig: (config: Record<string, any>) => void;
  onClose: () => void;
}

export function NodeConfigPanel({
  selectedNodeId,
  nodeConfig,
  onUpdateConfig,
  onClose,
}: NodeConfigPanelProps) {
  const { agents } = useAgentStore();
  const [config, setConfig] = useState<Record<string, any>>({});
  const [agent, setAgent] = useState<AgentMetadata | null>(null);
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic');

  // 当选中节点变化时，加载配置
  useEffect(() => {
    if (selectedNodeId && nodeConfig) {
      setConfig(nodeConfig);
      // 查找对应的 Agent
      const found = agents.find((a) => a.id === nodeConfig.agentType);
      setAgent(found || null);
    } else {
      setConfig({});
      setAgent(null);
    }
  }, [selectedNodeId, nodeConfig, agents]);

  // 更新配置
  const handleChange = (key: string, value: any) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    onUpdateConfig(newConfig);
  };

  if (!selectedNodeId) {
    return (
      <div className="w-80 border-l flex items-center justify-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}>
        <div className="text-center">
          <div className="text-4xl mb-2">⚙️</div>
          <div>选择节点进行配置</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-80 border-l flex flex-col" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
      {/* Header */}
      <div className="h-12 border-b flex items-center justify-between px-3" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>节点配置</span>
        <button
          onClick={onClose}
          className="hover:opacity-70"
          style={{ color: 'var(--text-tertiary)' }}
        >
          ✕
        </button>
      </div>

      {/* 基本信息 */}
      <div className="p-3 border-b" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
          {config.name || selectedNodeId}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Agent: {agent?.name || config.agentType || '未知'}
        </div>
      </div>

      {/* 标签页 */}
      <div className="flex border-b" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <button
          className={`flex-1 py-2 text-sm transition-colors ${
            activeTab === 'basic'
              ? 'border-b-2'
              : 'hover:opacity-80'
          }`}
          style={{
            color: activeTab === 'basic' ? 'var(--accent-primary)' : 'var(--text-secondary)',
            borderColor: activeTab === 'basic' ? 'var(--accent-primary)' : 'transparent'
          }}
          onClick={() => setActiveTab('basic')}
        >
          基本配置
        </button>
        <button
          className={`flex-1 py-2 text-sm transition-colors ${
            activeTab === 'advanced'
              ? 'border-b-2'
              : 'hover:opacity-80'
          }`}
          style={{
            color: activeTab === 'advanced' ? 'var(--accent-primary)' : 'var(--text-secondary)',
            borderColor: activeTab === 'advanced' ? 'var(--accent-primary)' : 'transparent'
          }}
          onClick={() => setActiveTab('advanced')}
        >
          高级配置
        </button>
      </div>

      {/* 配置表单 */}
      <div className="flex-1 overflow-auto p-3">
        {activeTab === 'basic' ? (
          <BasicConfig
            agent={agent}
            config={config}
            onChange={handleChange}
          />
        ) : (
          <AdvancedConfig
            config={config}
            onChange={handleChange}
          />
        )}
      </div>

      {/* 底部操作 */}
      <div className="p-3 border-t" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <button
          className="w-full py-2 rounded text-sm btn btn-primary"
          onClick={() => onUpdateConfig(config)}
        >
          应用配置
        </button>
      </div>
    </div>
  );
}

// 基本配置表单
function BasicConfig({
  agent,
  config,
  onChange,
}: {
  agent: AgentMetadata | null;
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
}) {
  // 从 Agent 的 inputSchema 生成表单
  const schema = agent?.inputSchema;

  if (!schema || !schema.properties) {
    return (
      <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        该 Agent 没有可配置的参数
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {Object.entries(schema.properties).map(([key, prop]) => (
        <SchemaField
          key={key}
          name={key}
          schema={prop as JSONSchema}
          value={config[key]}
          required={schema.required?.includes(key)}
          onChange={(value) => onChange(key, value)}
        />
      ))}
    </div>
  );
}

// 高级配置表单
function AdvancedConfig({
  config,
  onChange,
}: {
  config: Record<string, any>;
  onChange: (key: string, value: any) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          超时时间（秒）
        </label>
        <input
          type="number"
          value={config.timeout || 300}
          onChange={(e) => onChange('timeout', parseInt(e.target.value))}
          className="input w-full"
          min={30}
          max={3600}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          重试次数
        </label>
        <input
          type="number"
          value={config.retries || 0}
          onChange={(e) => onChange('retries', parseInt(e.target.value))}
          className="input w-full"
          min={0}
          max={5}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          条件执行
        </label>
        <input
          type="text"
          value={config.condition || ''}
          onChange={(e) => onChange('condition', e.target.value)}
          placeholder="例如: ${steps.step1.status} === 'succeeded'"
          className="input w-full"
        />
        <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
          使用表达式控制是否执行此节点
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          环境变量
        </label>
        <textarea
          value={config.envVars || ''}
          onChange={(e) => onChange('envVars', e.target.value)}
          placeholder="KEY=value&#10;KEY2=value2"
          className="input w-full font-mono"
          rows={3}
        />
      </div>
    </div>
  );
}

// Schema 字段渲染
function SchemaField({
  name,
  schema,
  value,
  required,
  onChange,
}: {
  name: string;
  schema: JSONSchema;
  value: any;
  required?: boolean;
  onChange: (value: any) => void;
}) {
  const type = schema.type || 'string';
  const label = schema.title || name;
  const description = schema.description;

  // 根据类型渲染不同的输入控件
  const renderInput = () => {
    switch (type) {
      case 'string':
        if (schema.enum) {
          // 枚举类型 → 下拉框
          return (
            <select
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              className="input w-full"
            >
              <option value="">请选择...</option>
              {schema.enum.map((option: any) => (
                <option key={String(option)} value={String(option)}>
                  {String(option)}
                </option>
              ))}
            </select>
          );
        }
        if (schema.format === 'textarea' || (schema.maxLength || 0) > 100) {
          // 长文本 → 文本框
          return (
            <textarea
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder={schema.default as string}
              className="input w-full"
              rows={3}
            />
          );
        }
        // 普通字符串
        return (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={schema.default as string}
            className="input w-full"
          />
        );

      case 'number':
      case 'integer':
        return (
          <input
            type="number"
            value={value || schema.default || 0}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            min={schema.minimum}
            max={schema.maximum}
            className="input w-full"
          />
        );

      case 'boolean':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value ?? schema.default ?? false}
              onChange={(e) => onChange(e.target.checked)}
              className="rounded"
              style={{ accentColor: 'var(--accent-primary)' }}
            />
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {schema.description || '启用'}
            </span>
          </label>
        );

      case 'array':
        return (
          <div>
            <textarea
              value={Array.isArray(value) ? value.join('\n') : ''}
              onChange={(e) => onChange(e.target.value.split('\n').filter(Boolean))}
              placeholder="每行一个值"
              className="input w-full font-mono"
              rows={3}
            />
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>每行输入一个值</p>
          </div>
        );

      case 'object':
        return (
          <textarea
            value={typeof value === 'object' ? JSON.stringify(value, null, 2) : ''}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                // 保持当前值
              }
            }}
            placeholder='{"key": "value"}'
            className="input w-full font-mono"
            rows={4}
          />
        );

      default:
        return (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="input w-full"
          />
        );
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
        {required && <span className="ml-1" style={{ color: 'var(--error)' }}>*</span>}
      </label>
      {renderInput()}
      {description && type !== 'boolean' && (
        <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{description}</p>
      )}
    </div>
  );
}
