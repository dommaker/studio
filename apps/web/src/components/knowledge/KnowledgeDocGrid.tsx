// 知识库三列网格（从 pages/ProjectDetailPage.tsx 抽取，工单 35-E4）：列定义数据驱动，卡片点开抽屉阅读器
import type { KnowledgeDoc } from '../../api/knowledge';

interface KnowledgeDocColumn {
  title: string;
  dimClass: string;
  labelClass: string;
  match: (doc: KnowledgeDoc) => boolean;
  meta: (doc: KnowledgeDoc) => string;
}

const COLUMNS: KnowledgeDocColumn[] = [
  {
    title: '📄 需求文档',
    dimClass: 'u-warn-dim',
    labelClass: 'u-warn',
    match: (d) => d.type === 'requirement',
    meta: (d) => `v${d.version}`,
  },
  {
    title: '📐 设计/规范',
    dimClass: 'u-accent-dim',
    labelClass: 'u-accent',
    match: (d) => d.type === 'design' || d.type === 'spec',
    meta: (d) => `${d.type} v${d.version}`,
  },
  {
    title: '📦 执行/归档',
    dimClass: 'u-accent-dim',
    labelClass: 'u-accent',
    match: (d) => ['execution', 'archive'].includes(d.type),
    meta: (d) => d.type,
  },
];

interface KnowledgeDocGridProps {
  documents: KnowledgeDoc[];
  onOpenDoc: (documentId: string) => void;
}

export function KnowledgeDocGrid({ documents, onOpenDoc }: KnowledgeDocGridProps) {
  if (documents.length === 0) {
    return <div className="text-sm u-text-3">暂无文档产出</div>;
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      {COLUMNS.map((col) => (
        <div key={col.title} className={`p-3 rounded ${col.dimClass}`}>
          <div className={`text-xs ${col.labelClass} mb-2`}>{col.title}</div>
          <div className="space-y-1">
            {documents.filter(col.match).map(doc => (
              <div key={doc.id} onClick={() => onOpenDoc(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                <div className="font-medium">{doc.title}</div>
                <div className="text-xs u-text-3">{col.meta(doc)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
