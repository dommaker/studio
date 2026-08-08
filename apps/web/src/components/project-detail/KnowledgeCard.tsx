// 知识库卡 — 三列按 type 分组；AC-5：卡片点开抽屉阅读器
import type { KnowledgeDoc } from '../../api/knowledge';

interface Props {
  documents: KnowledgeDoc[];
  setReaderDocId: React.Dispatch<React.SetStateAction<string | null>>;
}

export function KnowledgeCard({ documents, setReaderDocId }: Props) {
  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-3">📚 知识库 ({documents.length})</h3>
      {documents.length === 0 ? (
        <div className="text-sm u-text-3">暂无文档产出</div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {/* requirement */}
          <div className="p-3 rounded u-warn-dim">
            <div className="text-xs u-warn mb-2">📄 需求文档</div>
            <div className="space-y-1">
              {documents.filter(d => d.type === 'requirement').map(doc => (
                <div key={doc.id} onClick={() => setReaderDocId(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                  <div className="font-medium">{doc.title}</div>
                  <div className="text-xs u-text-3">v{doc.version}</div>
                </div>
              ))}
            </div>
          </div>
          {/* design/spec */}
          <div className="p-3 rounded u-accent-dim">
            <div className="text-xs u-accent mb-2">📐 设计/规范</div>
            <div className="space-y-1">
              {documents.filter(d => d.type === 'design' || d.type === 'spec').map(doc => (
                <div key={doc.id} onClick={() => setReaderDocId(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                  <div className="font-medium">{doc.title}</div>
                  <div className="text-xs u-text-3">{doc.type} v{doc.version}</div>
                </div>
              ))}
            </div>
          </div>
          {/* execution/archive */}
          <div className="p-3 rounded u-accent-dim">
            <div className="text-xs u-accent mb-2">📦 执行/归档</div>
            <div className="space-y-1">
              {documents.filter(d => ['execution', 'archive'].includes(d.type)).map(doc => (
                <div key={doc.id} onClick={() => setReaderDocId(doc.id)} className="p-2 u-surface rounded text-sm cursor-pointer u-hover-bg">
                  <div className="font-medium">{doc.title}</div>
                  <div className="text-xs u-text-3">{doc.type}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
