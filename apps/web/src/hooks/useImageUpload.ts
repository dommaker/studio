// useImageUpload（#691 自 ChannelInput 抽出）：2026-09 截图粘贴——图片白名单/5MB 上限
// 客户端先拦一道即时反馈（与后端 attachments.ts 同口径，服务端仍兜底）；上传成功光标处
// 插入 markdown 图片语法（经 insertSnippet 注入，本 hook 不直接碰草稿）；失败 toast 不动草稿；
// uploadingCount 计数支持并发多图占位。
import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { channelApi } from '../api/channel';
import { toast } from '../utils/toast';

/** 图片白名单/上限与后端 attachments.ts 同口径 */
const IMAGE_MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** File → base64（剥 data:URL 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface UseImageUploadOptions {
  channelId?: string;
  /** 光标处插入文本片段（由调用方持有草稿状态） */
  insertSnippet: (snippet: string) => void;
}

export interface ImageUploadController {
  uploadingCount: number;
  fileInputRef: RefObject<HTMLInputElement | null>;
  uploadImage: (file: File) => Promise<void>;
  /** 剪贴板有图 → 拦默认行为走上传；无图 → 文本粘贴走默认 */
  handlePaste: (e: React.ClipboardEvent) => void;
}

export function useImageUpload({ channelId, insertSnippet }: UseImageUploadOptions): ImageUploadController {
  const [uploadingCount, setUploadingCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadImage = useCallback(async (file: File) => {
    if (!channelId) {
      toast.error('缺少频道上下文，无法上传图片');
      return;
    }
    if (!IMAGE_MIME_WHITELIST.includes(file.type)) {
      toast.error('不支持的图片类型（仅 png/jpg/jpeg/gif/webp）');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error('图片超过 5MB 上限');
      return;
    }
    setUploadingCount(n => n + 1);
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await channelApi.uploadAttachment(channelId, { mime: file.type, dataBase64 });
      // alt 文本消毒：]/(/)/换行会破坏 markdown 图片语法
      const alt = (file.name || 'image').replace(/[[\]()\n]/g, '');
      insertSnippet(`![${alt}](${res.data.data.url})`);
    } catch {
      toast.error('图片上传失败，请重试');
    } finally {
      setUploadingCount(n => n - 1);
    }
  }, [channelId, insertSnippet]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'));
    if (!img) return;
    e.preventDefault();
    void uploadImage(img);
  }, [uploadImage]);

  return { uploadingCount, fileInputRef, uploadImage, handlePaste };
}
