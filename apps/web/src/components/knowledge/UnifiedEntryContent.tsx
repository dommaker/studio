// #435 B7：统一视图条目内容消化呈现——JSON 结构化键值列表；文本超 200 字符截断 + 展开/收起，
// 不再直出存储层原文（裸 JSON / Monitor 告警流水）。
import { useState } from 'react';
import { digestContent } from '../../utils/knowledgeContent';

const TRUNCATE_AT = 200;

export function UnifiedEntryContent({ content }: { content?: string }) {
  const [expanded, setExpanded] = useState(false);
  const d = digestContent(content);

  if (d.kind === 'json') {
    return (
      <dl className="text-xs mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {d.fields.map(f => (
          <div key={f.key} className="contents">
            <dt className="u-text-3">{f.key}</dt>
            <dd className="u-text break-all">{f.value}</dd>
          </div>
        ))}
      </dl>
    );
  }

  const truncatable = d.text.length > TRUNCATE_AT;
  return (
    <p className="text-xs mb-2 u-text-3 whitespace-pre-wrap">
      {expanded || !truncatable ? d.text : `${d.text.slice(0, TRUNCATE_AT)}...`}
      {truncatable && (
        <button type="button" className="ml-1 u-accent" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </p>
  );
}
