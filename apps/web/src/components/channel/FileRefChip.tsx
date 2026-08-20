// #285（决策 #249 §5）：agent 消息正文 inline-code 路径 token 染「文件 chip」。
// 点击 = 复制绝对路径 + 短暂「已复制」反馈；例外：.studio/ 前缀 → 解析 PMO 项目跳阅览室，
// 解析不到（无公司/无项目/接口失败）降级回复制，不报错不空跳。
// #271 起经 MarkdownBody 的 renderInlineCode 挂载点接入（见 ChannelMessageItem）。
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FileRef } from '../../api/channel';
import { companyApi } from '../../api/company';
import { projectApi } from '../../api';
import { fileRefFullPath } from '../../utils/fileChipMatch';
import { copyText } from '../../utils/clipboard';

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
