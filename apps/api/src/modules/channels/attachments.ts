/**
 * 频道消息图片附件（2026-09，「频道里加上截图」，docs/plans/2026-09-channel-attachments.md）
 *
 * 上传 = JSON base64（不引 multipart/multer 依赖）；落盘数据区
 * `attachments/<channelId>/<uuid>.<ext>`（扩展名白名单）。元数据不入库——
 * id 内嵌扩展名即可推导 mime，消息体 markdown 图片 URL 即完整事实源（YAGNI）。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

/** 单图上限 5MB（解码后字节数） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 该路由单独的 express.json limit（5MB base64 ≈ 6.7MB，留余量）；全局 2mb 不动 */
export const ATTACHMENT_BODY_LIMIT = '8mb';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 防路径穿越：channelId / attachmentId 只放行白名单字符（uuid + 扩展名） */
const CHANNEL_ID_RE = /^[A-Za-z0-9-]+$/;
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

/** 与 FileStore baseDir 同口径（STUDIO_DATA_DIR 优先，缺省 studioPath('data')） */
function attachmentsRoot(): string {
  return path.join(process.env.STUDIO_DATA_DIR ?? studioPath('data'), 'attachments');
}

export interface SavedImage {
  id: string;
  url: string;
  size: number;
}

// 本仓 strictNullChecks 关闭，判别联合不收窄——沿用 validateRouting 等同文件先例的扁平可选字段形态
type Result<T> = { ok: boolean; value?: T; status?: number; error?: string };

/** 保存上传图片：校验 mime 白名单 + 大小上限，写盘后返回相对 URL */
export async function saveChannelImage(
  channelId: string,
  input: { mime?: unknown; dataBase64?: unknown },
): Promise<Result<SavedImage>> {
  if (!CHANNEL_ID_RE.test(channelId)) {
    return { ok: false, status: 400, error: 'invalid channelId' };
  }
  const mime = typeof input.mime === 'string' ? input.mime : '';
  const ext = MIME_TO_EXT[mime];
  if (!ext) {
    return { ok: false, status: 400, error: '不支持的图片类型（仅 png/jpg/jpeg/gif/webp）' };
  }
  if (typeof input.dataBase64 !== 'string' || !input.dataBase64) {
    return { ok: false, status: 400, error: 'dataBase64 is required' };
  }
  // base64 长度即可上界估大小，超限先拒（不解码省内存）
  if (input.dataBase64.length * 3 / 4 > MAX_IMAGE_BYTES + 8) {
    return { ok: false, status: 413, error: '图片超过 5MB 上限' };
  }
  const buf = Buffer.from(input.dataBase64, 'base64');
  if (buf.length === 0) {
    return { ok: false, status: 400, error: 'invalid base64 data' };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: '图片超过 5MB 上限' };
  }

  const id = `${randomUUID()}.${ext}`;
  const dir = path.join(attachmentsRoot(), channelId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, id), buf);
  return {
    ok: true,
    value: { id, url: `/api/v1/channels/${channelId}/attachments/${id}`, size: buf.length },
  };
}

/** 解析取图请求：id 白名单校验（防路径穿越）+ 文件存在性 + mime 推导 */
export async function resolveChannelImage(
  channelId: string,
  attachmentId: string,
): Promise<Result<{ filePath: string; mime: string }>> {
  if (!CHANNEL_ID_RE.test(channelId) || !ATTACHMENT_ID_RE.test(attachmentId)) {
    return { ok: false, status: 400, error: 'invalid attachment id' };
  }
  const ext = attachmentId.split('.').pop()!;
  const filePath = path.join(attachmentsRoot(), channelId, attachmentId);
  if (!fs.existsSync(filePath)) {
    return { ok: false, status: 404, error: 'Attachment not found' };
  }
  return { ok: true, value: { filePath, mime: EXT_TO_MIME[ext] } };
}
