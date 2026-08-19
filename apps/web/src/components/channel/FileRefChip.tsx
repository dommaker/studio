// #285（决策 #249 §5）：agent 消息正文 inline-code 路径 token 染「文件 chip」。
// 点击 = 复制绝对路径 + 短暂「已复制」反馈；例外：.studio/ 前缀 → 解析 PMO 项目跳阅览室，
// 解析不到（无公司/无项目/接口失败）降级回复制，不报错不空跳。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChannelFileVocabulary, FileRef } from '../../api/channel';
import { companyApi } from '../../api/company';
import { projectApi } from '../../api';
import { fileRefFullPath, matchFileRefToken, splitInlineCode } from '../../utils/fileChipMatch';

const LIBRARY_PREFIX = '.studio/';
const COPIED_FEEDBACK_MS = 1500;

/** PMO 项目列表里与 FileRef.repo 比对所需的最小形状（gitRepo 或 deliveries[].gitRepo） */
interface PmoProjectRef {
  id: string;
  gitRepo?: string | null;
  deliveries?: { gitRepo?: string | null }[];
}

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, '');

/** .studio/ 文档 → 阅览室地址；解析不到项目/公司/接口失败返回 null（调用方降级复制） */
async function resolveLibraryUrl(ref: FileRef): Promise<string | null> {
  const relPath = ref.path.slice(LIBRARY_PREFIX.length);
  if (!relPath) return null;
  try {
    const companiesRes = await companyApi.list();
    const companyId = companiesRes.data?.data?.[0]?.id;
    if (!companyId) return null;
    const res = await projectApi.list({ companyId, limit: 100 });
    const projects = (res.data?.data || []) as PmoProjectRef[];
    const repo = stripTrailingSlash(ref.repo);
    const project = projects.find(p =>
      (p.gitRepo && stripTrailingSlash(p.gitRepo) === repo) ||
      (p.deliveries || []).some(d => d.gitRepo && stripTrailingSlash(d.gitRepo) === repo));
    if (!project) return null;
    return `/library/${encodeURIComponent(`${project.id}:${relPath}`)}`;
  } catch {
    return null;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 走 execCommand 降级
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    // 剪贴板不可用时静默（chip 仍展示 tooltip 供手动复制）
  }
}

export function FileRefChip({ token, fileRef }: { token: string; fileRef: FileRef }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const fullPath = fileRefFullPath(fileRef);
  const showCopiedFeedback = () => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  const handleClick = () => {
    if (fileRef.path.startsWith(LIBRARY_PREFIX)) {
      void resolveLibraryUrl(fileRef).then(url => {
        if (url) {
          navigate(url);
        } else {
          void copyText(fullPath);
          showCopiedFeedback();
        }
      });
      return;
    }
    void copyText(fullPath);
    showCopiedFeedback();
  };

  return (
    <button type="button" className="mc-file-chip" title={fullPath} onClick={handleClick}>
      {copied ? '已复制' : token}
    </button>
  );
}

/**
 * agent 消息正文分段渲染：inline-code token 与词表恰好唯一命中 → chip；
 * 未命中/歧义/无词表 → 维持纯文本现状（反引号原样保留）。
 */
export function AgentMessageBody({ content, fileVocabulary }: {
  content: string;
  fileVocabulary?: ChannelFileVocabulary;
}) {
  if (!fileVocabulary) return <>{content}</>;
  const segments = splitInlineCode(content);
  if (!segments.some(s => s.type === 'code')) return <>{content}</>;
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.text}</span>;
        const ref = matchFileRefToken(seg.text, fileVocabulary);
        if (!ref) return <span key={i}>{'`' + seg.text + '`'}</span>;
        return <FileRefChip key={i} token={seg.text.trim()} fileRef={ref} />;
      })}
    </>
  );
}
