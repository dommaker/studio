// #435 B7：统一视图条目内容消化呈现——JSON 结构化键值列表（字段多默认收起）；文本超 200 字符
// 截断 + 展开/收起，不再直出存储层原文（裸 JSON / Monitor 告警流水）。
import { useState } from 'react';
import { digestContent } from '../../utils/knowledgeContent';

const TRUNCATE_AT = 200;
/** JSON 分支默认展开的最大字段数，超出收起到 展开 钮后（防偏好类大对象撑爆卡片） */
const JSON_FIELDS_VISIBLE = 6;

export function UnifiedEntryContent({ content }: { content?: string }) {
  const [expanded, setExpanded] = useState(false);
  const d = digestContent(content);

  if (d.kind === 'json') {
    const collapsible = d.fields.length > JSON_FIELDS_VISIBLE;
    const visible = expanded || !collapsible ? d.fields : d.fields.slice(0, JSON_FIELDS_VISIBLE);
    return (
      <div className="mb-2">
        <dl className="text-xs grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {visible.map(f => (
            <div key={f.key} className="contents">
              <dt className="u-text-3">{f.key}</dt>
              <dd className="u-text break-all">{f.value}</dd>
            </div>
          ))}
        </dl>
        {collapsible && (
          <button type="button" className="u-btn-reset u-accent text-xs" onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起' : `展开全部 ${d.fields.length} 字段`}
          </button>
        )}
      </div>
    );
  }

  const truncatable = d.text.length > TRUNCATE_AT;
  return (
    <p className="text-xs mb-2 u-text-3 whitespace-pre-wrap">
      {expanded || !truncatable ? d.text : `${d.text.slice(0, TRUNCATE_AT)}...`}
      {truncatable && (
        <button type="button" className="u-btn-reset u-accent ml-1" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </p>
  );
}
